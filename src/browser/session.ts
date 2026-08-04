import { mkdirSync, mkdtempSync, renameSync, rmSync, statSync, watch, type FSWatcher } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrowserContext, CDPSession, Download, Page, Worker } from 'playwright-core';
import { attachWorkerConsole, type CdpConsole } from './cdp-console.js';
import { WATCHED_NAMESPACES } from './permissions.js';
import { extensionUrl, resolveExtension, waitForServiceWorker } from './extension.js';
import { launchBrowser, type LaunchOptions, type LaunchedBrowser } from './launcher.js';
import type { ConsoleEntry, ContextName, ExtensionEvent, ExtensionInfo } from '../types.js';
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
  readonly events: ExtensionEvent[] = [];
  active: ContextName = 'page';

  private workerRef?: Worker;
  private workerPatched = false;
  private readonly watched = new WeakMap<Page, { label: string }>();
  private readonly recordedPages = new Set<Page>();
  private readonly recordingStartedAt = new WeakMap<Page, number>();
  private readonly pageInstrumentation = new WeakMap<Page, Promise<void>>();
  private readonly pageCdpByPage = new WeakMap<Page, CDPSession>();
  private readonly pageCdpSessions = new Set<CDPSession>();
  private cdpConsole?: CdpConsole;
  private downloadWatcher?: FSWatcher;
  /** True when Chrome itself was told to write downloads into our directory. */
  private downloadsRedirected = false;
  private downloadsPatched = false;
  private apiUsagePatched = false;
  /** Namespaces observed in extension pages, kept when a page closes. */
  private readonly pageApiUsage = new Set<string>();
  private workerEventsPatched = false;
  private workerStartCount = 0;
  private eventSequence = 0;
  private readonly visitedOrigins = new Set<string>();
  private readonly settling = new Set<string>();
  private readonly restoredDownloadIds = new Set<number>();
  private readonly browserDownloadNames = new Map<string, string>();
  private readonly downloadSignatures = new Set<string>();
  private fallbackArtifacts?: string;
  private offscreenPath?: string;

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
        {
          downloadPath: this.downloadDir(),
          workerOrigin: `chrome-extension://${this.extension.id}`,
          onWorkerLifecycle: (entry) => {
            if (entry.state === 'started') {
              const type = this.workerStartCount++ === 0 ? 'worker.coldStarted' : 'worker.restarted';
              this.recordEvent(type, 'browser', {
                versionId: entry.versionId,
                scriptUrl: entry.scriptUrl,
                targetId: entry.targetId,
              }, entry.timestamp);
              void this.adoptLiveWorker().catch(() => undefined);
            } else {
              this.recordEvent('worker.stopped', 'browser', {
                versionId: entry.versionId,
                scriptUrl: entry.scriptUrl,
                targetId: entry.targetId,
              }, entry.timestamp);
              this.workerRef = undefined;
              this.workerPatched = false;
              this.downloadsPatched = false;
              this.workerEventsPatched = false;
            }
          },
          onDownloadWillBegin: (entry) => {
            this.browserDownloadNames.set(entry.guid, entry.suggestedFilename);
          },
        },
      ).catch(() => undefined);
      this.downloadsRedirected = Boolean(this.cdpConsole);
    }
    this.watchDownloadDir();
    await this.instrumentExtensionPages(ctx).catch(() => undefined);

    for (const page of ctx.pages()) this.watchPage(page, 'page');
    for (const page of ctx.backgroundPages()) {
      this.watchPage(page, 'background');
      this.pages.set('background', page);
    }
    ctx.on('page', (page) => this.watchPage(page, this.labelFor(page)));
    ctx.on('backgroundpage', (page) => {
      this.watchPage(page, 'background');
      this.pages.set('background', page);
    });
    ctx.on('serviceworker', (worker) => {
      this.workerRef = worker;
      void this.reinstrumentWorker();
    });

    if (this.extension.hasServiceWorker) {
      this.workerRef = await waitForServiceWorker(ctx, 10_000).catch(() => undefined);
      await this.patchWorkerConsole().catch(() => undefined);
      await this.patchWorkerDownloads().catch(() => undefined);
      await this.patchWorkerEvents().catch(() => undefined);
      await this.patchWorkerApiUsage().catch(() => undefined);
    }

    // The first about:blank page that a persistent context opens is our default `page`.
    let first = ctx.pages()[0] ?? (await ctx.newPage());
    if (this.options.recordVideo) {
      // The browser's initial about:blank page starts recording before extension discovery. A
      // dedicated page created here gives the testcase timeline a known video origin, so cuts do
      // not accidentally replay browser-startup frames.
      const startupPage = first;
      first = await ctx.newPage();
      await startupPage.close().catch(() => undefined);
    }
    this.watchPage(first, 'page');
    await this.pageInstrumentation.get(first)?.catch(() => undefined);
    this.pages.set('page', first);
  }

  private labelFor(page: Page): string {
    const url = page.url();
    if (this.extension.popup && url.includes(this.extension.popup)) return 'popup';
    if (this.extension.optionsPage && url.includes(this.extension.optionsPage)) return 'options';
    if (this.extension.sidePanel && url.includes(this.extension.sidePanel)) return 'sidepanel';
    if (this.extension.devtoolsPage && url.includes(this.extension.devtoolsPage)) return 'devtools';
    if (this.extension.backgroundPage && url.includes(this.extension.backgroundPage)) return 'background';
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
    this.recordedPages.add(page);
    this.recordingStartedAt.set(page, Date.now());

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
    page.on('close', () => {
      // Read once more before the context is gone; a popup that closes itself would otherwise
      // take its API usage with it.
      void this.pageApiUsage;
    });
    page.on('framenavigated', (frame) => {
      if (frame === page.mainFrame()) this.rememberOrigin(frame.url());
    });
    this.rememberOrigin(page.url());
    const instrumentation = this.instrumentPage(page).catch(() => undefined);
    this.pageInstrumentation.set(page, instrumentation);
  }

  /** Every page that may own a Playwright recording, including pages already closed by a step. */
  recordingPages(): Page[] {
    return [...this.recordedPages];
  }

  /** Approximate wall-clock origin of a page recording, used to cut testcase video segments. */
  recordingStart(page: Page): number {
    return this.recordingStartedAt.get(page) ?? Date.now();
  }

  /** Latest context label assigned to a recorded page. */
  recordingLabel(page: Page): string {
    return this.watched.get(page)?.label ?? 'page';
  }

  /**
   * Observe isolated execution worlds created for this extension's content scripts.
   * This proves Chrome actually created and ran a content-script world; an error-free page load
   * alone does not.
   */
  private async instrumentPage(page: Page): Promise<void> {
    const session = await this.browser.context.newCDPSession(page);
    this.pageCdpByPage.set(page, session);
    this.pageCdpSessions.add(session);
    const extensionWorlds = new Set<number>();
    const extensionOrigin = `chrome-extension://${this.extension.id}`;
    session.on('Runtime.executionContextCreated', (payload) => {
      const context = (payload as {
        context?: {
          id?: number;
          uniqueId?: string;
          origin?: string;
          name?: string;
          auxData?: { type?: string; frameId?: string; isDefault?: boolean };
        };
      }).context;
      if (!context || context.auxData?.isDefault) return;
      const belongsToExtension =
        context.origin === extensionOrigin ||
        context.origin?.startsWith(`${extensionOrigin}/`) ||
        context.name?.includes(this.extension.id);
      if (!belongsToExtension) return;
      if (context.id != null) extensionWorlds.add(context.id);
      this.recordEvent('contentScript.worldCreated', 'browser', {
        url: page.url(), frameId: context.auxData?.frameId, world: context.name,
      });
    });
    session.on('Debugger.scriptParsed', (payload) => {
      const script = payload as { executionContextId?: number; url?: string };
      if (script.executionContextId == null || !extensionWorlds.has(script.executionContextId)) return;
      if (!script.url?.startsWith(`${extensionOrigin}/`)) return;
      this.recordEvent('contentScript.executed', 'browser', {
        url: page.url(),
        file: script.url.slice(extensionOrigin.length + 1),
        scriptUrl: script.url,
      });
    });
    page.once('close', () => {
      this.pageCdpSessions.delete(session);
      void session.detach().catch(() => undefined);
    });
    await session.send('Runtime.enable');
    await session.send('Debugger.enable');
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
    this.recordEvent('downloads.created', 'browser', { filename: name });
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
   * Install the same namespace proxies in every extension page.
   *
   * `addInitScript` runs before the page's own scripts, so a popup that reads `chrome.storage` on
   * load is captured. Content scripts run in an isolated world this cannot reach, so their API use
   * is not counted — noted in the report rather than silently missing.
   */
  private async instrumentExtensionPages(context: BrowserContext): Promise<void> {
    await context.addInitScript((namespaces: string[]) => {
      const chromeApi = (globalThis as unknown as { chrome?: Record<string, unknown> }).chrome;
      if (!chromeApi || !location.protocol.startsWith('chrome-extension')) return;
      const scope = globalThis as unknown as { __extTestApiUsage?: Record<string, number> };
      if (scope.__extTestApiUsage) return;
      const usage: Record<string, number> = {};
      scope.__extTestApiUsage = usage;
      for (const namespace of namespaces) {
        const target = chromeApi[namespace];
        if (!target || typeof target !== 'object') continue;
        chromeApi[namespace] = new Proxy(target as object, {
          get(object, property, receiver) {
            if (typeof property === 'string') usage[namespace] = (usage[namespace] ?? 0) + 1;
            return Reflect.get(object, property, receiver);
          },
        });
      }
    }, WATCHED_NAMESPACES);
  }

  /**
   * Record which `chrome.*` namespaces the extension touches, for the permission audit.
   *
   * A `get` trap on each namespace is enough: permissions are granted per namespace, so knowing
   * `chrome.history` was reached at all answers the question. Recording on property access rather
   * than on call over-reports slightly — referencing an API without invoking it counts — and that
   * is the safe direction, since the cost of a false "used" is a permission left in place, while
   * a false "unused" would advise deleting something the extension needs.
   *
   * The untouched originals are stashed on `__extTestRaw` so ext-tester's own calls into
   * `chrome.storage` and `chrome.permissions` do not show up as the extension using them.
   */
  private async patchWorkerApiUsage(): Promise<void> {
    const worker = this.workerRef;
    if (!worker || this.apiUsagePatched) return;
    const patched = await worker
      .evaluate((namespaces: string[]) => {
        const scope = self as unknown as {
          __extTestApiUsage?: Record<string, number>;
          __extTestRaw?: Record<string, unknown>;
        };
        if (scope.__extTestApiUsage) return true;
        const usage: Record<string, number> = {};
        const raw: Record<string, unknown> = {};
        scope.__extTestApiUsage = usage;
        scope.__extTestRaw = raw;

        const api = chrome as unknown as Record<string, unknown>;
        for (const namespace of namespaces) {
          const target = api[namespace];
          if (!target || typeof target !== 'object') continue;
          raw[namespace] = target;
          api[namespace] = new Proxy(target as object, {
            get(object, property, receiver) {
              if (typeof property === 'string') usage[namespace] = (usage[namespace] ?? 0) + 1;
              return Reflect.get(object, property, receiver);
            },
          });
        }
        return true;
      }, WATCHED_NAMESPACES)
      .catch(() => false);
    this.apiUsagePatched = patched;
  }

  /** Namespaces the extension has touched so far, across the worker and its own pages. */
  async apiUsage(): Promise<string[]> {
    const seen = new Set(this.pageApiUsage);
    const worker = this.workerRef;
    if (worker && this.apiUsagePatched) {
      const fromWorker = await worker
        .evaluate(() => {
          const scope = self as unknown as { __extTestApiUsage?: Record<string, number> };
          return Object.keys(scope.__extTestApiUsage ?? {});
        })
        .catch(() => [] as string[]);
      for (const namespace of fromWorker) seen.add(namespace);
    }
    for (const [name, page] of this.pages) {
      if (page.isClosed()) continue;
      if (!page.url().startsWith('chrome-extension://')) continue;
      const fromPage = await page
        .evaluate(() => {
          const scope = window as unknown as { __extTestApiUsage?: Record<string, number> };
          return Object.keys(scope.__extTestApiUsage ?? {});
        })
        .catch(() => [] as string[]);
      for (const namespace of fromPage) seen.add(namespace);
      void name;
    }
    return [...seen].sort();
  }

  /**
   * Remember the filename each `chrome.downloads.download()` call asked for.
   *
   * Redirecting downloads into the test's own directory gives every file a collision-free GUID —
   * the extension's chosen name is discarded before it reaches disk, and `chrome.downloads.search()`
   * reports the GUID path. Recording the request lets the file
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
      if (!match) {
        const suggested = this.browserDownloadNames.get(name);
        const leaf = suggested?.split(/[\\/]/).pop();
        if (!leaf || leaf === name) return { filename: name, path };
        const target = join(this.downloadDir(), leaf);
        renameSync(path, target);
        return { filename: leaf, path: target };
      }
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
      this.recordEvent('downloads.created', 'browser', {
        id: downloadId,
        filename: finalName,
        path: finalPath,
        bytes: stat.size,
      });
    } finally {
      this.settling.delete(path);
    }
  }

  /** Return the most recently recorded matching download. */
  latestDownload(pattern: string, requirePath = false, afterIndex = 0): DownloadRecord | undefined {
    for (let index = this.downloads.length - 1; index >= afterIndex; index--) {
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

  /** Sequence number of the most recently observed extension event. */
  get lastEventSequence(): number {
    return this.eventSequence;
  }

  private recordEvent(type: string, source: ExtensionEvent['source'], detail?: unknown, timestamp = Date.now()): void {
    this.events.push({ sequence: ++this.eventSequence, type, source, timestamp, detail });
  }

  /**
   * Install passive listeners for extension behavior that has no DOM representation.
   *
   * The listeners never answer messages or mutate browser state; they only append JSON-safe
   * records to a worker-local buffer. Re-instrumentation after an MV3 restart creates a fresh
   * buffer and listeners in the new global scope.
   */
  private async patchWorkerEvents(): Promise<void> {
    const worker = this.workerRef;
    if (!worker || this.workerEventsPatched) return;
    const patched = await worker
      .evaluate(() => {
        type BufferedEvent = { type: string; detail?: unknown; t: number };
        type ChromeEvent = { addListener?: (listener: (...args: unknown[]) => void) => void };
        type ChromeNamespace = Record<string, Record<string, unknown> | undefined>;
        const scope = self as unknown as {
          __extTestEvents?: BufferedEvent[];
          __extTestEventsInstalled?: boolean;
        };
        if (scope.__extTestEventsInstalled) return true;

        scope.__extTestEvents = [];
        scope.__extTestEventsInstalled = true;
        const api = chrome as unknown as ChromeNamespace;
        const push = (type: string, detail?: unknown) => {
          scope.__extTestEvents!.push({ type, detail: clone(detail), t: Date.now() });
        };
        const listen = (namespace: string, event: string, type: string, map: (...args: unknown[]) => unknown) => {
          const target = api[namespace]?.[event] as ChromeEvent | undefined;
          if (typeof target?.addListener !== 'function') return;
          target.addListener((...args: unknown[]) => push(type, map(...args)));
        };
        const identity = (...args: unknown[]) => (args.length <= 1 ? args[0] : args);

        listen('runtime', 'onMessage', 'runtime.message', (message, sender) => ({ message, sender }));
        listen('runtime', 'onConnect', 'runtime.connected', (port) => {
          const p = port as { name?: string; sender?: unknown } | undefined;
          return { name: p?.name ?? '', sender: p?.sender };
        });
        listen('storage', 'onChanged', 'storage.changed', (changes, areaName) => ({ areaName, changes }));
        listen('tabs', 'onCreated', 'tabs.created', identity);
        listen('tabs', 'onUpdated', 'tabs.updated', (tabId, changeInfo, tab) => ({ tabId, changeInfo, tab }));
        listen('tabs', 'onActivated', 'tabs.activated', identity);
        listen('tabs', 'onRemoved', 'tabs.removed', (tabId, removeInfo) => ({ tabId, removeInfo }));
        listen('alarms', 'onAlarm', 'alarms.fired', identity);
        listen('permissions', 'onAdded', 'permissions.added', identity);
        listen('permissions', 'onRemoved', 'permissions.removed', identity);
        listen('commands', 'onCommand', 'commands.invoked', (command, tab) => ({ command, tab }));
        listen('contextMenus', 'onClicked', 'contextMenus.clicked', (info, tab) => ({ info, tab }));
        listen('notifications', 'onClicked', 'notifications.clicked', (notificationId) => ({ notificationId }));
        listen('notifications', 'onClosed', 'notifications.closed', (notificationId, byUser) => ({
          notificationId,
          byUser,
        }));
        listen('downloads', 'onCreated', 'downloads.created', identity);
        listen('downloads', 'onChanged', 'downloads.changed', identity);

        function clone(value: unknown): unknown {
          if (value === undefined || value === null) return value;
          try {
            return JSON.parse(JSON.stringify(value));
          } catch {
            return String(value);
          }
        }
        return true;
      })
      .catch(() => false);
    this.workerEventsPatched = patched;
  }

  /** Pull worker-observed events into the session's ordered event timeline. */
  async drainWorkerEvents(): Promise<void> {
    const worker = this.workerRef;
    if (!worker || !this.workerEventsPatched) return;
    const entries = await worker
      .evaluate(() => {
        const scope = self as unknown as {
          __extTestEvents?: { type: string; detail?: unknown; t: number }[];
        };
        const out = scope.__extTestEvents ?? [];
        scope.__extTestEvents = [];
        return out;
      })
      .catch(() => [] as { type: string; detail?: unknown; t: number }[]);
    for (const entry of entries) this.recordEvent(entry.type, 'worker', entry.detail, entry.t);
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

  /** Find a worker whose execution context is genuinely live, not a stale Playwright handle. */
  private async adoptLiveWorker(timeout = 15_000): Promise<Worker> {
    const prefix = `chrome-extension://${this.extension.id}/`;
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const candidates = this.browser.context.serviceWorkers().filter((worker) => worker.url().startsWith(prefix));
      for (const worker of candidates) {
        const live = await worker.evaluate(() => true).catch(() => false);
        if (!live) continue;
        const changed = this.workerRef !== worker;
        this.workerRef = worker;
        if (changed || !this.workerEventsPatched || !this.downloadsPatched) await this.reinstrumentWorker();
        return worker;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`The service worker did not become live within ${timeout}ms.`);
  }

  /** Re-apply worker hooks. A restarted worker has a fresh global scope and keeps none of them. */
  private async reinstrumentWorker(): Promise<void> {
    this.workerPatched = false;
    this.downloadsPatched = false;
    this.workerEventsPatched = false;
    this.apiUsagePatched = false;
    await this.patchWorkerConsole().catch(() => undefined);
    await this.patchWorkerDownloads().catch(() => undefined);
    await this.patchWorkerEvents().catch(() => undefined);
    await this.patchWorkerApiUsage().catch(() => undefined);
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
      return await this.adoptLiveWorker();
    }
  }

  page(name: ContextName = this.active): Page {
    if (name === 'offscreen') {
      throw new Error(
        'The offscreen context has no visible Page. Use eval in: offscreen, or closeOffscreenDocument.',
      );
    }
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
    if (name === 'offscreen') return Boolean(this.offscreenPath);
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
    // Chromium tabs in a headed persistent context share one physical browser window. Resizing
    // this tab to popup dimensions would shrink the webpage tab as well, leaving the developer
    // looking at a 400×600 slice after the webpage is brought back to the front. Headless pages
    // have independent emulated viewports, so popup sizing remains deterministic there.
    if (this.browser.headless) await page.setViewportSize(dims);
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

  private async openDeclaredSurface(
    name: 'sidepanel' | 'devtools',
    path: string | undefined,
    declaration: string,
  ): Promise<Page> {
    if (!path) throw new Error(`${this.extension.name} declares no ${declaration}.`);
    const existing = this.pages.get(name);
    if (existing && !existing.isClosed()) {
      this.active = name;
      return existing;
    }
    const page = await this.browser.context.newPage();
    this.watchPage(page, name);
    await page.goto(extensionUrl(this.extension, path), { waitUntil: 'domcontentloaded' });
    this.pages.set(name, page);
    this.active = name;
    return page;
  }

  /** Open the manifest-declared side-panel document as an addressable extension surface. */
  async openSidePanel(): Promise<Page> {
    return await this.openDeclaredSurface('sidepanel', this.extension.sidePanel, 'side_panel.default_path');
  }

  /** Open the manifest-declared DevTools page for DOM/console smoke testing. */
  async openDevtoolsPage(): Promise<Page> {
    return await this.openDeclaredSurface('devtools', this.extension.devtoolsPage, 'devtools_page');
  }

  /** Resolve the persistent MV2 background page exposed by Chromium. */
  async backgroundPage(timeout = 10_000): Promise<Page> {
    const existing = this.pages.get('background') ?? this.browser.context.backgroundPages()[0];
    if (existing && !existing.isClosed()) {
      this.watchPage(existing, 'background');
      this.pages.set('background', existing);
      return existing;
    }
    if (!this.extension.backgroundPage) {
      throw new Error(`${this.extension.name} declares no MV2 background page or background scripts.`);
    }
    const page = await this.browser.context.waitForEvent('backgroundpage', { timeout });
    this.watchPage(page, 'background');
    this.pages.set('background', page);
    return page;
  }

  /** Trigger every listener registered on chrome.commands.onCommand in the live extension worker. */
  async triggerCommand(command: string): Promise<string> {
    const declared = this.extension.commands[command];
    if (!declared) throw new Error(`${this.extension.name} declares no command named ${JSON.stringify(command)}.`);
    const worker = await this.wakeWorker();
    await worker.evaluate((commandName) => {
      const api = chrome as unknown as {
        commands: { onCommand: { dispatch?: (...args: unknown[]) => void } };
      };
      const event = api.commands.onCommand;
      if (typeof event.dispatch !== 'function') {
        throw new Error('This Chrome build does not expose extension-event dispatch to automation.');
      }
      event.dispatch(commandName);
    }, command);
    return command;
  }

  /** Open a declared popup, or dispatch the toolbar action's onClicked listeners. */
  async triggerAction(): Promise<Page | undefined> {
    if (this.extension.popup) return await this.openPopup();
    const worker = await this.wakeWorker();
    await worker.evaluate(async () => {
      type Event = { onClicked?: { dispatch?: (...args: unknown[]) => void } };
      const chromeApi = chrome as unknown as {
        tabs: { query(query: Record<string, unknown>): Promise<unknown[]> };
        action?: Event;
        browserAction?: Event;
        pageAction?: Event;
      };
      const tabs = await chromeApi.tabs.query({ active: true, currentWindow: true });
      const api = chromeApi.action ?? chromeApi.browserAction ?? chromeApi.pageAction;
      const event = api?.onClicked;
      if (typeof event?.dispatch !== 'function') {
        throw new Error('The extension declares no actionable toolbar surface in this Chrome build.');
      }
      event.dispatch(tabs[0]);
    });
    return undefined;
  }

  /** Trigger chrome.contextMenus.onClicked with a browser-shaped info object and active tab. */
  async triggerContextMenu(
    menuItemId: string | number,
    detail: Record<string, unknown> = {},
  ): Promise<void> {
    const worker = await this.wakeWorker();
    await worker.evaluate(async ({ menuItemId, detail }) => {
      const chromeApi = chrome as unknown as {
        tabs: { query(query: Record<string, unknown>): Promise<unknown[]> };
        contextMenus?: { onClicked?: { dispatch?: (...args: unknown[]) => void } };
      };
      const tabs = await chromeApi.tabs.query({ active: true, currentWindow: true });
      const event = chromeApi.contextMenus?.onClicked;
      if (typeof event?.dispatch !== 'function') {
        throw new Error('chrome.contextMenus.onClicked is unavailable; declare the contextMenus permission.');
      }
      event.dispatch({ menuItemId, ...detail }, tabs[0]);
    }, { menuItemId, detail });
  }

  /** Create a real MV3 offscreen document through chrome.offscreen. */
  async createOffscreenDocument(
    url: string,
    reasons: string[],
    justification: string,
  ): Promise<void> {
    if (!this.extension.hasOffscreenPermission) {
      throw new Error(`${this.extension.name} does not declare the "offscreen" permission.`);
    }
    const worker = await this.wakeWorker();
    await worker.evaluate(
      async ({ url, reasons, justification }) => {
        const api = (chrome as unknown as {
          offscreen?: {
            createDocument(options: { url: string; reasons: string[]; justification: string }): Promise<void>;
          };
        }).offscreen;
        if (!api) throw new Error('chrome.offscreen is unavailable in this Chrome version.');
        await api.createDocument({ url, reasons, justification });
      },
      { url, reasons, justification },
    );
    this.offscreenPath = url;
    this.recordEvent('offscreen.created', 'browser', { url, reasons, justification });
  }

  async closeOffscreenDocument(): Promise<void> {
    const worker = await this.wakeWorker();
    await worker.evaluate(async () => {
      const api = (chrome as unknown as { offscreen?: { closeDocument(): Promise<void> } }).offscreen;
      if (!api) throw new Error('chrome.offscreen is unavailable in this Chrome version.');
      await api.closeDocument();
    });
    this.offscreenPath = undefined;
    this.recordEvent('offscreen.closed', 'browser');
  }

  async closePopup(): Promise<void> {
    const page = this.pages.get('popup');
    if (page && !page.isClosed()) await page.close();
    this.pages.delete('popup');
    if (this.active === 'popup') this.active = 'page';
  }

  /** Close named and extension-opened tabs while preserving the requested test context. */
  async closeOtherTabs(keep: ContextName = 'page'): Promise<number> {
    const target = this.page(keep === 'worker' ? 'page' : keep);
    let closed = 0;
    for (const page of this.browser.context.pages()) {
      if (page === target || page.isClosed()) continue;
      await page.close().catch(() => undefined);
      closed++;
    }
    for (const [name, page] of [...this.pages]) {
      if (page !== target) this.pages.delete(name);
    }
    if (![...this.pages.values()].includes(target)) this.pages.set(String(keep), target);
    this.active = keep === 'worker' ? 'page' : keep;
    return closed;
  }

  async newTab(url?: string, name?: string): Promise<Page> {
    const page = await this.browser.context.newPage();
    const label = name ?? `tab${this.pages.size}`;
    this.watchPage(page, label);
    await this.pageInstrumentation.get(page);
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
    await this.pageInstrumentation.get(target);
    await target.goto(url, options);
    if (!target.url().startsWith('chrome-extension://') && !target.url().startsWith('chrome://')) {
      await target.bringToFront();
    }
    return target;
  }

  private rememberOrigin(url: string): void {
    try {
      const parsed = new URL(url);
      if (['http:', 'https:', 'chrome-extension:'].includes(parsed.protocol)) {
        this.visitedOrigins.add(parsed.origin);
      }
    } catch {
      /* about:blank, data: and malformed intermediate URLs have no persistent origin to clear */
    }
  }

  /** Evaluate a source string in a context, returning a JSON-safe value. */
  async evaluate(context: ContextName, script: string, args?: unknown): Promise<unknown> {
    const fn = compileScript(script);
    if (context === 'worker') {
      const worker = await this.wakeWorker();
      return await worker.evaluate(fn, args);
    }
    if (context === 'offscreen') {
      if (!this.offscreenPath) {
        throw new Error('No offscreen document exists. Create one with createOffscreenDocument first.');
      }
      if (!this.cdpConsole) {
        throw new Error('Offscreen evaluation requires the DevTools connection; do not use debugPort: false.');
      }
      return await this.cdpConsole.evaluateExtensionTarget(this.offscreenPath, fn.toString(), args);
    }
    return await this.page(context).evaluate(fn, args);
  }

  async storageGet(key: string, area: 'local' | 'sync' | 'session' = 'local'): Promise<unknown> {
    const worker = await this.wakeWorker();
    return await worker.evaluate(
      async ({ key, area }) => {
        const scope = self as unknown as { __extTestRaw?: Record<string, unknown> };
        const storage = (scope.__extTestRaw?.['storage'] ?? chrome.storage) as unknown as Record<
          string,
          chrome.storage.StorageArea
        >;
        const store = storage[area];
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
        const scope = self as unknown as { __extTestRaw?: Record<string, unknown> };
        const storage = (scope.__extTestRaw?.['storage'] ?? chrome.storage) as unknown as Record<
          string,
          chrome.storage.StorageArea
        >;
        const store = storage[area];
        if (!store) throw new Error(`chrome.storage.${area} is not available`);
        await store.set({ [key]: value });
      },
      { key, value, area },
    );
  }

  async storageClear(area: 'local' | 'sync' | 'session' = 'local'): Promise<void> {
    const worker = await this.wakeWorker();
    await worker.evaluate(async ({ area }) => {
      const scope = self as unknown as { __extTestRaw?: Record<string, unknown> };
      const storage = (scope.__extTestRaw?.['storage'] ?? chrome.storage) as unknown as Record<
        string,
        chrome.storage.StorageArea
      >;
      const store = storage[area];
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
    await new Promise((resolve) => setTimeout(resolve, 500));
    if (this.extension.hasServiceWorker) await this.worker();
  }

  /** Clear origin-backed persistence from every ordinary site the reusable session visited. */
  private async clearVisitedOriginStorage(): Promise<void> {
    const page = this.browser.context.pages().find((candidate) => !candidate.isClosed());
    if (!page) return;
    const cdp = this.pageCdpByPage.get(page) ?? (await this.browser.context.newCDPSession(page));
    const temporary = !this.pageCdpByPage.has(page);
    const origins = new Set(this.visitedOrigins);
    origins.add(`chrome-extension://${this.extension.id}`);
    const storageTypes = [
      'file_systems',
      'indexeddb',
      'local_storage',
      'websql',
      'cache_storage',
      'interest_groups',
      'shared_storage',
      'storage_buckets',
    ].join(',');
    try {
      for (const origin of origins) {
        await cdp.send('Storage.clearDataForOrigin', { origin, storageTypes });
      }
    } finally {
      if (temporary) await cdp.detach().catch(() => undefined);
    }
    this.visitedOrigins.clear();
  }

  /** Clear extension APIs that persist outside normal page storage. */
  private async clearExtensionPersistence(): Promise<void> {
    if (!this.extension.hasServiceWorker) return;
    const worker = await this.wakeWorker();
    await worker.evaluate(
      async ({ requiredPermissions, requiredOrigins }) => {
        const api = chrome as unknown as {
          storage?: Record<string, { clear: () => Promise<void> }>;
          alarms?: { clearAll: () => Promise<boolean> };
          downloads?: { erase: (query: Record<string, never>) => Promise<number[]> };
          permissions?: {
            getAll: () => Promise<{ permissions?: string[]; origins?: string[] }>;
            remove: (permissions: { permissions?: string[]; origins?: string[] }) => Promise<boolean>;
          };
        };
        for (const area of ['local', 'sync', 'session']) {
          await api.storage?.[area]?.clear();
        }
        await api.alarms?.clearAll().catch(() => undefined);
        await api.downloads?.erase({}).catch(() => undefined);
        const granted = await api.permissions?.getAll().catch(() => undefined);
        const removablePermissions = (granted?.permissions ?? []).filter(
          (permission) => !requiredPermissions.includes(permission),
        );
        const removableOrigins = (granted?.origins ?? []).filter((origin) => !requiredOrigins.includes(origin));
        if (removablePermissions.length || removableOrigins.length) {
          await api.permissions
            ?.remove({ permissions: removablePermissions, origins: removableOrigins })
            .catch(() => undefined);
        }
      },
      {
        requiredPermissions: this.extension.permissions,
        requiredOrigins: this.extension.hostPermissions,
      },
    );
  }

  /** Scrub persistent state before the reusable profile is relaunched for the next test. */
  async reset(): Promise<void> {
    const main = this.pages.get('page');
    // Include tabs opened by the extension itself: they are watched but intentionally do not
    // receive a stable name in `pages` until a test claims them.
    for (const page of this.browser.context.pages()) {
      if (page === main) continue;
      await page.close().catch(() => undefined);
    }
    this.pages.clear();
    if (main && !main.isClosed()) this.pages.set('page', main);
    this.active = 'page';
    await this.clearExtensionPersistence();
    await this.browser.context.clearCookies();
    await this.clearVisitedOriginStorage();
    this.console.length = 0;
    this.downloads.length = 0;
    this.events.length = 0;
    this.eventSequence = 0;
    this.restoredDownloadIds.clear();
    this.browserDownloadNames.clear();
    this.downloadSignatures.clear();
    this.offscreenPath = undefined;
    if (main && !main.isClosed()) await main.goto('about:blank').catch(() => undefined);
  }

  async close(): Promise<void> {
    this.downloadWatcher?.close();
    if (this.fallbackArtifacts) rmSync(this.fallbackArtifacts, { recursive: true, force: true });
    this.cdpConsole?.close();
    for (const session of this.pageCdpSessions) await session.detach().catch(() => undefined);
    this.pageCdpSessions.clear();
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
