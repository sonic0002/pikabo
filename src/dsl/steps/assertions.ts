import { deepEqual, describe as describeValue, matchesLoose, matchesPattern } from '../../util/match.js';
import {
  AssertionError,
  optionalBoolean,
  optionalNumber,
  optionalString,
  page,
  requireString,
  type StepContext,
  type StepHandler,
} from './types.js';

export const assertionSteps: Record<string, StepHandler> = {
  async assertVisible(ctx) {
    const selector = requireString(ctx, 'selector');
    const expectHidden = optionalBoolean(ctx, 'not');
    const locator = page(ctx).locator(selector).first();
    try {
      await locator.waitFor({ state: expectHidden ? 'hidden' : 'visible', timeout: ctx.timeout });
    } catch {
      throw new AssertionError(
        expectHidden
          ? `Expected "${selector}" to be hidden in ${ctx.target}, but it is visible.`
          : `Expected "${selector}" to be visible in ${ctx.target}, but it was not within ${ctx.timeout}ms.` +
            (await nearMiss(ctx, selector)),
      );
    }
    return undefined;
  },

  async assertText(ctx) {
    const selector = optionalString(ctx, 'selector');
    const target = selector ? page(ctx).locator(selector).first() : page(ctx).locator('body');
    let actual: string;
    try {
      await target.waitFor({ state: 'attached', timeout: ctx.timeout });
      actual = ((await target.textContent()) ?? '').trim();
    } catch {
      throw new AssertionError(
        `Expected text in "${selector ?? 'body'}" but no such element exists in ${ctx.target}.`,
      );
    }
    const negate = optionalBoolean(ctx, 'not');
    const check = compareText(ctx, actual);
    if (check.ok === negate) {
      throw new AssertionError(
        negate
          ? `Expected "${selector ?? 'body'}" not to ${check.description}, but its text is ${describeValue(actual)}.`
          : `Expected "${selector ?? 'body'}" to ${check.description}, but its text is ${describeValue(actual)}.`,
      );
    }
    return actual;
  },

  async assertCount(ctx) {
    const selector = requireString(ctx, 'selector');
    const count = await page(ctx).locator(selector).count();
    const equals = optionalNumber(ctx, 'equals');
    const atLeast = optionalNumber(ctx, 'atLeast');
    const atMost = optionalNumber(ctx, 'atMost');
    if (equals != null && count !== equals) {
      throw new AssertionError(`Expected ${equals} element(s) matching "${selector}", found ${count}.`);
    }
    if (atLeast != null && count < atLeast) {
      throw new AssertionError(`Expected at least ${atLeast} element(s) matching "${selector}", found ${count}.`);
    }
    if (atMost != null && count > atMost) {
      throw new AssertionError(`Expected at most ${atMost} element(s) matching "${selector}", found ${count}.`);
    }
    return count;
  },

  async assertUrl(ctx) {
    const actual = page(ctx).url();
    const check = compareText(ctx, actual);
    if (!check.ok) {
      throw new AssertionError(`Expected the ${ctx.target} URL to ${check.description}, but it is ${describeValue(actual)}.`);
    }
    return actual;
  },

  async assertStorage(ctx) {
    const key = requireString(ctx, 'key');
    const area = (optionalString(ctx, 'area') ?? 'local') as 'local' | 'sync' | 'session';
    const actual = await ctx.session.storageGet(key, area);

    if ('exists' in ctx.options) {
      const shouldExist = ctx.options['exists'] !== false;
      const exists = actual !== undefined;
      if (exists !== shouldExist) {
        throw new AssertionError(
          shouldExist
            ? `Expected chrome.storage.${area}["${key}"] to exist, but it is unset.`
            : `Expected chrome.storage.${area}["${key}"] to be unset, but it is ${describeValue(actual)}.`,
        );
      }
      if (!('equals' in ctx.options) && !('contains' in ctx.options)) return actual;
    }

    if ('equals' in ctx.options && !deepEqual(actual, ctx.options['equals'])) {
      throw new AssertionError(
        `Expected chrome.storage.${area}["${key}"] to equal ${describeValue(ctx.options['equals'])}, but it is ${describeValue(actual)}.`,
      );
    }
    if ('contains' in ctx.options) {
      const needle = ctx.options['contains'];
      const ok = Array.isArray(actual)
        ? actual.some((item) => deepEqual(item, needle))
        : typeof actual === 'string' && String(needle) !== ''
          ? actual.includes(String(needle))
          : typeof actual === 'object' && actual !== null && typeof needle === 'object' && needle !== null
            ? Object.entries(needle).every(([k, v]) => deepEqual((actual as Record<string, unknown>)[k], v))
            : false;
      if (!ok) {
        throw new AssertionError(
          `Expected chrome.storage.${area}["${key}"] to contain ${describeValue(needle)}, but it is ${describeValue(actual)}.`,
        );
      }
    }
    return actual;
  },

  /**
   * Assert nothing logged an error.
   *
   * By default this covers every context, which is what you want against a fixture. Against a
   * live third-party site it is too broad — the site's own errors have nothing to do with the
   * extension and change without warning — so `contexts` narrows it to the extension's own
   * surfaces.
   */
  async assertNoConsoleErrors(ctx) {
    await ctx.session.drainWorkerConsole();
    const rawIgnore = ctx.options['ignore'];
    const ignore = (Array.isArray(rawIgnore) ? rawIgnore : rawIgnore ? [rawIgnore] : []).map(String);
    const rawContexts = ctx.options['contexts'];
    const contexts = (Array.isArray(rawContexts) ? rawContexts : rawContexts ? [rawContexts] : []).map(String);

    const errors = ctx.session.console.filter(
      (e) =>
        e.type === 'error' &&
        (contexts.length === 0 || contexts.includes(e.context)) &&
        !ignore.some((pattern) => matchesLoose(e.text, pattern)),
    );
    if (errors.length) {
      const shown = errors.slice(0, 5).map((e) => `  [${e.context}] ${e.text}`).join('\n');
      const more = errors.length > 5 ? `\n  …and ${errors.length - 5} more` : '';
      const scope = contexts.length ? ` in ${contexts.join(', ')}` : '';
      throw new AssertionError(`${errors.length} console error(s)${scope}:\n${shown}${more}`);
    }
    return 0;
  },

  async assertDownload(ctx) {
    const pattern = optionalString(ctx, 'pattern') ?? '*';
    const minBytes = optionalNumber(ctx, 'minBytes');
    const hit = ctx.session.latestDownload(pattern);
    if (!hit) {
      const seen = ctx.session.downloads.map((d) => d.filename);
      throw new AssertionError(
        `No download matching "${pattern}".` +
          (seen.length ? ` Downloads seen: ${seen.join(', ')}.` : ' No downloads occurred.'),
      );
    }
    if (minBytes != null && (hit.bytes ?? 0) < minBytes) {
      throw new AssertionError(
        `Download "${hit.filename}" is ${hit.bytes ?? 0} bytes, expected at least ${minBytes}.`,
      );
    }
    return { filename: hit.filename, bytes: hit.bytes };
  },

  async assertPermission(ctx) {
    const permission = requireString(ctx, 'permission');
    const held = await ctx.session.hasPermission(permission);
    const expectMissing = optionalBoolean(ctx, 'not');
    if (held === expectMissing) {
      throw new AssertionError(
        expectMissing
          ? `Expected the extension not to hold the "${permission}" permission, but it does.`
          : `Expected the extension to hold the "${permission}" permission, but it does not. Declared: ${ctx.session.extension.permissions.join(', ') || 'none'}.`,
      );
    }
    return held;
  },

  async expect(ctx) {
    const actual = 'value' in ctx.options ? ctx.options['value'] : ctx.last;
    if (optionalBoolean(ctx, 'truthy') && !actual) {
      throw new AssertionError(`Expected a truthy value, got ${describeValue(actual)}.`);
    }
    if ('equals' in ctx.options && !deepEqual(actual, ctx.options['equals'])) {
      throw new AssertionError(
        `Expected ${describeValue(ctx.options['equals'])}, got ${describeValue(actual)}.`,
      );
    }
    if ('contains' in ctx.options) {
      const needle = ctx.options['contains'];
      const ok = Array.isArray(actual)
        ? actual.some((item) => deepEqual(item, needle))
        : typeof actual === 'string' && actual.includes(String(needle));
      if (!ok) throw new AssertionError(`Expected ${describeValue(actual)} to contain ${describeValue(needle)}.`);
    }
    if ('matches' in ctx.options) {
      const pattern = String(ctx.options['matches']);
      if (!matchesPattern(String(actual), pattern)) {
        throw new AssertionError(`Expected ${describeValue(actual)} to match ${pattern}.`);
      }
    }
    return actual;
  },
};

