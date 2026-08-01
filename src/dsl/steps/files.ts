import { readFileSync, statSync } from 'node:fs';
import { describePageSize, inspectPdf, pointsToMm } from '../../util/pdf.js';
import { matchesPattern } from '../../util/match.js';
import {
  AssertionError,
  optionalNumber,
  optionalString,
  type StepContext,
  type StepHandler,
} from './types.js';

export const fileSteps: Record<string, StepHandler> = {
  /**
   * Assert on a downloaded PDF's structure: page count, page geometry, size, and text where the
   * document has any. Extensions that capture a page usually rasterise it, so `containsText`
   * says so rather than just failing.
   */
  async assertPdf(ctx) {
    const pattern = optionalString(ctx, 'pattern') ?? '*.pdf';
    const download = await waitForFile(ctx, pattern);
    const info = inspectPdf(readFileSync(download.path));

    if (!info.valid) {
      throw new AssertionError(
        `${download.filename} is not a PDF — it does not start with %PDF-. First bytes: ${readFileSync(download.path).subarray(0, 16).toString('latin1')}`,
      );
    }
    if (!info.complete) {
      throw new AssertionError(
        `${download.filename} is truncated: no %%EOF trailer, so the extension stopped writing partway through. Size ${info.bytes} bytes.`,
      );
    }

    const summary =
      `${download.filename}: ${info.pages ?? '?'} page(s), ${describePageSize(info.width, info.height)}, ` +
      `${Math.round(info.bytes / 1024)}KB, ${info.producer ?? 'unknown producer'}` +
      `${info.hasImages ? ', rasterised' : ''}`;
    ctx.note(summary);

    checkBytes(ctx, download.filename, info.bytes);
    checkPages(ctx, download.filename, info.pages);
    checkGeometry(ctx, download.filename, info);
    checkProducer(ctx, download.filename, info.producer);
    checkText(ctx, download.filename, info);

    return {
      filename: download.filename,
      bytes: info.bytes,
      pages: info.pages,
      width: info.width,
      height: info.height,
      widthMm: info.width != null ? pointsToMm(info.width) : undefined,
      heightMm: info.height != null ? pointsToMm(info.height) : undefined,
      producer: info.producer,
      rasterised: info.hasImages && info.text.length === 0,
      hasText: info.text.length > 0,
    };
  },

  /** Assert a downloaded file exists, is a sane size, and optionally contains some text. */
  async assertFile(ctx) {
    const pattern = optionalString(ctx, 'pattern') ?? '*';
    const download = await waitForFile(ctx, pattern);
    const bytes = statSync(download.path).size;
    ctx.note(`${download.filename} (${bytes} bytes)`);

    checkBytes(ctx, download.filename, bytes);

    const contains = optionalString(ctx, 'contains');
    if (contains != null) {
      const text = readFileSync(download.path, 'utf8');
      if (!text.includes(contains)) {
        throw new AssertionError(
          `${download.filename} does not contain ${JSON.stringify(contains)}. First 200 characters: ${JSON.stringify(text.slice(0, 200))}`,
        );
      }
    }
    return { filename: download.filename, bytes };
  },
};

async function waitForFile(
  ctx: StepContext,
  pattern: string,
): Promise<{ filename: string; path: string }> {
  const deadline = Date.now() + ctx.timeout;
  while (Date.now() < deadline) {
    const hit = ctx.session.downloads.find((d) => d.path && matchesPattern(d.filename, pattern));
    if (hit?.path) return { filename: hit.filename, path: hit.path };
    await new Promise((r) => setTimeout(r, 150));
  }
  const seen = ctx.session.downloads.map((d) => d.filename);
  throw new AssertionError(
    `No downloaded file matching "${pattern}" within ${ctx.timeout}ms.` +
      (seen.length
        ? ` Downloads seen: ${seen.join(', ')}.`
        : ' No downloads occurred. If the extension saves from its service worker, give the step a longer timeout — generating a PDF from a large page can take a minute.'),
  );
}

