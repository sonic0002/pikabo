import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { BrowserContext, Download, Page, Worker } from 'playwright-core';
import { attachWorkerConsole, type CdpConsole } from './cdp-console.js';
import { extensionUrl, resolveExtension, waitForServiceWorker } from './extension.js';
import { launchBrowser, type LaunchOptions, type LaunchedBrowser } from './launcher.js';
import type { ConsoleEntry, ContextName, ExtensionInfo } from '../types.js';

export interface DownloadRecord {
  filename: string;
  path?: string;
  bytes?: number;
  timestamp: number;
}

export interface SessionOptions extends LaunchOptions {
  /** Default popup viewport, used when the manifest does not imply one. */
  popupSize?: { width: number; height: number };
}

/**
 * A live browser with one extension loaded, plus everything a test needs to address it:
 * named contexts, a merged console stream, and a download log.
 *
 * The session owns naming. Steps say `in: popup`; the session decides what that means and
 * creates the page lazily the first time it is asked for.
 */
export class Session {
  readonly pages = new Map<string, Page>();
  readonly console: ConsoleEntry[] = [];
  readonly downloads: DownloadRecord[] = [];
  active: ContextName = 'page';

  private workerRef?: Worker;
  private workerPatched = false;
  private readonly watched = new WeakMap<Page, { label: string }>();
  private cdpConsole?: CdpConsole;

  private constructor(
    readonly browser: LaunchedBrowser,
    readonly extension: ExtensionInfo,
    readonly options: SessionOptions,
  ) {}

  static async start(options: SessionOptions): Promise<Session> {
    const browser = await launchBrowser(options);
    let extension: ExtensionInfo;
    try {
      extension = await resolveExtension(browser.context, options.extensionPath);
    } catch (err) {
      await browser.close();
      throw err;
    }
    const session = new Session(browser, extension, options);
    await session.attach();
    return session;
  }

  get context(): BrowserContext {
    return this.browser.context;
  }

  private async attach(): Promise<void> {
    const ctx = this.browser.context;

    // Preferred: capture the worker's console over CDP, which includes anything logged or thrown
    // before we could have installed a wrapper. Falls back to in-worker patching.
    if (this.options.debugPort !== false) {
      this.cdpConsole = await attachWorkerConsole(this.browser.profileDir, (entry) =>
        this.console.push(entry),
      ).catch(() => undefined);
    }

    for (const page of ctx.pages()) this.watchPage(page, 'page');
    ctx.on('page', (page) => this.watchPage(page, this.labelFor(page)));
    ctx.on('serviceworker', (worker) => {
      this.workerRef = worker;
      this.workerPatched = false;
      void this.patchWorkerConsole().catch(() => undefined);
    });

    if (this.extension.hasServiceWorker) {
      this.workerRef = await waitForServiceWorker(ctx, 10_000).catch(() => undefined);
      await this.patchWorkerConsole().catch(() => undefined);
    }

    // The first about:blank page that a persistent context opens is our default `page`.
    const first = ctx.pages()[0] ?? (await ctx.newPage());
    this.pages.set('page', first);
  }

  private labelFor(page: Page): string {
    const url = page.url();
    if (this.extension.popup && url.includes(this.extension.popup)) return 'popup';
    if (this.extension.optionsPage && url.includes(this.extension.optionsPage)) return 'options';
    return `tab${this.pages.size}`;
  }

  /**
   * Attach console/error/download listeners exactly once per page.
   *
   * A page is seen twice: the context's `page` event fires while it is still `about:blank`, and
   * again when a caller names it (`popup`, `options`, a tab name). Listeners are attached on the
   * first sighting and read the label out of a mutable box, so a later rename relabels entries
   * that have not been logged yet without producing a second listener — and a second copy of
   * every message.
   */
  private watchPage(page: Page, label: string): void {
    const existing = this.watched.get(page);
    if (existing) {
      existing.label = label;
      return;
    }
    const box = { label };
    this.watched.set(page, box);

    page.on('console', (msg) => {
      this.console.push({
        context: box.label,
        type: msg.type(),
        text: msg.text(),
        timestamp: Date.now(),
        location: formatLocation(msg.location()),
      });
    });
    page.on('pageerror', (err) => {
      this.console.push({
        context: box.label,
        type: 'error',
        text: `${err.name}: ${err.message}`,
        timestamp: Date.now(),
      });
    });
    page.on('download', (download) => void this.recordDownload(download));
  }

  private async recordDownload(download: Download): Promise<void> {
    const dir = join(this.options.artifactsDir ?? process.cwd(), 'downloads');
    mkdirSync(dir, { recursive: true });
    const target = join(dir, download.suggestedFilename());
    const record: DownloadRecord = {
      filename: download.suggestedFilename(),
      timestamp: Date.now(),
    };
    this.downloads.push(record);
    try {
      await download.saveAs(target);
      record.path = target;
      const { statSync } = await import('node:fs');
      record.bytes = statSync(target).size;
    } catch {
      /* a cancelled download still counts as an observed event */
    }
  }

