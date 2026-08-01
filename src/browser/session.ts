import { mkdirSync, mkdtempSync, renameSync, rmSync, statSync, watch, type FSWatcher } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrowserContext, Download, Page, Worker } from 'playwright-core';
import { attachWorkerConsole, type CdpConsole } from './cdp-console.js';
import { extensionUrl, resolveExtension, waitForServiceWorker } from './extension.js';
import { launchBrowser, type LaunchOptions, type LaunchedBrowser } from './launcher.js';
import type { ConsoleEntry, ContextName, ExtensionInfo } from '../types.js';
import { matchesPattern } from '../util/match.js';

export interface DownloadRecord {
  /** Chrome's download id, when the download came from chrome.downloads. */
  id?: number;
  filename: string;
  path?: string;
  bytes?: number;
  timestamp: number;
}

interface IntendedDownload {
  id: number;
  path: string;
  requested: string;
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
  private downloadWatcher?: FSWatcher;
  /** True when Chrome itself was told to write downloads into our directory. */
  private downloadsRedirected = false;
  private downloadsPatched = false;
  private readonly settling = new Set<string>();
  private readonly restoredDownloadIds = new Set<number>();
  private readonly downloadSignatures = new Set<string>();
  private fallbackArtifacts?: string;

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
      this.cdpConsole = await attachWorkerConsole(
        this.browser.profileDir,
        (entry) => this.console.push(entry),
        { downloadPath: this.downloadDir() },
      ).catch(() => undefined);
      this.downloadsRedirected = Boolean(this.cdpConsole);
    }
    this.watchDownloadDir();

    for (const page of ctx.pages()) this.watchPage(page, 'page');
    ctx.on('page', (page) => this.watchPage(page, this.labelFor(page)));
    ctx.on('serviceworker', (worker) => {
      this.workerRef = worker;
      void this.reinstrumentWorker();
    });

    if (this.extension.hasServiceWorker) {
      this.workerRef = await waitForServiceWorker(ctx, 10_000).catch(() => undefined);
      await this.patchWorkerConsole().catch(() => undefined);
      await this.patchWorkerDownloads().catch(() => undefined);
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

  /**
   * Where downloads land.
   *
   * Falls back to a temporary directory rather than the working directory: a library caller who
   * never asked for artefacts should not find a `downloads/` folder appearing in their
   * repository. The CLI always passes `artifactsDir`, so this only affects direct API use.
   */
  downloadDir(): string {
    this.fallbackArtifacts ??= mkdtempSync(join(tmpdir(), 'ext-test-artifacts-'));
    return join(this.options.artifactsDir ?? this.fallbackArtifacts, 'downloads');
  }

  /**
   * Record a download a page told us about.
   *
   * When Chrome has been redirected to write into our directory, it owns the file — calling
   * `saveAs` here would race the browser's own write over the same path and can leave a
   * zero-byte result. In that mode the directory watcher records the path and final size, and
   * this handler does nothing but let the watcher get there first.
   */
  private async recordDownload(download: Download): Promise<void> {
    if (this.downloadsRedirected) return;

    const dir = this.downloadDir();
    mkdirSync(dir, { recursive: true });
    const name = download.suggestedFilename();
    const target = join(dir, name);
    const record: DownloadRecord = { filename: name, timestamp: Date.now() };
    this.downloads.push(record);
    try {
      await download.saveAs(target);
      record.path = target;
      record.bytes = statSync(target).size;
    } catch {
      /* a cancelled download still counts as an observed event */
    }
  }

  /**
   * Notice files Chrome writes without telling any page about them.
   *
   * `chrome.downloads.download()` from a service worker never surfaces as a page download event,
   * so an extension that saves its output from the background — which is most of them — would
   * otherwise look like it did nothing. Downloads are pointed at one directory at launch, and
   * anything appearing there that no page claimed is recorded here.
   */
  private watchDownloadDir(): void {
    const dir = this.downloadDir();
    mkdirSync(dir, { recursive: true });
    try {
      this.downloadWatcher = watch(dir, (_event, filename) => {
        if (!filename) return;
        const name = String(filename);
        // Chrome writes to `<name>.crdownload` until the transfer finishes.
        if (name.endsWith('.crdownload') || name.startsWith('.')) return;
        void this.settleDownload(join(dir, name), name);
      });
    } catch {
      /* watching is an enhancement; page-initiated downloads are still recorded */
    }
  }

  /**
   * Remember the filename each `chrome.downloads.download()` call asked for.
   *
   * Redirecting downloads into the test's own directory makes Chrome rename every file to
   * `download.<ext>` — the extension's chosen name is discarded before it reaches disk, and even
   * `chrome.downloads.search()` reports the flattened name. Recording the request lets the file
   * be put back under the name the extension meant, so a suite can assert on it.
   */
  private async patchWorkerDownloads(): Promise<void> {
    const worker = this.workerRef;
    if (!worker || this.downloadsPatched) return;
    const patched = await worker
      .evaluate(() => {
        const scope = self as unknown as { __extTestDownloads?: { id: number; requested?: string }[] };
        if (scope.__extTestDownloads) return true;
        const api = (chrome as unknown as { downloads?: Record<string, unknown> }).downloads;
        if (!api || typeof api['download'] !== 'function') return false;

        const requests: { id: number; requested?: string }[] = [];
        scope.__extTestDownloads = requests;
        const original = (api['download'] as (o: unknown, cb?: (id: number) => void) => unknown).bind(api);
        api['download'] = (options: { filename?: string }, callback?: (id: number) => void) => {
          const requested = options?.filename;
          const wrappedCallback = callback
            ? (id: number) => {
                requests.push({ id, requested });
                callback(id);
              }
            : undefined;
          const result = original(options, wrappedCallback) as Promise<number> | number | undefined;
          if (result && typeof (result as Promise<number>).then === 'function') {
            void (result as Promise<number>).then((id) => requests.push({ id, requested })).catch(() => {});
          }
          return result;
        };
        return true;
      })
      .catch(() => false);
    this.downloadsPatched = patched;
  }

  /**
   * Ask the worker which on-disk file corresponds to which requested filename.
   * Correlation is by download id, so there is no guessing when several downloads overlap.
   */
  private async intendedDownloads(): Promise<IntendedDownload[]> {
    const worker = this.workerRef;
    if (!worker || !this.downloadsPatched) return [];
    return await worker
      .evaluate(async () => {
        const scope = self as unknown as { __extTestDownloads?: { id: number; requested?: string }[] };
        const requests = scope.__extTestDownloads ?? [];
        if (!requests.length) return [] as { id: number; path: string; requested: string }[];
        const api = chrome as unknown as {
          downloads: { search: (q: unknown, cb: (items: { id: number; filename: string }[]) => void) => void };
        };
        const items = await new Promise<{ id: number; filename: string }[]>((resolve) =>
          api.downloads.search({}, resolve),
        );
        const out: { id: number; path: string; requested: string }[] = [];
        for (const item of items) {
          const request = requests.find((r) => r.id === item.id);
          if (request?.requested && item.filename) {
            out.push({ id: item.id, path: item.filename, requested: request.requested });
          }
        }
        return out;
      })
      .catch(() => [] as IntendedDownload[]);
  }

  /**
   * Put a redirected download back under the name the extension asked for. Best effort: if the
   * mapping is unavailable the flattened name stands, which is still a usable artefact.
   */
  private async restoreIntendedName(
    path: string,
    name: string,
  ): Promise<{ id?: number; filename: string; path: string }> {
    try {
      const intended = await this.intendedDownloads();
      const match = intended
        .filter((item) => item.path === path && !this.restoredDownloadIds.has(item.id))
        .sort((a, b) => b.id - a.id)[0];
      if (!match) return { filename: name, path };
      this.restoredDownloadIds.add(match.id);
      // An extension may ask for a nested path such as `reports/page.pdf`; only the leaf matters.
      const leaf = match.requested.split(/[\\/]/).pop();
      if (!leaf || leaf === name) return { id: match.id, filename: name, path };
      const target = join(this.downloadDir(), leaf);
      renameSync(path, target);
      return { id: match.id, filename: leaf, path: target };
    } catch {
      return { filename: name, path };
    }
  }

  /** Wait for a file to stop growing before recording it, so `bytes` is the final size. */
  private async settleDownload(path: string, name: string): Promise<void> {
    if (this.settling.has(path)) return;
    this.settling.add(path);
    try {
      let previous = -1;
      for (let i = 0; i < 100; i++) {
        await new Promise((r) => setTimeout(r, 100));
        let size: number;
        try {
          size = statSync(path).size;
        } catch {
          return; // renamed or removed mid-flight
        }
        if (size > 0 && size === previous) break;
        previous = size;
      }
      let downloadId: number | undefined;
      let finalName = name;
      let finalPath = path;
      if (this.downloadsRedirected) {
        const restored = await this.restoreIntendedName(path, name);
        downloadId = restored.id;
        finalName = restored.filename;
        finalPath = restored.path;
      }

      const stat = statSync(finalPath);
      // Renaming a restored download can produce another fs.watch event for the destination.
      // A file signature suppresses only that duplicate event; a later overwrite has a new mtime
      // and remains a distinct download, even when its filename and byte size are identical.
      const signature = `${finalPath}\0${stat.size}\0${stat.mtimeMs}`;
      if (this.downloadSignatures.has(signature)) return;
      this.downloadSignatures.add(signature);
      this.downloads.push({
        id: downloadId,
        filename: finalName,
        path: finalPath,
        bytes: stat.size,
        timestamp: Date.now(),
      });
    } finally {
      this.settling.delete(path);
    }
  }

  /** Return the most recently recorded matching download. */
  latestDownload(pattern: string, requirePath = false): DownloadRecord | undefined {
    for (let index = this.downloads.length - 1; index >= 0; index--) {
      const download = this.downloads[index]!;
      if ((!requirePath || download.path) && matchesPattern(download.filename, pattern)) return download;
    }
    return undefined;
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
    if (this.workerRef) return this.workerRef;
    if (!this.extension.hasServiceWorker) {
      throw new Error(
        `${this.extension.name} declares no background service worker, so there is no "worker" context to act on.`,
      );
    }
    this.workerRef = await waitForServiceWorker(this.browser.context, 15_000);
    await this.reinstrumentWorker();
    return this.workerRef;
  }

  /** Re-apply both worker hooks. A restarted worker has a fresh global scope and keeps neither. */
  private async reinstrumentWorker(): Promise<void> {
    this.workerPatched = false;
    this.downloadsPatched = false;
    await this.patchWorkerConsole().catch(() => undefined);
    await this.patchWorkerDownloads().catch(() => undefined);
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

  /**
   * Open the popup document and make it the active context for subsequent steps.
   *
   * A real popup is browser chrome: it belongs to no tab, so an extension asking for
   * `chrome.tabs.query({ active: true, currentWindow: true })` gets the page the user was
   * looking at. Automation can only open the popup as a tab, which would otherwise make the
   * popup its own answer to that query — and most popups are built around it, so the extension
   * would act on itself instead of the page under test.
   *
   * Opening the popup and then returning the page under test to the foreground restores the real
   * behaviour. Playwright still drives the popup from the background, so nothing is lost. Pass
   * `keepPageActive: false` for the rare extension that genuinely wants its popup to be the
   * active tab.
   */
  async openPopup(size?: { width?: number; height?: number; keepPageActive?: boolean }): Promise<Page> {
    if (!this.extension.popup) {
      throw new Error(
        `${this.extension.name} declares no popup (no action.default_popup in manifest.json), so openPopup has nothing to open.`,
      );
    }
    const foreground = this.pageUnderTest();

    const existing = this.pages.get('popup');
    if (existing && !existing.isClosed()) {
      this.active = 'popup';
      if (size?.keepPageActive !== false) await foreground?.bringToFront().catch(() => undefined);
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

    if (size?.keepPageActive !== false) await foreground?.bringToFront().catch(() => undefined);
    return page;
  }

  /**
   * The page an extension should consider "the current tab": the most recently used ordinary
   * web page, never one of the extension's own documents.
   */
  private pageUnderTest(): Page | undefined {
    const candidates = [this.pages.get(this.active), ...this.pages.values()];
    for (const page of candidates) {
      if (!page || page.isClosed()) continue;
      const url = page.url();
      if (url.startsWith('chrome-extension://') || url.startsWith('chrome://')) continue;
      return page;
    }
    return undefined;
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

  /** Navigate a context and foreground ordinary web tabs so extension APIs see the test page. */
  async navigate(
    context: ContextName,
    url: string,
    options: { waitUntil: 'load' | 'domcontentloaded' | 'networkidle'; timeout: number },
  ): Promise<Page> {
    const target = this.page(context);
    await target.goto(url, options);
    if (!target.url().startsWith('chrome-extension://') && !target.url().startsWith('chrome://')) {
      await target.bringToFront();
    }
    return target;
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
    this.restoredDownloadIds.clear();
    this.downloadSignatures.clear();
    const main = this.pages.get('page');
    if (main && !main.isClosed()) await main.goto('about:blank').catch(() => undefined);
  }

  async close(): Promise<void> {
    this.downloadWatcher?.close();
    if (this.fallbackArtifacts) rmSync(this.fallbackArtifacts, { recursive: true, force: true });
    this.cdpConsole?.close();
    await this.browser.close();
  }
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
 * (`const x = 1; return x`). Valid expressions are compiled first so an IIFE's value is not
 * mistaken for a statement body merely because the IIFE contains an inner `return`.
 */
export function compileScript(script: string): (args: unknown) => unknown {
  const trimmed = script.trim();
  const expression = trimmed.replace(/;+\s*$/, '');
  try {
    // Trying the expression form first preserves the value of async IIFEs and other compound
    // expressions even when they contain an inner `return` or several statements.
    return new Function('args', `return (async () => (${expression}))();`) as (args: unknown) => unknown;
  } catch (expressionError) {
    try {
      return new Function('args', `return (async () => { ${trimmed} })();`) as (args: unknown) => unknown;
    } catch (bodyError) {
      throw new Error(
        `eval script is not valid JavaScript: ${(bodyError as Error).message}\n\n${trimmed}`,
        { cause: expressionError },
      );
    }
  }
}