function checkBytes(ctx: StepContext, filename: string, bytes: number): void {
  const min = optionalNumber(ctx, 'minBytes');
  const max = optionalNumber(ctx, 'maxBytes');
  if (min != null && bytes < min) {
    throw new AssertionError(
      `${filename} is ${bytes} bytes, expected at least ${min}. A file this small usually means the capture produced a blank document.`,
    );
  }
  if (max != null && bytes > max) {
    throw new AssertionError(`${filename} is ${bytes} bytes, expected at most ${max}.`);
  }
}

function checkPages(ctx: StepContext, filename: string, pages: number | undefined): void {
  const exact = optionalNumber(ctx, 'pages');
  const min = optionalNumber(ctx, 'minPages');
  const max = optionalNumber(ctx, 'maxPages');
  if (exact == null && min == null && max == null) return;

  if (pages == null) {
    throw new AssertionError(
      `Could not determine the page count of ${filename}, so a page assertion cannot be checked. The file may use compressed object streams.`,
    );
  }
  if (exact != null && pages !== exact) {
    throw new AssertionError(`${filename} has ${pages} page(s), expected ${exact}.`);
  }
  if (min != null && pages < min) {
    throw new AssertionError(`${filename} has ${pages} page(s), expected at least ${min}.`);
  }
  if (max != null && pages > max) {
    throw new AssertionError(`${filename} has ${pages} page(s), expected at most ${max}.`);
  }
}

function checkGeometry(
  ctx: StepContext,
  filename: string,
  info: { width?: number; height?: number },
): void {
  const tolerance = optionalNumber(ctx, 'tolerance') ?? 2;
  const pairs: [string, number | undefined, number | undefined][] = [
    ['width', optionalNumber(ctx, 'width'), info.width],
    ['height', optionalNumber(ctx, 'height'), info.height],
  ];
  for (const [label, expected, actual] of pairs) {
    if (expected == null) continue;
    if (actual == null) {
      throw new AssertionError(`Could not read the ${label} of ${filename} from its MediaBox.`);
    }
    if (Math.abs(actual - expected) > tolerance) {
      throw new AssertionError(
        `${filename} ${label} is ${round(actual)}pt (${pointsToMm(actual)}mm), expected ${expected}pt ±${tolerance}.`,
      );
    }
  }

  const minHeight = optionalNumber(ctx, 'minHeight');
  if (minHeight != null) {
    if (info.height == null) throw new AssertionError(`Could not read the height of ${filename}.`);
    if (info.height < minHeight) {
      throw new AssertionError(
        `${filename} is ${round(info.height)}pt tall, expected at least ${minHeight}pt. A short page suggests only the visible viewport was captured rather than the whole document.`,
      );
    }
  }
}

function checkProducer(ctx: StepContext, filename: string, producer: string | undefined): void {
  const expected = optionalString(ctx, 'producer');
  if (expected == null) return;
  if (!producer || !matchesPattern(producer, expected)) {
    throw new AssertionError(
      `${filename} reports its producer as ${producer ? JSON.stringify(producer) : 'nothing'}, expected to match ${JSON.stringify(expected)}.`,
    );
  }
}

function checkText(
  ctx: StepContext,
  filename: string,
  info: { text: string; hasImages: boolean },
): void {
  const contains = optionalString(ctx, 'containsText');
  if (contains == null) return;
  if (info.text.includes(contains)) return;

  if (!info.text && info.hasImages) {
    throw new AssertionError(
      `${filename} has no extractable text — it is a rasterised capture, so the page was drawn as an image and ${JSON.stringify(contains)} cannot be found even though it may be visible. Assert on page count, geometry or size instead.`,
    );
  }
  throw new AssertionError(
    `${filename} does not contain ${JSON.stringify(contains)}. Extracted text begins: ${JSON.stringify(info.text.slice(0, 200))}`,
  );
}

function round(value: number): number {
  return Math.round(value * 10) / 10;
}
