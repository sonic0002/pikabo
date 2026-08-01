import { matchesPattern } from '../../util/match.js';
import {
  optionalNumber,
  optionalString,
  page,
  requireString,
  type StepHandler,
} from './types.js';

export const navigationSteps: Record<string, StepHandler> = {
  async navigate(ctx) {
    const url = requireString(ctx, 'url');
    const waitUntil = (optionalString(ctx, 'waitUntil') ?? 'load') as 'load' | 'domcontentloaded' | 'networkidle';
    await page(ctx).goto(url, { waitUntil, timeout: ctx.timeout });
    return undefined;
  },

  async openPopup(ctx) {
    const popup = await ctx.session.openPopup({
      width: optionalNumber(ctx, 'width'),
      height: optionalNumber(ctx, 'height'),
      keepPageActive: ctx.options['keepPageActive'] !== false,
    });
    ctx.note(popup.url());
    return undefined;
  },

  async openOptions(ctx) {
    const options = await ctx.session.openOptions();
    ctx.note(options.url());
    return undefined;
  },

  async closePopup(ctx) {
    await ctx.session.closePopup();
    return undefined;
  },

  async reloadExtension(ctx) {
    await ctx.session.reloadExtension();
    return undefined;
  },

  async newTab(ctx) {
    const url = optionalString(ctx, 'url');
    const name = optionalString(ctx, 'name');
    const tab = await ctx.session.newTab(url, name);
    ctx.note(name ? `${name} → ${tab.url()}` : tab.url());
    return undefined;
  },

  async switchTo(ctx) {
    const name = requireString(ctx, 'context');
    if (name !== 'worker' && !ctx.session.has(name)) {
      throw new Error(
        `No context named "${name}" is open. Open it with openPopup, openOptions or newTab first.`,
      );
    }
    ctx.session.active = name;
    return undefined;
  },

  async wait(ctx) {
    const ms = optionalNumber(ctx, 'ms') ?? 0;
    await new Promise((r) => setTimeout(r, ms));
    return undefined;
  },

  async waitFor(ctx) {
    const selector = requireString(ctx, 'selector');
    const state = (optionalString(ctx, 'state') ?? 'visible') as 'attached' | 'detached' | 'visible' | 'hidden';
    await page(ctx).waitForSelector(selector, { state, timeout: ctx.timeout });
    return undefined;
  },

  async waitForText(ctx) {
    const text = requireString(ctx, 'text');
    const selector = optionalString(ctx, 'selector');
    const locator = selector
      ? page(ctx).locator(selector).filter({ hasText: text })
      : page(ctx).getByText(text, { exact: false });
    await locator.first().waitFor({ state: 'visible', timeout: ctx.timeout });
    return undefined;
  },

  async waitForUrl(ctx) {
    const pattern = requireString(ctx, 'pattern');
    const target = page(ctx);
    await target.waitForURL((url) => matchesPattern(url.toString(), pattern), { timeout: ctx.timeout });
    return target.url();
  },

  async waitForDownload(ctx) {
    const pattern = optionalString(ctx, 'pattern') ?? '*';
    const deadline = Date.now() + ctx.timeout;
    // A download may already have landed before this step ran — check the log first.
    while (Date.now() < deadline) {
      const hit = ctx.session.downloads.find((d) => matchesPattern(d.filename, pattern));
      if (hit) {
        ctx.note(`${hit.filename}${hit.bytes != null ? ` (${hit.bytes} bytes)` : ''}`);
        return { filename: hit.filename, path: hit.path, bytes: hit.bytes };
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    const seen = ctx.session.downloads.map((d) => d.filename);
    throw new Error(
      `No download matching "${pattern}" within ${ctx.timeout}ms.` +
        (seen.length ? ` Downloads seen: ${seen.join(', ')}.` : ' No downloads occurred at all.'),
    );
  },
};
