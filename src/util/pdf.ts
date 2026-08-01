import { inflateSync } from 'node:zlib';

/**
 * A small structural reader for PDFs, enough to assert that an extension produced the document
 * it was supposed to.
 *
 * This is deliberately not a full parser. Extension-generated PDFs come from jsPDF, pdf-lib or
 * the print pipeline, all of which emit a plain cross-reference table rather than the compressed
 * object streams that make PDF parsing genuinely hard. Everything here degrades to `undefined`
 * rather than throwing, so an assertion reports "could not determine page count" instead of a
 * stack trace.
 */

export interface PdfInfo {
  /** False when the file does not start with %PDF-. */
  valid: boolean;
  version?: string;
  bytes: number;
  pages?: number;
  /** Page size in PostScript points, from the first MediaBox found. 72pt = 1 inch. */
  width?: number;
  height?: number;
  producer?: string;
  creator?: string;
  /** True when the document draws bitmap images — a rasterised capture rather than live text. */
  hasImages: boolean;
  /** Text recovered from uncompressed and Flate-compressed content streams. */
  text: string;
  /** True when the trailer is present, i.e. the file was written completely. */
  complete: boolean;
}

export function inspectPdf(buffer: Buffer): PdfInfo {
  const head = buffer.subarray(0, 1024).toString('latin1');
  const valid = head.startsWith('%PDF-');
  const version = valid ? /^%PDF-(\d+\.\d+)/.exec(head)?.[1] : undefined;

  // latin1 keeps every byte addressable as one character, so offsets stay meaningful even
  // though binary streams are not valid text.
  const raw = buffer.toString('latin1');

  return {
    valid,
    version,
    bytes: buffer.length,
    pages: countPages(raw),
    ...firstMediaBox(raw),
    producer: infoField(raw, 'Producer'),
    creator: infoField(raw, 'Creator'),
    hasImages: /\/Subtype\s*\/Image/.test(raw),
    text: extractText(buffer, raw),
    complete: raw.trimEnd().endsWith('%%EOF'),
  };
}

/**
 * Prefer the page tree's own `/Count`; fall back to counting page objects. `/Type /Pages` must
 * not be mistaken for `/Type /Page`, hence the trailing boundary.
 */
function countPages(raw: string): number | undefined {
  const counts = [...raw.matchAll(/\/Type\s*\/Pages\b[^]{0,400}?\/Count\s+(\d+)/g)].map((m) => Number(m[1]));
  const alt = [...raw.matchAll(/\/Count\s+(\d+)[^]{0,400}?\/Type\s*\/Pages\b/g)].map((m) => Number(m[1]));
  const declared = [...counts, ...alt].filter((n) => Number.isFinite(n) && n > 0);
  if (declared.length) return Math.max(...declared);

  const objects = raw.match(/\/Type\s*\/Page(?![sA-Za-z])/g)?.length;
  return objects && objects > 0 ? objects : undefined;
}

function firstMediaBox(raw: string): { width?: number; height?: number } {
  const match = /\/MediaBox\s*\[\s*([\d.+-]+)\s+([\d.+-]+)\s+([\d.+-]+)\s+([\d.+-]+)\s*\]/.exec(raw);
  if (!match) return {};
  const [x0, y0, x1, y1] = match.slice(1, 5).map(Number) as [number, number, number, number];
  const width = Math.abs(x1 - x0);
  const height = Math.abs(y1 - y0);
  return Number.isFinite(width) && Number.isFinite(height) ? { width, height } : {};
}

function infoField(raw: string, key: string): string | undefined {
  const match = new RegExp(`/${key}\\s*\\(([^)]*)\\)`).exec(raw);
  return match?.[1] ? decodePdfString(match[1]) : undefined;
}

/**
 * Pull readable text out of content streams.
 *
 * Returns an empty string for a rasterised PDF — one built by drawing a screenshot — which is
 * itself a useful signal, and the reason `assertPdf`'s `containsText` says so explicitly when it
 * finds nothing but the document does contain images.
 */
