import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { RunResult } from '../types.js';

const run = promisify(execFile);
let ffmpegProbe: Promise<boolean> | undefined;

export interface CompositeVideoSegment {
  source: string;
  /** Offset into the source page recording. */
  offsetMs: number;
  /** Time this step occupied in the testcase timeline. */
  durationMs: number;
  context: string;
  stepIndex: number;
  action: string;
}

export interface CompositeVideoResult {
  ok: boolean;
  warning?: string;
}

/**
 * Cut the relevant interval from each page recording and concatenate those cuts into one
 * testcase replay. Each segment is normalized to one canvas and labelled with its context and
 * step, so switching from a web page to a popup remains obvious in a headless recording.
 */
export async function composeTestVideo(
  segments: CompositeVideoSegment[],
  target: string,
): Promise<CompositeVideoResult> {
  if (!segments.length) return { ok: false, warning: 'No visual testcase segments were recorded.' };
  if (!(await hasFfmpeg())) {
    return {
      ok: false,
      warning: 'ffmpeg is not available; raw per-context recordings were kept, but no testcase video was composed.',
    };
  }

  const inputArgs = segments.flatMap((segment) => [
    '-ss', seconds(Math.max(0, segment.offsetMs)),
    '-i', segment.source,
  ]);
  const plain = buildCompositeFilter(segments, false);
  const outputArgs = [
    '-map', '[outv]',
    '-an',
    '-c:v', 'libvpx',
    '-deadline', 'realtime',
    '-cpu-used', '6',
    '-b:v', '1400k',
    target,
  ];

  const labelsDir = mkdtempSync(join(tmpdir(), 'pikabo-video-labels-'));
  const labels = segments.map((segment, index) => {
    const path = join(labelsDir, `${index}.ppm`);
    writeLabel(path, overlayText(segment));
    return path;
  });
  const labelArgs = labels.flatMap((path) => ['-loop', '1', '-framerate', '25', '-i', path]);
  const labelled = buildCompositeFilter(segments, true);

  try {
    try {
      await runFfmpeg(['-y', ...inputArgs, ...labelArgs, '-filter_complex', labelled, ...outputArgs]);
    } catch {
      // If image overlay support is missing, preserve the continuous replay and retry without
      // labels. This remains materially better than selecting one arbitrary page recording.
      try {
        await runFfmpeg(['-y', ...inputArgs, '-filter_complex', plain, ...outputArgs]);
      } catch (error) {
        return {
          ok: false,
          warning: `Could not compose the testcase video: ${shortError(error)}`,
        };
      }
    }
  } finally {
    rmSync(labelsDir, { recursive: true, force: true });
  }
  if (!existsSync(target) || statSync(target).size === 0) {
    return { ok: false, warning: 'ffmpeg produced no testcase video; raw recordings were kept.' };
  }
  return { ok: true };
}

function buildCompositeFilter(segments: CompositeVideoSegment[], labels: boolean): string {
  const filters = segments.map((segment, index) => {
    // Very fast assertion steps otherwise disappear between video frames. Holding their final
    // frame briefly makes the replay readable without changing the recorded action order.
    const duration = Math.max(0.35, segment.durationMs / 1000);
    const base = `[${index}:v]tpad=stop_mode=clone:stop_duration=${duration.toFixed(3)},trim=duration=${duration.toFixed(3)},setpts=PTS-STARTPTS,scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2:color=black,fps=25,format=yuv420p`;
    return labels
      ? `${base}[base${index}];[${segments.length + index}:v]format=yuv420p[label${index}];[base${index}][label${index}]overlay=0:0:shortest=1[v${index}]`
      : `${base}[v${index}]`;
  });
  const inputs = segments.map((_segment, index) => `[v${index}]`).join('');
  return `${filters.join(';')};${inputs}concat=n=${segments.length}:v=1:a=0[outv]`;
}