  /**
   * Service workers have no console event in Playwright, so the worker's own console is wrapped
   * and drained on demand. Messages logged before this runs — during the worker's very first
   * evaluation — are not captured.
   */
  private async patchWorkerConsole(): Promise<void> {
    const worker = this.workerRef;
    if (!worker || this.workerPatched || this.cdpConsole) return;
    await worker.evaluate(() => {
      const scope = self as unknown as { __extTestLogs?: unknown[] };
      if (scope.__extTestLogs) return;
      const logs: unknown[] = [];
      scope.__extTestLogs = logs;
      const push = (type: string, text: string) => logs.push({ type, text, t: Date.now() });
      for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) {
        const original = console[level].bind(console);
        console[level] = (...args: unknown[]) => {
          push(level, args.map((a) => safeString(a)).join(' '));
          original(...args);
        };
      }
      self.addEventListener('error', (e) => push('error', `${(e as ErrorEvent).message}`));
      self.addEventListener('unhandledrejection', (e) =>
        push('error', `Unhandled rejection: ${safeString((e as PromiseRejectionEvent).reason)}`),
      );
      function safeString(value: unknown): string {
        if (value instanceof Error) return `${value.name}: ${value.message}`;
        if (typeof value === 'object' && value !== null) {
          try {
            return JSON.stringify(value);
          } catch {
            return String(value);
          }
        }
        return String(value);
      }
    });
    this.workerPatched = true;
  }

  /**
   * Pull anything the service worker has logged since the last drain into the merged stream.
   * A no-op when CDP capture is active, since that delivers entries as they happen.
   */
  async drainWorkerConsole(): Promise<void> {
    const worker = this.workerRef;
    if (this.cdpConsole || !worker || !this.workerPatched) return;
    const entries = await worker
      .evaluate(() => {
        const scope = self as unknown as { __extTestLogs?: { type: string; text: string; t: number }[] };
        const out = scope.__extTestLogs ?? [];
        scope.__extTestLogs = [];
        return out;
      })
      .catch(() => [] as { type: string; text: string; t: number }[]);
    for (const e of entries) {
      this.console.push({ context: 'worker', type: e.type, text: e.text, timestamp: e.t });
    }
  }

  async worker(): Promise<Worker> {
    if (this.workerRef && !isWorkerGone(this.workerRef)) return this.workerRef;
    if (!this.extension.hasServiceWorker) {
      throw new Error(
        `${this.extension.name} declares no background service worker, so there is no "worker" context to act on.`,
      );
    }
    this.workerRef = await waitForServiceWorker(this.browser.context, 15_000);
    this.workerPatched = false;
    await this.patchWorkerConsole().catch(() => undefined);
    return this.workerRef;
  }

  /**
   * MV3 workers idle out after ~30s. Any call into the worker wakes it first, so a test that
   * pauses does not fail on a dead target.
   */
  async wakeWorker(): Promise<Worker> {
    const worker = await this.worker();
    try {
      await worker.evaluate(() => true);
      return worker;
    } catch {
      this.workerRef = undefined;
      this.workerPatched = false;
      return await this.worker();
    }
  }

  page(name: ContextName = this.active): Page {
    const page = this.pages.get(name === 'worker' ? 'page' : name);
    if (!page) {
      throw new Error(
        `No context named "${name}". Open it first (openPopup / openOptions / newTab), or use one of: ${[...this.pages.keys()].join(', ')}.`,
      );
    }
    if (page.isClosed()) throw new Error(`The "${name}" context has been closed.`);
    return page;
  }

  has(name: ContextName): boolean {
    const page = this.pages.get(name);
    return Boolean(page && !page.isClosed());
  }

  async openPopup(size?: { width?: number; height?: number }): Promise<Page> {
    if (!this.extension.popup) {
      throw new Error(
        `${this.extension.name} declares no popup (no action.default_popup in manifest.json), so openPopup has nothing to open.`,
      );
    }
    const existing = this.pages.get('popup');
    if (existing && !existing.isClosed()) {
      this.active = 'popup';
      return existing;
    }
    const page = await this.browser.context.newPage();
    this.watchPage(page, 'popup');
    const dims = {
      width: size?.width ?? this.options.popupSize?.width ?? 400,
      height: size?.height ?? this.options.popupSize?.height ?? 600,
    };
    await page.setViewportSize(dims);
    await page.goto(extensionUrl(this.extension, this.extension.popup), { waitUntil: 'domcontentloaded' });
    this.pages.set('popup', page);
    this.active = 'popup';
    return page;
  }

  async openOptions(): Promise<Page> {
    if (!this.extension.optionsPage) {
      throw new Error(
        `${this.extension.name} declares no options page (no options_ui.page or options_page in manifest.json).`,
      );
    }
    const existing = this.pages.get('options');
    if (existing && !existing.isClosed()) {
      this.active = 'options';
      return existing;
    }
    const page = await this.browser.context.newPage();
    this.watchPage(page, 'options');
    await page.goto(extensionUrl(this.extension, this.extension.optionsPage), {
      waitUntil: 'domcontentloaded',
    });
    this.pages.set('options', page);
    this.active = 'options';
    return page;
  }

  async closePopup(): Promise<void> {
    const page = this.pages.get('popup');
    if (page && !page.isClosed()) await page.close();
    this.pages.delete('popup');
    if (this.active === 'popup') this.active = 'page';
  }

  async newTab(url?: string, name?: string): Promise<Page> {
    const page = await this.browser.context.newPage();
    const label = name ?? `tab${this.pages.size}`;
    this.watchPage(page, label);
    if (url) await page.goto(url, { waitUntil: 'domcontentloaded' });
    this.pages.set(label, page);
    this.active = label;
    return page;
  }

  /** Evaluate a source string in a context, returning a JSON-safe value. */
  async evaluate(context: ContextName, script: string, args?: unknown): Promise<unknown> {
    const fn = compileScript(script);
    if (context === 'worker') {
      const worker = await this.wakeWorker();
      return await worker.evaluate(fn, args);
    }
    return await this.page(context).evaluate(fn, args);
  }

  async storageGet(key: string, area: 'local' | 'sync' | 'session' = 'local'): Promise<unknown> {
    const worker = await this.wakeWorker();
    return await worker.evaluate(
      async ({ key, area }) => {
        const store = (chrome.storage as unknown as Record<string, chrome.storage.StorageArea>)[area];
        if (!store) throw new Error(`chrome.storage.${area} is not available`);
        const result = await store.get(key);
        return (result as Record<string, unknown>)[key];
      },
      { key, area },
    );
  }

  async storageSet(key: string, value: unknown, area: 'local' | 'sync' | 'session' = 'local'): Promise<void> {
    const worker = await this.wakeWorker();
    await worker.evaluate(
      async ({ key, value, area }) => {
        const store = (chrome.storage as unknown as Record<string, chrome.storage.StorageArea>)[area];
        if (!store) throw new Error(`chrome.storage.${area} is not available`);
        await store.set({ [key]: value });
      },
      { key, value, area },
    );
  }

  async storageClear(area: 'local' | 'sync' | 'session' = 'local'): Promise<void> {
    const worker = await this.wakeWorker();
    await worker.evaluate(async ({ area }) => {
      const store = (chrome.storage as unknown as Record<string, chrome.storage.StorageArea>)[area];
      if (store) await store.clear();
    }, { area });
  }

  async hasPermission(permission: string): Promise<boolean> {
    const worker = await this.wakeWorker();
    return await worker.evaluate(
      async (p) => await chrome.permissions.contains({ permissions: [p] }).catch(() => false),
      permission,
    );
  }

  /** Reload the extension and wait for a fresh service worker. */
  async reloadExtension(): Promise<void> {
    const worker = await this.wakeWorker();
    await worker.evaluate(() => chrome.runtime.reload()).catch(() => undefined);
    this.workerRef = undefined;
    this.workerPatched = false;
    await new Promise((r) => setTimeout(r, 500));
    if (this.extension.hasServiceWorker) await this.worker();
  }

  /** Reset per-test state without paying to relaunch the browser. */
  async reset(): Promise<void> {
    for (const [name, page] of [...this.pages]) {
      if (name === 'page') continue;
      await page.close().catch(() => undefined);
      this.pages.delete(name);
    }
    this.active = 'page';
    this.console.length = 0;
    this.downloads.length = 0;
    const main = this.pages.get('page');
    if (main && !main.isClosed()) await main.goto('about:blank').catch(() => undefined);
  }

  async close(): Promise<void> {
    this.cdpConsole?.close();
    await this.browser.close();
  }
}

