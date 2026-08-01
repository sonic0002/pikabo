import { resolve } from 'node:path';
import {
  optionalBoolean,
  optionalNumber,
  optionalString,
  page,
  requireString,
  type StepHandler,
} from './types.js';

export const interactionSteps: Record<string, StepHandler> = {
  async click(ctx) {
    const selector = requireString(ctx, 'selector');
    await page(ctx).click(selector, {
      timeout: ctx.timeout,
      button: (optionalString(ctx, 'button') ?? 'left') as 'left' | 'right' | 'middle',
      clickCount: optionalNumber(ctx, 'clickCount') ?? 1,
      force: optionalBoolean(ctx, 'force'),
    });
    return undefined;
  },

  async fill(ctx) {
    const selector = requireString(ctx, 'selector');
    const value = ctx.options['value'];
    await page(ctx).fill(selector, value == null ? '' : String(value), { timeout: ctx.timeout });
    return undefined;
  },

  async type(ctx) {
    const selector = requireString(ctx, 'selector');
    const text = requireString(ctx, 'text');
    const locator = page(ctx).locator(selector);
    await locator.click({ timeout: ctx.timeout });
    await locator.pressSequentially(text, { delay: optionalNumber(ctx, 'delay') ?? 20 });
    return undefined;
  },

  async press(ctx) {
    const key = requireString(ctx, 'key');
    const selector = optionalString(ctx, 'selector');
    if (selector) await page(ctx).press(selector, key, { timeout: ctx.timeout });
    else await page(ctx).keyboard.press(key);
    return undefined;
  },

  async select(ctx) {
    const selector = requireString(ctx, 'selector');
    const raw = ctx.options['value'];
    const values = Array.isArray(raw) ? raw.map(String) : [String(raw)];
    await page(ctx).selectOption(selector, values, { timeout: ctx.timeout });
    return undefined;
  },

  async check(ctx) {
    await page(ctx).check(requireString(ctx, 'selector'), { timeout: ctx.timeout });
    return undefined;
  },

  async uncheck(ctx) {
    await page(ctx).uncheck(requireString(ctx, 'selector'), { timeout: ctx.timeout });
    return undefined;
  },

  async hover(ctx) {
    await page(ctx).hover(requireString(ctx, 'selector'), { timeout: ctx.timeout });
    return undefined;
  },

  async scroll(ctx) {
    const selector = optionalString(ctx, 'selector');
    const x = optionalNumber(ctx, 'x') ?? 0;
    const y = optionalNumber(ctx, 'y') ?? 0;
    if (selector) {
      await page(ctx).locator(selector).evaluate((el, { x, y }) => el.scrollBy(x, y), { x, y });
    } else {
      await page(ctx).evaluate(({ x, y }) => window.scrollBy(x, y), { x, y });
    }
    return undefined;
  },

  async upload(ctx) {
    const selector = requireString(ctx, 'selector');
    const raw = ctx.options['files'];
    const files = (Array.isArray(raw) ? raw : [raw]).map((f) => resolve(String(f)));
    await page(ctx).setInputFiles(selector, files, { timeout: ctx.timeout });
    return undefined;
  },

  async eval(ctx) {
    const script = requireString(ctx, 'script');
    return await ctx.session.evaluate(ctx.target, script, ctx.options['args']);
  },

  async setStorage(ctx) {
    const key = requireString(ctx, 'key');
    const area = (optionalString(ctx, 'area') ?? 'local') as 'local' | 'sync' | 'session';
    await ctx.session.storageSet(key, ctx.options['value'], area);
    return undefined;
  },

  async clearStorage(ctx) {
    const area = (optionalString(ctx, 'area') ?? 'local') as 'local' | 'sync' | 'session';
    await ctx.session.storageClear(area);
    return undefined;
  },
};