function overlayText(segment: CompositeVideoSegment): string {
  const safe = (value: string) => value.replace(/[^a-z0-9._# /-]+/gi, ' ').replace(/\s+/g, ' ').trim();
  return safe(`STEP ${segment.stepIndex + 1}  ${segment.context}  ${segment.action}`).toUpperCase();
}

/** Render a dependency-free 5×7 bitmap label as a PPM image FFmpeg can overlay everywhere. */
function writeLabel(path: string, text: string): void {
  const width = 1280;
  const height = 52;
  const scale = 3;
  const pixels = Buffer.alloc(width * height * 3, 0);
  let x = 18;
  const y = 15;
  for (const char of text.slice(0, 68)) {
    const rows = BITMAP_FONT[char] ?? BITMAP_FONT['?']!;
    for (let row = 0; row < 7; row++) {
      for (let col = 0; col < 5; col++) {
        if (!(rows[row]! & (1 << (4 - col)))) continue;
        for (let dy = 0; dy < scale; dy++) {
          for (let dx = 0; dx < scale; dx++) {
            const offset = ((y + row * scale + dy) * width + x + col * scale + dx) * 3;
            pixels[offset] = 255;
            pixels[offset + 1] = 255;
            pixels[offset + 2] = 255;
          }
        }
      }
    }
    x += 6 * scale;
  }
  writeFileSync(path, Buffer.concat([Buffer.from(`P6\n${width} ${height}\n255\n`), pixels]));
}

const BITMAP_FONT: Record<string, number[]> = {
  ' ': [0, 0, 0, 0, 0, 0, 0],
  '?': [14, 17, 1, 2, 4, 0, 4],
  '#': [10, 31, 10, 10, 31, 10, 0],
  '-': [0, 0, 0, 31, 0, 0, 0],
  '.': [0, 0, 0, 0, 0, 6, 6],
  '/': [1, 2, 2, 4, 8, 8, 16],
  '_': [0, 0, 0, 0, 0, 0, 31],
  '0': [14, 17, 19, 21, 25, 17, 14],
  '1': [4, 12, 4, 4, 4, 4, 14],
  '2': [14, 17, 1, 2, 4, 8, 31],
  '3': [30, 1, 1, 14, 1, 1, 30],
  '4': [2, 6, 10, 18, 31, 2, 2],
  '5': [31, 16, 16, 30, 1, 1, 30],
  '6': [14, 16, 16, 30, 17, 17, 14],
  '7': [31, 1, 2, 4, 8, 8, 8],
  '8': [14, 17, 17, 14, 17, 17, 14],
  '9': [14, 17, 17, 15, 1, 1, 14],
  A: [14, 17, 17, 31, 17, 17, 17], B: [30, 17, 17, 30, 17, 17, 30],
  C: [14, 17, 16, 16, 16, 17, 14], D: [30, 17, 17, 17, 17, 17, 30],
  E: [31, 16, 16, 30, 16, 16, 31], F: [31, 16, 16, 30, 16, 16, 16],
  G: [14, 17, 16, 23, 17, 17, 14], H: [17, 17, 17, 31, 17, 17, 17],
  I: [14, 4, 4, 4, 4, 4, 14], J: [7, 2, 2, 2, 18, 18, 12],
  K: [17, 18, 20, 24, 20, 18, 17], L: [16, 16, 16, 16, 16, 16, 31],
  M: [17, 27, 21, 21, 17, 17, 17], N: [17, 25, 21, 19, 17, 17, 17],
  O: [14, 17, 17, 17, 17, 17, 14], P: [30, 17, 17, 30, 16, 16, 16],
  Q: [14, 17, 17, 17, 21, 18, 13], R: [30, 17, 17, 30, 20, 18, 17],
  S: [15, 16, 16, 14, 1, 1, 30], T: [31, 4, 4, 4, 4, 4, 4],
  U: [17, 17, 17, 17, 17, 17, 14], V: [17, 17, 17, 17, 17, 10, 4],
  W: [17, 17, 17, 21, 21, 21, 10], X: [17, 17, 10, 4, 10, 17, 17],
  Y: [17, 17, 10, 4, 4, 4, 4], Z: [31, 1, 2, 4, 8, 16, 31],
};

function seconds(ms: number): string {
  return (ms / 1000).toFixed(3);
}

async function runFfmpeg(args: string[]): Promise<void> {
  await run('ffmpeg', args, { maxBuffer: 10 * 1024 * 1024 });
}

function shortError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.length > 300 ? `${message.slice(0, 300)}…` : message;
}

/**
 * Convert recorded WebM sessions to GIF. Requires ffmpeg on PATH; its absence is a warning, not
 * a failure — the WebM files are still there.
 */
export async function convertVideosToGif(
  result: RunResult,
  outDir: string,
  log: (message: string) => void,
): Promise<void> {
  if (!(await hasFfmpeg())) {
    log('ffmpeg not found on PATH — keeping .webm recordings and skipping GIF conversion.');
    return;
  }
  for (const suite of result.suites) {
    for (const test of suite.tests) {
      if (!test.video) continue;
      const source = test.video.startsWith('/') ? test.video : `${outDir}/${test.video}`;
      if (!existsSync(source)) continue;
      const target = source.replace(/\.webm$/i, '.gif');
      try {
        await run('ffmpeg', [
          '-y',
          '-i', source,
          '-vf', 'fps=8,scale=800:-1:flags=lanczos,split[a][b];[a]palettegen[p];[b][p]paletteuse',
          '-loop', '0',
          target,
        ]);
        test.gif = target.startsWith(outDir) ? target.slice(outDir.length + 1) : target;
      } catch (err) {
        log(`GIF conversion failed for ${source}: ${(err as Error).message}`);
      }
    }
  }
}

export async function hasFfmpeg(): Promise<boolean> {
  ffmpegProbe ??= run('ffmpeg', ['-version'])
    .then(() => true)
    .catch(() => false);
  return await ffmpegProbe;
}