function extractText(buffer: Buffer, raw: string): string {
  const chunks: string[] = [];
  // Match each indirect object's dictionary and the stream that follows it, so the dictionary
  // can be inspected before deciding whether the bytes are text at all.
  const objectPattern = /\d+\s+\d+\s+obj\b([^]*?)stream\r?\n/g;
  let match: RegExpExecArray | null;

  while ((match = objectPattern.exec(raw)) !== null) {
    const dictionary = match[1] ?? '';
    // An image XObject inflates to pixel data. Parenthesised runs inside it are bytes, not
    // words, and reading them as text is how a `containsText` assertion ends up matching noise.
    if (/\/Subtype\s*\/Image/.test(dictionary)) continue;
    if (/\/Type\s*\/(Font|FontDescriptor|Metadata)\b/.test(dictionary)) continue;

    const start = match.index + match[0].length;
    const end = raw.indexOf('endstream', start);
    if (end < 0) continue;
    const slice = buffer.subarray(start, end);

    let content: string | undefined;
    if (/\/Filter\s*\/FlateDecode/.test(dictionary) || slice[0] === 0x78) {
      try {
        content = inflateSync(slice).toString('latin1');
      } catch {
        continue;
      }
    } else if (/\/Filter/.test(dictionary)) {
      continue; // some other encoding (DCT, CCITT, LZW) — not our business
    } else {
      content = slice.toString('latin1');
    }

    if (content) chunks.push(readTextOperators(content));
    if (chunks.length > 500) break;
  }

  const text = chunks.join(' ').replace(/\s+/g, ' ').trim();
  // A last guard: if what came back is mostly unprintable, it was never text.
  return isMostlyPrintable(text) ? text : '';
}

/**
 * Collect show-text operands, and only those.
 *
 * Strings only carry text inside a `BT`/`ET` text object; anywhere else a parenthesised run is
 * some other operator's argument. Restricting to those blocks is what keeps binary out.
 */
function readTextOperators(content: string): string {
  const out: string[] = [];
  for (const block of content.matchAll(/\bBT\b([^]*?)\bET\b/g)) {
    const body = block[1] ?? '';
    for (const m of body.matchAll(/\((?:\\[^]|[^\\()])*\)/g)) {
      out.push(decodePdfString(m[0].slice(1, -1)));
    }
    for (const m of body.matchAll(/<([0-9A-Fa-f\s]+)>\s*(?:Tj|TJ|'|")/g)) {
      const decoded = decodeHexString(m[1] ?? '');
      if (decoded && isMostlyPrintable(decoded)) out.push(decoded);
    }
  }
  return out.join(' ');
}

function decodeHexString(hex: string): string {
  const digits = hex.replace(/\s+/g, '');
  let out = '';
  for (let i = 0; i + 1 < digits.length; i += 2) {
    out += String.fromCharCode(parseInt(digits.slice(i, i + 2), 16));
  }
  return out;
}

function isMostlyPrintable(text: string): boolean {
  if (!text) return false;
  let printable = 0;
  const sample = text.slice(0, 2000);
  for (const ch of sample) {
    const code = ch.charCodeAt(0);
    if (code === 9 || code === 10 || code === 13 || (code >= 32 && code < 127) || code >= 160) printable++;
  }
  return printable / sample.length > 0.85;
}

function decodePdfString(text: string): string {
  return text
    .replace(/\\([nrtbf])/g, (_, c: string) => ({ n: '\n', r: '\r', t: '\t', b: '\b', f: '\f' })[c] ?? c)
    .replace(/\\(\d{1,3})/g, (_, oct: string) => String.fromCharCode(parseInt(oct, 8)))
    .replace(/\\(.)/g, '$1');
}

/** Points → millimetres, for reporting page size in units people think in. */
export function pointsToMm(points: number): number {
  return Math.round((points / 72) * 25.4 * 10) / 10;
}

/** Well-known page sizes, so a report can say "A4" instead of "595×842". */
export function describePageSize(width?: number, height?: number): string {
  if (width == null || height == null) return 'unknown size';
  const known: [string, number, number][] = [
    ['A4', 595.28, 841.89],
    ['A3', 841.89, 1190.55],
    ['Letter', 612, 792],
    ['Legal', 612, 1008],
  ];
  for (const [name, w, h] of known) {
    if (near(width, w) && near(height, h)) return name;
    if (near(width, h) && near(height, w)) return `${name} landscape`;
    if (near(width, w)) return `${name} width × ${pointsToMm(height)}mm tall`;
  }
  return `${pointsToMm(width)}×${pointsToMm(height)}mm`;
}

function near(a: number, b: number, tolerance = 2): boolean {
  return Math.abs(a - b) <= tolerance;
}
