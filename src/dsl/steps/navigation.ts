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
    await ctx.session.navigate(ctx.target, url, { waitUntil, timeout: ctx.timeout });
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

  async openSidePanel(ctx) {
    const panel = await ctx.session.openSidePanel();
    ctx.note(panel.url());
    return undefined;
  },

  async openDevtoolsPage(ctx) {
    const devtools = await ctx.session.openDevtoolsPage();
    ctx.note(devtools.url());
    return undefined;
  },

  async openBackground(ctx) {
    const background = await ctx.session.backgroundPage(ctx.timeout);
    ctx.session.active = 'background';
    ctx.note(background.url());
    return undefined;
  },

  async closePopup(ctx) {
    await ctx.session.closePopup();
    return undefined;
  },

  async closeOtherTabs(ctx) {
    const closed = await ctx.session.closeOtherTabs(ctx.target);
    ctx.note(`closed ${closed} tab${closed === 1 ? '' : 's'}`);
    return closed;
  },

  async triggerAction(ctx) {
    await ctx.session.triggerAction();
    return undefined;
  },

  async triggerCommand(ctx) {
    const command = requireString(ctx, 'command');
    const key = await ctx.session.triggerCommand(command);
    ctx.note(key);
    return undefined;
  },

  async createOffscreenDocument(ctx) {
    const url = requireString(ctx, 'url');
    const justification = requireString(ctx, 'justification');
    const rawReasons = ctx.options['reasons'];
    const reasons = (Array.isArray(rawReasons) ? rawReasons : [rawReasons]).filter(
      (reason): reason is string => typeof reason === 'string' && reason.length > 0,
    );
    if (!reasons.length) throw new Error('createOffscreenDocument requires at least one reason.');
    await ctx.session.createOffscreenDocument(url, reasons, justification);
    return undefined;
  },

  async closeOffscreenDocument(ctx) {
    await ctx.session.closeOffscreenDocument();
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
    // A download may already have landed after the action but before this step ran, so check the
    // log first. Start after the previous successful wait so two waits cannot consume one file.
    while (Date.now() < deadline) {
      const hit = ctx.session.latestDownload(pattern, false, ctx.downloadStart);
      if (hit) {
        ctx.consumeDownload(ctx.session.downloads.indexOf(hit));
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
