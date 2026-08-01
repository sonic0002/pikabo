import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { promisify } from 'node:util';
import type { RunResult } from '../types.js';

const run = promisify(execFile);

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
  try {
    await run('ffmpeg', ['-version']);
    return true;
  } catch {
    return false;
  }
}
