import { deflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { describePageSize, inspectPdf, pointsToMm } from '../../src/util/pdf.js';
import { matchesLoose } from '../../src/util/match.js';

/** Build a minimal but structurally real PDF, so the reader is tested against actual syntax. */
function buildPdf(options: {
  pages?: number;
  mediaBox?: [number, number, number, number];
  text?: string;
  compress?: boolean;
  image?: boolean;
  producer?: string;
  truncated?: boolean;
} = {}): Buffer {
  const { pages = 1, mediaBox = [0, 0, 595.28, 841.89], text, compress = false, image = false } = options;
  const parts: string[] = ['%PDF-1.4\n'];

  parts.push(`1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n`);
  parts.push(`2 0 obj\n<< /Type /Pages /Count ${pages} /Kids [3 0 R] >>\nendobj\n`);
  parts.push(
    `3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [${mediaBox.join(' ')}] /Contents 4 0 R >>\nendobj\n`,
  );

  const content = text ? `BT /F1 12 Tf 72 720 Td (${text}) Tj ET\n` : 'q 1 0 0 1 0 0 cm Q\n';
  const buffers: Buffer[] = [];
  if (compress) {
    const deflated = deflateSync(Buffer.from(content, 'latin1'));
    parts.push(`4 0 obj\n<< /Length ${deflated.length} /Filter /FlateDecode >>\nstream\n`);
    buffers.push(Buffer.from(parts.join(''), 'latin1'), deflated, Buffer.from('\nendstream\nendobj\n', 'latin1'));
    parts.length = 0;
  } else {
    parts.push(`4 0 obj\n<< /Length ${content.length} >>\nstream\n${content}endstream\nendobj\n`);
  }

  if (image) {
    // An image stream whose bytes happen to contain parentheses — the exact shape that made a
    // naive extractor report binary noise as text.
    const pixels = Buffer.from('(not text at all)\x00\x01\x02\xff\xfe', 'latin1');
    const deflated = deflateSync(pixels);
    parts.push(
      `5 0 obj\n<< /Type /XObject /Subtype /Image /Width 2 /Height 2 /Length ${deflated.length} /Filter /FlateDecode >>\nstream\n`,
    );
    buffers.push(Buffer.from(parts.join(''), 'latin1'), deflated, Buffer.from('\nendstream\nendobj\n', 'latin1'));
    parts.length = 0;
  }

  parts.push(`6 0 obj\n<< /Producer (${options.producer ?? 'test-harness 1.0'}) >>\nendobj\n`);
  parts.push('trailer\n<< /Root 1 0 R /Info 6 0 R >>\n');
  if (!options.truncated) parts.push('%%EOF');

  buffers.push(Buffer.from(parts.join(''), 'latin1'));
  return Buffer.concat(buffers);
}

describe('inspectPdf', () => {
  it('recognises a valid PDF and its version', () => {
    const info = inspectPdf(buildPdf());
    expect(info.valid).toBe(true);
    expect(info.version).toBe('1.4');
    expect(info.complete).toBe(true);
  });

  it('rejects a file that is not a PDF', () => {
    const info = inspectPdf(Buffer.from('<html>nope</html>'));
    expect(info.valid).toBe(false);
  });

  it('detects a truncated file with no trailer', () => {
    expect(inspectPdf(buildPdf({ truncated: true })).complete).toBe(false);
  });

  it('reads the page count from the page tree', () => {
    expect(inspectPdf(buildPdf({ pages: 1 })).pages).toBe(1);
    expect(inspectPdf(buildPdf({ pages: 7 })).pages).toBe(7);
  });

  it('reads page geometry from the MediaBox', () => {
    const info = inspectPdf(buildPdf({ mediaBox: [0, 0, 595.28, 2294.07] }));
    expect(info.width).toBeCloseTo(595.28, 1);
    expect(info.height).toBeCloseTo(2294.07, 1);
  });

  it('reads the producer', () => {
    expect(inspectPdf(buildPdf({ producer: 'jsPDF 2.5.1' })).producer).toBe('jsPDF 2.5.1');
  });

  it('extracts text from an uncompressed content stream', () => {
    expect(inspectPdf(buildPdf({ text: 'Hello PixelsTech' })).text).toContain('Hello PixelsTech');
  });

  it('extracts text from a Flate-compressed content stream', () => {
    expect(inspectPdf(buildPdf({ text: 'Compressed words', compress: true })).text).toContain(
      'Compressed words',
    );
  });

  it('never reports image bytes as text', () => {
    const info = inspectPdf(buildPdf({ image: true }));
    expect(info.hasImages).toBe(true);
    expect(info.text).toBe('');
    expect(info.text).not.toContain('not text at all');
  });

  it('still finds real text in a document that also contains images', () => {
    const info = inspectPdf(buildPdf({ text: 'Real caption', image: true }));
    expect(info.hasImages).toBe(true);
    expect(info.text).toContain('Real caption');
  });
});

describe('describePageSize', () => {
  it('names standard sizes', () => {
    expect(describePageSize(595.28, 841.89)).toBe('A4');
    expect(describePageSize(612, 792)).toBe('Letter');
    expect(describePageSize(841.89, 595.28)).toBe('A4 landscape');
  });

  it('describes an unpaginated capture as A4 width by its height', () => {
    expect(describePageSize(595.28, 2294.07)).toMatch(/A4 width × 809\.3mm tall/);
  });

  it('falls back to millimetres', () => {
    expect(describePageSize(100, 200)).toMatch(/mm/);
  });

  it('handles unknown dimensions', () => {
    expect(describePageSize(undefined, undefined)).toBe('unknown size');
  });
});

describe('pointsToMm', () => {
  it('converts A4 width to 210mm', () => {
    expect(pointsToMm(595.28)).toBe(210);
  });
});

describe('matchesLoose', () => {
  it('lets * cross slashes, unlike path globs', () => {
    expect(matchesLoose('@bilibili/bili-user-fingerprint(report): not found', '*bili-user-fingerprint*')).toBe(
      true,
    );
  });

  it('treats a plain string as a substring match', () => {
    expect(matchesLoose('TypeError: boom', 'boom')).toBe(true);
    expect(matchesLoose('TypeError: boom', 'bang')).toBe(false);
  });

  it('supports regex patterns', () => {
    expect(matchesLoose('Failed to load resource: 404', '/^Failed.*404$/')).toBe(true);
  });
});
