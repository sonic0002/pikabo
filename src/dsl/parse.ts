import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import Ajv, { type ErrorObject } from 'ajv';
import { parseDocument, type Document } from 'yaml';
import { STEP_BY_NAME, STEP_NAMES, SUITE_SCHEMA } from './schema.js';
import type { Step, Suite, Test } from '../types.js';

export class SuiteParseError extends Error {
  constructor(
    message: string,
    readonly file: string,
    readonly issues: string[] = [],
  ) {
    super(message);
    this.name = 'SuiteParseError';
  }
}

const ajv = new Ajv({ allErrors: true, strict: false });
const validate = ajv.compile(SUITE_SCHEMA);

/** Parse and validate a suite file. Throws SuiteParseError with line numbers on failure. */
export function parseSuiteFile(file: string): Suite {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (err) {
    throw new SuiteParseError(`Cannot read suite file: ${(err as Error).message}`, file);
  }
  return parseSuite(text, file);
}

export function parseSuite(text: string, file = '<inline>'): Suite {
  const doc = parseDocument(text, { keepSourceTokens: true });
  if (doc.errors.length) {
    const issues = doc.errors.map((e) => `${lineOf(text, e.pos?.[0] ?? 0)}: ${e.message}`);
    throw new SuiteParseError(`Invalid YAML in ${basename(file)}`, file, issues);
  }

  const raw = doc.toJS() as Record<string, unknown> | null;
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new SuiteParseError(`Suite must be a YAML mapping`, file);
  }

  const normalised = normaliseSuite(raw, file);

  if (!validate(normalised)) {
    const issues = (validate.errors ?? []).map((e) => describeError(e, doc, text));
    throw new SuiteParseError(`${basename(file)} does not match the suite schema`, file, dedupe(issues));
  }

  const suite = normalised as unknown as Suite;
  suite.name ||= basename(file).replace(/\.(ya?ml)$/i, '');
  return suite;
}

/**
 * Accept the shorthands people actually write, and hand the schema a single canonical shape:
 *
 *   steps: [...]                 → tests: [{ name: <suite name>, steps: [...] }]
 *   - openPopup                  → { openPopup: null }
 *   tests: { "name": [steps] }   → tests: [{ name, steps }]
 */
function normaliseSuite(raw: Record<string, unknown>, file: string): Record<string, unknown> {
  const out: Record<string, unknown> = { ...raw };

  if (!out['tests'] && Array.isArray(out['steps'])) {
    const name = typeof out['name'] === 'string' ? out['name'] : basename(file).replace(/\.(ya?ml)$/i, '');
    out['tests'] = [{ name, steps: out['steps'] }];
    delete out['steps'];
  }

  if (out['tests'] && !Array.isArray(out['tests']) && typeof out['tests'] === 'object') {
    out['tests'] = Object.entries(out['tests'] as Record<string, unknown>).map(([name, steps]) => ({
      name,
      steps,
    }));
  }

  if (Array.isArray(out['tests'])) {
    out['tests'] = (out['tests'] as unknown[]).map((t) => {
      if (t == null || typeof t !== 'object') return t;
      const test = { ...(t as Record<string, unknown>) };
      if (Array.isArray(test['steps'])) test['steps'] = test['steps'].map(normaliseStep);
      return test;
    });
  }
  for (const hook of ['before', 'after'] as const) {
    if (Array.isArray(out[hook])) out[hook] = (out[hook] as unknown[]).map(normaliseStep);
  }

  return out;
}

/** `- openPopup` parses as a string; turn it into `{ openPopup: null }`. */
export function normaliseStep(step: unknown): unknown {
  if (typeof step === 'string') return { [step]: null };
  return step;
}

/**
 * Turn an Ajv error into something a human can act on: a line number where we can find one,
 * the offending key, and a suggestion when the key looks like a typo of a real step.
 */
function describeError(err: ErrorObject, doc: Document, text: string): string {
  const path = err.instancePath || '/';
  if (err.keyword === 'additionalProperties') {
    const key = String((err.params as { additionalProperty?: string }).additionalProperty);
    const where = locate(doc, text, path);
    const suggestion = suggestStep(key);
    const isStepSlot = /\/steps\/\d+$/.test(path);
    if (isStepSlot) {
      return `${where}unknown step "${key}"${suggestion ? ` — did you mean "${suggestion}"?` : ''}`;
    }
    return `${where}unknown option "${key}" at ${path}${suggestion ? ` — did you mean "${suggestion}"?` : ''}`;
  }
  if (err.keyword === 'maxProperties') {
    return `${locate(doc, text, path)}a step must have exactly one action key (${path})`;
  }
  if (err.keyword === 'required') {
    const missing = String((err.params as { missingProperty?: string }).missingProperty);
    return `${locate(doc, text, path)}missing required property "${missing}" at ${path || '/'}`;
  }
  return `${locate(doc, text, path)}${path || '/'} ${err.message}`;
}

function locate(doc: Document, text: string, instancePath: string): string {
  const segments = instancePath.split('/').filter(Boolean).map((s) => (/^\d+$/.test(s) ? Number(s) : s));
  if (!segments.length) return '';
  try {
    const node = doc.getIn(segments, true) as { range?: [number, number, number] } | undefined;
    if (node?.range) return `line ${lineOf(text, node.range[0])}: `;
  } catch {
    /* fall through — a location is a nicety, not a requirement */
  }
  return '';
}

function lineOf(text: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < text.length; i++) if (text[i] === '\n') line++;
  return line;
}

/** Levenshtein-lite: good enough to catch `assertVisable` → `assertVisible`. */
function suggestStep(key: string): string | undefined {
  const lower = key.toLowerCase();
  const candidates = [...STEP_NAMES];
  let best: { name: string; score: number } | undefined;
  for (const name of candidates) {
    const score = distance(lower, name.toLowerCase());
    if (score <= Math.max(2, Math.floor(name.length / 4)) && (!best || score < best.score)) {
      best = { name, score };
    }
  }
  return best?.name;
}

function distance(a: string, b: string): number {
  const rows: number[][] = [];
  for (let i = 0; i <= a.length; i++) rows.push([i, ...Array<number>(b.length).fill(0)]);
  const first = rows[0]!;
  for (let j = 0; j <= b.length; j++) first[j] = j;
  for (let i = 1; i <= a.length; i++) {
    const row = rows[i]!;
    const prev = rows[i - 1]!;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      row[j] = Math.min(prev[j]! + 1, row[j - 1]! + 1, prev[j - 1]! + cost);
    }
  }
  return rows[a.length]![b.length]!;
}

function dedupe(items: string[]): string[] {
  return [...new Set(items)];
}

/** Split a normalised step into its action name and options bag. */
export function readStep(step: Step): { action: string; options: Record<string, unknown> } {
  const keys = Object.keys(step);
  const action = keys[0]!;
  const spec = STEP_BY_NAME.get(action);
  const value = step[action];

  if (value == null || typeof value === 'boolean') return { action, options: {} };
  if (typeof value === 'object' && !Array.isArray(value)) {
    return { action, options: value as Record<string, unknown> };
  }
  const primary = spec?.primary ?? 'value';
  return { action, options: { [primary]: value } };
}
