import type { ExtensionEvent } from '../../types.js';
import { deepEqual, describe as describeValue, matchesPattern } from '../../util/match.js';
import { AssertionError, type StepContext, type StepHandler } from './types.js';

export const eventSteps: Record<string, StepHandler> = {
  async waitForExtensionEvent(ctx) {
    const deadline = Date.now() + ctx.timeout;
    while (Date.now() < deadline) {
      await ctx.session.drainWorkerEvents();
      const event = findExtensionEvent(ctx.session.events, ctx, ctx.eventStart);
      if (event) {
        ctx.note(describeEvent(event));
        return event;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new AssertionError(noEventMessage(ctx, ctx.session.events, ctx.eventStart, ctx.timeout));
  },

  async assertExtensionEvent(ctx) {
    await ctx.session.drainWorkerEvents();
    const event = findExtensionEvent(ctx.session.events, ctx, ctx.eventStart);
    if (!event) throw new AssertionError(noEventMessage(ctx, ctx.session.events, ctx.eventStart));
    ctx.note(describeEvent(event));
    return event;
  },
};

export function findExtensionEvent(
  events: ExtensionEvent[],
  ctx: Pick<StepContext, 'options'>,
  afterSequence = 0,
): ExtensionEvent | undefined {
  const expectedType = stringOption(ctx.options, 'type', true)!;
  const source = stringOption(ctx.options, 'source');
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index]!;
    if (event.sequence <= afterSequence) break;
    if (!matchesEventType(event.type, expectedType)) continue;
    if (source && event.source !== source) continue;
    if ('equals' in ctx.options && !deepEqual(event.detail, ctx.options['equals'])) continue;
    if ('contains' in ctx.options && !deepContains(event.detail, ctx.options['contains'])) continue;
    if (
      'matches' in ctx.options &&
      !matchesPattern(JSON.stringify(event.detail) ?? String(event.detail), String(ctx.options['matches']))
    ) {
      continue;
    }
    return event;
  }
  return undefined;
}

function stringOption(options: Record<string, unknown>, key: string, required = false): string | undefined {
  const value = options[key];
  if (typeof value === 'string' && value !== '') return value;
  if (required) throw new Error(`Step is missing a "${key}" value.`);
  return undefined;
}

function matchesEventType(actual: string, expected: string): boolean {
  return /[*?]/.test(expected) || /^\/.+\/[gimsuy]*$/.test(expected)
    ? matchesPattern(actual, expected)
    : actual === expected;
}

/** Recursive partial matching for JSON-shaped event payloads. */
function deepContains(actual: unknown, expected: unknown): boolean {
  if (deepEqual(actual, expected)) return true;
  if (expected === null || typeof expected !== 'object') {
    return typeof actual === 'string' && actual.includes(String(expected));
  }
  if (actual === null || typeof actual !== 'object') return false;
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual)) return false;
    return expected.every((item) => actual.some((candidate) => deepContains(candidate, item)));
  }
  if (Array.isArray(actual)) return false;
  return Object.entries(expected).every(([key, value]) =>
    deepContains((actual as Record<string, unknown>)[key], value),
  );
}

function noEventMessage(ctx: Pick<StepContext, 'options'>, events: ExtensionEvent[], after: number, timeout?: number): string {
  const type = String(ctx.options['type']);
  const seen = events.filter((event) => event.sequence > after).slice(-8).map(describeEvent);
  return (
    `No extension event matching ${describeValue(type)}` +
    (timeout != null ? ` within ${timeout}ms.` : '.') +
    (seen.length ? ` Recent events: ${seen.join('; ')}.` : ' No extension events were observed.')
  );
}

function describeEvent(event: ExtensionEvent): string {
  const detail = event.detail === undefined ? '' : ` ${describeValue(event.detail)}`;
  return `${event.type} [${event.source}]${detail}`;
}