/** Shared `equals` / `contains` / `matches` handling for text-shaped assertions. */
function compareText(ctx: StepContext, actual: string): { ok: boolean; description: string } {
  if ('equals' in ctx.options) {
    const expected = String(ctx.options['equals']);
    return { ok: actual === expected, description: `equal ${describeValue(expected)}` };
  }
  if ('contains' in ctx.options) {
    const expected = String(ctx.options['contains']);
    return { ok: actual.includes(expected), description: `contain ${describeValue(expected)}` };
  }
  if ('matches' in ctx.options) {
    const pattern = String(ctx.options['matches']);
    return { ok: matchesPattern(actual, pattern), description: `match ${pattern}` };
  }
  return { ok: actual.length > 0, description: 'be non-empty' };
}

/**
 * When a selector does not match, say what is actually there. This turns the single most common
 * failure — a renamed id — from a timeout into a diagnosis.
 */
async function nearMiss(ctx: StepContext, selector: string): Promise<string> {
  try {
    const target = page(ctx);
    const count = await target.locator(selector).count();
    if (count > 0) return ` The selector matches ${count} element(s), but none are visible.`;
    const ids = await target.evaluate(() =>
      [...document.querySelectorAll('[id]')].slice(0, 15).map((el) => `#${el.id}`),
    );
    return ids.length ? ` Elements present: ${ids.join(', ')}.` : ' The document has no elements with ids.';
  } catch {
    return '';
  }
}
