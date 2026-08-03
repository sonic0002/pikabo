import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createPalette, detectColor, ESC, stripAnsi } from '../../src/util/color.js';

const srcDir = join(dirname(fileURLToPath(import.meta.url)), '../../src');

describe('createPalette', () => {
  it('emits a real escape byte, not the literal text "[32m"', () => {
    const { green } = createPalette(true);
    const output = green('ok');
    expect(output.charCodeAt(0)).toBe(27);
    expect(output).toBe(`${ESC}[32mok${ESC}[0m`);
    // The failure mode this guards: a stripped ESC leaves `[32m` visible in the terminal.
    expect(output.startsWith('[32m')).toBe(false);
  });

  it('returns plain text when disabled', () => {
    const { green, red, dim, bold } = createPalette(false);
    for (const paint of [green, red, dim, bold]) {
      expect(paint('ok')).toBe('ok');
      expect(paint('ok')).not.toContain(ESC);
    }
  });

  it('round-trips through stripAnsi', () => {
    const { bold } = createPalette(true);
    expect(stripAnsi(bold('suite name'))).toBe('suite name');
  });
});

describe('detectColor', () => {
  const base = { argv: [], env: { TERM: 'xterm-256color' }, isTTY: true };

  it('is on for a colour-capable TTY', () => {
    expect(detectColor(base)).toBe(true);
  });

  it('is off when not a TTY, so piping and redirecting stay clean', () => {
    expect(detectColor({ ...base, isTTY: false })).toBe(false);
  });

  it('honours --no-color and NO_COLOR over everything else', () => {
    expect(detectColor({ ...base, argv: ['--no-color'] })).toBe(false);
    expect(detectColor({ ...base, env: { ...base.env, NO_COLOR: '1' } })).toBe(false);
    expect(
      detectColor({ ...base, argv: ['--no-color'], env: { ...base.env, FORCE_COLOR: '1' } }),
    ).toBe(false);
    expect(detectColor({ ...base, env: { ...base.env, NO_COLOR: '1', FORCE_COLOR: '1' } })).toBe(false);
  });

  it('honours FORCE_COLOR when there is no TTY', () => {
    expect(detectColor({ ...base, isTTY: false, env: { ...base.env, FORCE_COLOR: '1' } })).toBe(true);
    expect(detectColor({ ...base, isTTY: false, env: { ...base.env, FORCE_COLOR: '0' } })).toBe(false);
  });

  it('is off for a dumb or unset TERM', () => {
    expect(detectColor({ ...base, env: { TERM: 'dumb' } })).toBe(false);
    expect(detectColor({ ...base, env: {} })).toBe(false);
  });
});

describe('source hygiene', () => {
  it('contains no raw ESC bytes anywhere in src/', () => {
    // A literal control character in source is invisible in an editor and is silently dropped by
    // anything that rewrites the file — which is exactly how ext-test shipped printing `[1m`.
    // Escapes must be written as \\u001b.
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSyncSafe(dir)) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith('.ts') && readFileSync(full, 'utf8').includes('')) {
          offenders.push(full);
        }
      }
    };
    walk(srcDir);
    expect(offenders, `raw ESC byte found in: ${offenders.join(', ')}`).toEqual([]);
  });
});

function readdirSyncSafe(dir: string): { name: string; isDirectory: () => boolean }[] {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { readdirSync } = require('node:fs') as typeof import('node:fs');
  return readdirSync(dir, { withFileTypes: true });
}
