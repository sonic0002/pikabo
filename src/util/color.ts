/**
 * Terminal colour, kept in one small module with no literal control characters.
 *
 * The escape is written as `\u001b`, never as a raw ESC byte in the source. A literal control
 * character is invisible in an editor and survives only until some tool normalises the file —
 * at which point the program starts printing `[1m` at the reader instead of emitting bold, and
 * the damage looks like a terminal problem rather than a code problem.
 */

export const ESC = '\u001b';

export type Palette = {
  red: (text: string) => string;
  green: (text: string) => string;
  dim: (text: string) => string;
  bold: (text: string) => string;
  enabled: boolean;
};

const CODES = { red: '31', green: '32', dim: '2', bold: '1' } as const;

export function createPalette(enabled: boolean): Palette {
  const wrap =
    (code: string) =>
    (text: string): string =>
      enabled ? `${ESC}[${code}m${text}${ESC}[0m` : text;

  return {
    red: wrap(CODES.red),
    green: wrap(CODES.green),
    dim: wrap(CODES.dim),
    bold: wrap(CODES.bold),
    enabled,
  };
}

export interface ColorEnvironment {
  argv?: string[];
  env?: Record<string, string | undefined>;
  isTTY?: boolean;
}

/**
 * Decide whether to emit styling.
 *
 * `--no-color` is read straight from argv rather than through the argument parser, because
 * output can happen before parsing finishes.
 */
export function detectColor(environment: ColorEnvironment = {}): boolean {
  const argv = environment.argv ?? process.argv;
  const env = environment.env ?? process.env;
  const isTTY = environment.isTTY ?? Boolean(process.stdout.isTTY);

  if (argv.includes('--no-color') || argv.includes('--no-colour')) return false;
  if (env['NO_COLOR'] != null && env['NO_COLOR'] !== '') return false;

  const force = env['FORCE_COLOR'];
  if (force != null && force !== '' && force !== '0' && force !== 'false') return true;

  const term = env['TERM'];
  if (term === 'dumb' || term === '' || term == null) return false;
  return isTTY;
}

/** Remove styling from a string, for tests and for writing terminal output to a file. */
export function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\u001b\[[0-9;]*m/g, '');
}
