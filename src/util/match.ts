/** Pattern helpers shared by URL, filename and text assertions. */

/** Convert a glob (`*.pdf`, `**\/report-*.csv`) to a RegExp anchored at both ends. */
export function globToRegExp(glob: string): RegExp {
  let out = '';
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i]!;
    if (ch === '*') {
      if (glob[i + 1] === '*') {
        out += '.*';
        i++;
        if (glob[i + 1] === '/') i++;
      } else {
        out += '[^/]*';
      }
    } else if (ch === '?') {
      out += '.';
    } else {
      out += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${out}$`);
}

/**
 * A pattern written as `/foo/i` is a regex; anything else is a glob, unless it contains no glob
 * metacharacters, in which case it is a substring match. That covers what people mean by
 * `waitForUrl: /dashboard` without making them think about it.
 */
export function matchesPattern(value: string, pattern: string): boolean {
  const asRegex = /^\/(.*)\/([gimsuy]*)$/.exec(pattern);
  if (asRegex) return new RegExp(asRegex[1]!, asRegex[2]).test(value);
  if (/[*?]/.test(pattern)) return globToRegExp(pattern).test(value);
  return value.includes(pattern);
}

/**
 * Pattern matching for free text — console messages, error strings — rather than paths.
 *
 * `*` crosses everything here. In `matchesPattern` a single `*` deliberately stops at `/`,
 * which is right for filenames and wrong for a log line like
 * `@bilibili/bili-user-fingerprint: ...`, where the slash is just a character.
 */
export function matchesLoose(value: string, pattern: string): boolean {
  const asRegex = /^\/(.*)\/([gimsuy]*)$/.exec(pattern);
  if (asRegex) return new RegExp(asRegex[1]!, asRegex[2]).test(value);
  if (!/[*?]/.test(pattern)) return value.includes(pattern);
  const source = pattern
    .split('')
    .map((ch) => (ch === '*' ? '[^]*' : ch === '?' ? '[^]' : ch.replace(/[.+^${}()|[\]\\]/g, '\\$&')))
    .join('');
  return new RegExp(`^${source}$`).test(value);
}

/** Deep structural equality for assertion values coming out of the browser as JSON. */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== typeof b || a === null || b === null) return false;
  if (typeof a !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a as object);
  const kb = Object.keys(b as object);
  if (ka.length !== kb.length) return false;
  return ka.every((k) =>
    deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]),
  );
}

export function describe(value: unknown): string {
  if (typeof value === 'string') return JSON.stringify(value);
  if (value === undefined) return 'undefined';
  try {
    const json = JSON.stringify(value);
    return json.length > 200 ? `${json.slice(0, 200)}…` : json;
  } catch {
    return String(value);
  }
}
