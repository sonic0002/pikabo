import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { RunResult } from '../types.js';

export function writeJsonReport(result: RunResult, outDir: string): string {
  const file = join(outDir, 'results.json');
  writeFileSync(file, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  return file;
}