function isWorkerGone(worker: Worker): boolean {
  // Playwright does not expose a closed flag on Worker; a dead worker throws on evaluate, which
  // wakeWorker() handles. This exists so the fast path stays a pure property read.
  return !worker.url();
}

function formatLocation(loc: { url: string; lineNumber: number; columnNumber: number } | undefined): string | undefined {
  if (!loc?.url) return undefined;
  return `${loc.url}:${loc.lineNumber}:${loc.columnNumber}`;
}

/**
 * Turn a script from a YAML step into a function Playwright will actually call.
 *
 * A string handed to `evaluate` is treated as a bare expression and never invoked, so the
 * function is built here in Node; Playwright stringifies it and calls it with the step's `args`.
 * Both forms are accepted: an expression (`document.title`) and a statement body
 * (`const x = 1; return x`), distinguished by a `return` or a statement separator.
 */
export function compileScript(script: string): (args: unknown) => unknown {
  const trimmed = script.trim();
  const isBody = /\breturn\b/.test(trimmed) || /;\s*\S/.test(trimmed);
  const body = isBody ? trimmed : `return (${trimmed});`;
  try {
    return new Function('args', `return (async () => { ${body} })();`) as (args: unknown) => unknown;
  } catch (err) {
    throw new Error(`eval script is not valid JavaScript: ${(err as Error).message}\n\n${trimmed}`);
  }
}
