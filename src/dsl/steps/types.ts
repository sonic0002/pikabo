import type { Page } from 'playwright-core';
import type { Session } from '../../browser/session.js';
import type { ContextName } from '../../types.js';

export interface StepContext {
  session: Session;
  /** Options bag for this step, with `${...}` references already resolved. */
  options: Record<string, unknown>;
  /** Context the step acts on: explicit `in:`, else the session's active context. */
  target: ContextName;
  timeout: number;
  /** Value returned by the most recent `eval`, available to `expect`. */
  last: unknown;
  /** Capture a screenshot and return its path relative to the output directory. */
  capture(name: string, opts?: { fullPage?: boolean; selector?: string }): Promise<string>;
  /** Append a line to this step's report description. */
  note(text: string): void;
}

export type StepHandler = (ctx: StepContext) => Promise<unknown>;

/** Thrown when an assertion step's condition does not hold. Reported as a failure, not a crash. */
export class AssertionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AssertionError';
  }
}

export function page(ctx: StepContext): Page {
  if (ctx.target === 'worker') {
    throw new Error(
      `This step acts on a page, but "in: worker" was requested. Use \`eval\` to run code in the service worker.`,
    );
  }
  return ctx.session.page(ctx.target);
}

export function requireString(ctx: StepContext, key: string): string {
  const value = ctx.options[key];
  if (typeof value !== 'string' || value === '') {
    throw new Error(`Step is missing a "${key}" value.`);
  }
  return value;
}

export function optionalString(ctx: StepContext, key: string): string | undefined {
  const value = ctx.options[key];
  return typeof value === 'string' ? value : undefined;
}

export function optionalNumber(ctx: StepContext, key: string): number | undefined {
  const value = ctx.options[key];
  return typeof value === 'number' ? value : undefined;
}

export function optionalBoolean(ctx: StepContext, key: string): boolean {
  return ctx.options[key] === true;
}
