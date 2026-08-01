/**
 * `${...}` substitution inside step options.
 *
 * Three namespaces are available: `vars.*` from the suite, `env.*` from the process
 * environment, and `last` — the value returned by the most recent `eval` step. A reference that
 * makes up the entire string keeps its original type, so `value: ${last}` can carry an object;
 * a reference embedded in a larger string is stringified.
 */

export interface Scope {
  vars: Record<string, unknown>;
  last: unknown;
  env?: Record<string, string | undefined>;
}

const WHOLE = /^\$\{([^}]+)\}$/;
const EMBEDDED = /\$\{([^}]+)\}/g;

export function interpolate(value: unknown, scope: Scope): unknown {
  if (typeof value === 'string') return interpolateString(value, scope);
  if (Array.isArray(value)) return value.map((item) => interpolate(item, scope));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, interpolate(v, scope)]),
    );
  }
  return value;
}

function interpolateString(text: string, scope: Scope): unknown {
  const whole = WHOLE.exec(text);
  if (whole) {
    const resolved = lookup(whole[1]!.trim(), scope);
    return resolved === undefined ? text : resolved;
  }
  return text.replace(EMBEDDED, (match, expr: string) => {
    const resolved = lookup(expr.trim(), scope);
    if (resolved === undefined) return match;
    return typeof resolved === 'object' ? JSON.stringify(resolved) : String(resolved);
  });
}

function lookup(expr: string, scope: Scope): unknown {
  const [head, ...rest] = expr.split('.');
  let base: unknown;
  if (head === 'last') base = scope.last;
  else if (head === 'vars') base = scope.vars;
  else if (head === 'env') base = scope.env ?? process.env;
  else return undefined;

  let current = base;
  for (const key of rest) {
    if (current == null || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}
