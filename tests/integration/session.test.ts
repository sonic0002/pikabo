import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Session } from '../../src/browser/session.js';
import { computeUnpackedExtensionId, isValidExtensionId } from '../../src/browser/extension-id.js';

const fixtures = join(dirname(fileURLToPath(import.meta.url)), '../../fixtures');

describe('Session against the sample extension', () => {
  let session: Session;
  let outDir: string;

  beforeAll(async () => {
    outDir = mkdtempSync(join(tmpdir(), 'ext-int-'));
    session = await Session.start({
      extensionPath: join(fixtures, 'sample-extension'),
      headless: true,
      artifactsDir: outDir,
    });
  }, 120_000);

  afterAll(async () => {
    await session?.close();
    rmSync(outDir, { recursive: true, force: true });
  });

  it('loads the extension and reads its identity from the service worker', () => {
    expect(isValidExtensionId(session.extension.id)).toBe(true);
    expect(session.extension.idSource).toBe('service-worker');
    expect(session.extension.name).toBe('pikabo sample');
    expect(session.extension.manifestVersion).toBe(3);
    expect(session.extension.popup).toBe('popup.html');
  });

  it('records the worker cold-start boundary', async () => {
    await waitFor(() => session.events.some((event) => event.type === 'worker.coldStarted'));
    expect(session.events.find((event) => event.type === 'worker.coldStarted')).toMatchObject({
      source: 'browser',
      detail: { scriptUrl: expect.stringContaining('chrome-extension://') },
    });
  });

  it('opens the popup as a real document', async () => {
    const popup = await session.openPopup();
    expect(popup.url()).toContain(session.extension.id);
    expect(await popup.textContent('h1')).toBe('pikabo sample');
    expect(popup.viewportSize()).toEqual({ width: 400, height: 600 });
  });

  it('opens the options page', async () => {
    const options = await session.openOptions();
    expect(await options.textContent('h1')).toBe('Sample options');
  });

  it('evaluates inside the service worker', async () => {
    const id = await session.evaluate('worker', 'chrome.runtime.id');
    expect(id).toBe(session.extension.id);
  });

  it('reads and writes chrome.storage through the worker', async () => {
    await session.storageSet('probe', { nested: [1, 2] });
    expect(await session.storageGet('probe')).toEqual({ nested: [1, 2] });
    await session.storageClear();
    expect(await session.storageGet('probe')).toBeUndefined();
  });

  it('reports permissions the extension actually holds', async () => {
    expect(await session.hasPermission('storage')).toBe(true);
    expect(await session.hasPermission('bookmarks')).toBe(false);
  });

  it('records consecutive worker downloads under each requested filename', async () => {
    const names = ['first-worker-report.txt', 'second-worker-report.txt'];
    for (const filename of names) {
      await session.evaluate(
        'worker',
        'chrome.downloads.download({ url: "data:text/plain;base64,d29ya2VyIHJlcG9ydAo=", filename: args, saveAs: false })',
        filename,
      );
      await waitFor(() => session.downloads.some((download) => download.filename === filename));
    }

    expect(session.downloads.slice(-2).map((download) => download.filename)).toEqual(names);
    expect(session.downloads.slice(-2).every((download) => download.id != null)).toBe(true);
  });

  it('keeps repeated filenames as distinct downloads and returns the newest match', async () => {
    const filename = 'repeated-worker-report.txt';
    const before = session.downloads.length;
    for (let index = 0; index < 2; index++) {
      await session.evaluate(
        'worker',
        'chrome.downloads.download({ url: "data:text/plain;base64,d29ya2VyIHJlcG9ydAo=", filename: args, saveAs: false })',
        filename,
      );
      await waitFor(() => session.downloads.length > before + index);
    }

    const repeated = session.downloads.filter((download) => download.filename === filename);
    expect(repeated).toHaveLength(2);
    expect(session.latestDownload('repeated-*.txt')?.id).toBe(repeated[1]!.id);
  });

  it('correlates callback-style and concurrent worker downloads', async () => {
    const callbackName = `callback-${Date.now()}.txt`;
    await session.evaluate(
      'worker',
      `new Promise((resolve, reject) => chrome.downloads.download(
        { url: "data:text/plain;base64,Y2FsbGJhY2sK", filename: args, saveAs: false },
        (id) => chrome.runtime.lastError ? reject(chrome.runtime.lastError.message) : resolve(id)
      ))`,
      callbackName,
    );
    await waitFor(() => session.downloads.some((download) => download.filename === callbackName));

    const concurrentNames = [`concurrent-a-${Date.now()}.txt`, `concurrent-b-${Date.now()}.txt`];
    await session.evaluate(
      'worker',
      `Promise.all(args.map((filename) => chrome.downloads.download({
        url: "data:text/plain;base64,Y29uY3VycmVudAo=", filename, saveAs: false
      })))`,
      concurrentNames,
    );
    await waitFor(
      () => concurrentNames.every((name) => session.downloads.some((item) => item.filename === name)),
    ).catch(() => {
      throw new Error(
        `Concurrent downloads were not correlated: ${JSON.stringify(session.downloads.slice(-6))}`,
      );
    });

    const recorded = session.downloads.filter((item) => concurrentNames.includes(item.filename));
    expect(recorded).toHaveLength(2);
    expect(new Set(recorded.map((item) => item.id)).size).toBe(2);
  });

  it('reports cancelled and interrupted downloads without claiming they completed', async () => {
    const server = await downloadServer((path, response) => {
      response.writeHead(200, {
        'content-type': 'application/octet-stream',
        'content-length': 4 * 1024 * 1024,
      });
      response.write(Buffer.alloc(1024, 1));
      if (path === '/interrupted') {
        setTimeout(() => response.destroy(), 75);
        return;
      }
      const timer = setInterval(() => response.write(Buffer.alloc(1024, 2)), 25);
      response.once('close', () => clearInterval(timer));
    });
    try {
      const cancelledName = `cancelled-${Date.now()}.bin`;
      const cancelledId = Number(
        await session.evaluate(
          'worker',
          'chrome.downloads.download({ url: args.url, filename: args.filename, saveAs: false })',
          { url: `${server.url}/slow`, filename: cancelledName },
        ),
      );
      await session.evaluate('worker', 'chrome.downloads.cancel(args)', cancelledId);
      await waitForDownloadState(session, cancelledId, 'interrupted');

      const interruptedName = `interrupted-${Date.now()}.bin`;
      const interruptedId = Number(
        await session.evaluate(
          'worker',
          'chrome.downloads.download({ url: args.url, filename: args.filename, saveAs: false })',
          { url: `${server.url}/interrupted`, filename: interruptedName },
        ),
      );
      await waitForDownloadState(session, interruptedId, 'interrupted');
      await waitForAsync(async () => {
        await session.drainWorkerEvents();
        return [cancelledId, interruptedId].every((id) =>
          session.events.some(
            (event) =>
              event.type === 'downloads.changed' &&
              (event.detail as { id?: number; state?: { current?: string } } | undefined)?.id === id &&
              (event.detail as { state?: { current?: string } }).state?.current === 'interrupted',
          ),
        );
      });
      expect(session.downloads.some((item) => [cancelledName, interruptedName].includes(item.filename))).toBe(false);
    } finally {
      await server.close();
    }
  });

  it('foregrounds the page under test when it is navigated', async () => {
    await session.newTab('https://example.org/', 'welcome');
    expect(await activeTabUrl(session)).toContain('example.org');

    await session.navigate('page', 'https://example.com/', { waitUntil: 'domcontentloaded', timeout: 20_000 });

    expect(await activeTabUrl(session)).toContain('example.com');
  });

  it('records definitive content-script execution contexts', async () => {
    const after = session.lastEventSequence;
    await session.navigate('page', `https://example.com/?content-event=${Date.now()}`, {
      waitUntil: 'domcontentloaded',
      timeout: 20_000,
    });
    await waitFor(() =>
      session.events.some((event) => event.sequence > after && event.type === 'contentScript.executed'),
    );
    const event = session.events.find(
      (candidate) => candidate.sequence > after && candidate.type === 'contentScript.executed',
    );
    expect(event?.source).toBe('browser');
    expect(event?.detail).toMatchObject({
      url: expect.stringContaining('example.com'),
      file: 'content.js',
    });
  });

  it('records runtime messages and storage changes from the worker', async () => {
    const after = session.lastEventSequence;
    const popup = await session.openPopup();
    await popup.evaluate(() => chrome.runtime.sendMessage({ type: 'ping' }));
    await session.storageSet('eventProbe', 'ready');
    await waitForAsync(async () => {
      await session.drainWorkerEvents();
      const recent = session.events.filter((event) => event.sequence > after);
      return (
        recent.some(
          (event) =>
            event.type === 'runtime.message' &&
            (event.detail as { message?: { type?: string } } | undefined)?.message?.type === 'ping',
        ) && recent.some((event) => event.type === 'storage.changed')
      );
    });
  });

  it('collects console output from the popup without duplicating it', async () => {
    const popup = await session.openPopup();
    const marker = `probe-${Date.now()}`;
    await popup.evaluate((m) => console.log(m), marker);
    await new Promise((r) => setTimeout(r, 200));
    const hits = session.console.filter((e) => e.text.includes(marker));
    expect(hits).toHaveLength(1);
    expect(hits[0]!.context).toBe('popup');
  });

  it('names contexts so steps can address them', async () => {
    await session.openPopup();
    expect(session.has('popup')).toBe(true);
    await session.closePopup();
    expect(session.has('popup')).toBe(false);
  });

  it('closes named and extension-opened tabs while keeping the test page', async () => {
    await session.newTab('about:blank', 'temporary');
    session.active = 'page';
    const before = session.context.pages().length;
    const closed = await session.closeOtherTabs('page');
    expect(closed).toBe(before - 1);
    expect(session.context.pages()).toHaveLength(1);
    expect(session.has('page')).toBe(true);
  });

  it('reset clears extension, origin and tab persistence', async () => {
    await session.storageSet('resetProbe', 'dirty');
    await session.navigate('page', `https://example.com/?reset=${Date.now()}`, {
      waitUntil: 'domcontentloaded',
      timeout: 20_000,
    });
    await session.page('page').evaluate(async () => {
      localStorage.setItem('pikaboReset', 'dirty');
      const cache = await caches.open('pikabo-reset');
      await cache.put('/probe', new Response('dirty'));
    });
    await session.newTab('about:blank', 'reset-extra');

    await session.reset();

    expect(session.context.pages()).toHaveLength(1);
    expect(await session.storageGet('resetProbe')).toBeUndefined();
    await session.navigate('page', 'https://example.com/?after-reset', {
      waitUntil: 'domcontentloaded',
      timeout: 20_000,
    });
    expect(
      await session.page('page').evaluate(async () => ({
        local: localStorage.getItem('pikaboReset'),
        caches: await caches.keys(),
      })),
    ).toEqual({ local: null, caches: [] });
  });
}, 120_000);

describe('Session against an extension with no service worker', () => {
  let session: Session;

  beforeAll(async () => {
    session = await Session.start({
      extensionPath: join(fixtures, 'no-worker-extension'),
      headless: true,
    });
  }, 120_000);

  afterAll(async () => {
    await session?.close();
  });

  it('still resolves a valid extension id', () => {
    expect(isValidExtensionId(session.extension.id)).toBe(true);
    expect(session.extension.hasServiceWorker).toBe(false);
  });

  it('resolves the id without a worker, and the path hash agrees when used', () => {
    if (session.extension.idSource === 'path-hash') {
      expect(session.extension.id).toBe(computeUnpackedExtensionId(join(fixtures, 'no-worker-extension')));
    } else {
      expect(session.extension.idSource).toBe('chrome://extensions');
    }
  });

  it('injects its content script on a matching page', async () => {
    const page = await session.newTab('https://example.com/');
    await page.waitForSelector('#content-only-marker', { timeout: 20_000 });
    expect(await page.textContent('#content-only-marker')).toBe('content-only extension injected');
  });

  it('explains why there is no worker context to act on', async () => {
    await expect(session.evaluate('worker', '1')).rejects.toThrow(/no background service worker/);
  });
}, 120_000);

describe('Session against a broken extension', () => {
  it('captures service worker startup errors, including ones thrown before we attach', async () => {
    const session = await Session.start({
      extensionPath: join(fixtures, 'broken-extension'),
      headless: true,
    });
    try {
      await new Promise((r) => setTimeout(r, 1000));
      await session.drainWorkerConsole();
      const workerErrors = session.console.filter((e) => e.context === 'worker' && e.type === 'error');
      const text = workerErrors.map((e) => e.text).join('\n');
      expect(text).toMatch(/undefinedFunctionThatDoesNotExist/);
      expect(text).toMatch(/deliberate unhandled rejection/);
    } finally {
      await session.close();
    }
  }, 120_000);
});

describe('Session extension surfaces', () => {
  let session: Session;
  let outDir: string;

  beforeAll(async () => {
    outDir = mkdtempSync(join(tmpdir(), 'ext-surfaces-'));
    session = await Session.start({
      extensionPath: join(fixtures, 'surfaces-extension'),
      headless: true,
      artifactsDir: outDir,
    });
  }, 120_000);

  afterAll(async () => {
    await session?.close();
    rmSync(outDir, { recursive: true, force: true });
  });

  it('discovers and opens the side-panel and DevTools documents', async () => {
    expect(session.extension.sidePanel).toBe('sidepanel.html');
    expect(session.extension.devtoolsPage).toBe('devtools.html');
    expect(await (await session.openSidePanel()).textContent('h1')).toBe('Side-panel surface');
    expect(await (await session.openDevtoolsPage()).textContent('h1')).toBe('DevTools surface');
  });

  it('creates, evaluates in, and closes a real offscreen document', async () => {
    await session.createOffscreenDocument(
      'offscreen.html',
      ['DOM_SCRAPING'],
      'Exercise the offscreen test surface',
    );
    expect(session.has('offscreen')).toBe(true);
    expect(await session.evaluate('offscreen', 'document.title')).toBe('Surface offscreen document');
    expect(await session.evaluate('offscreen', 'document.querySelector("main")?.dataset.ready')).toBe('yes');
    await session.closeOffscreenDocument();
    expect(session.has('offscreen')).toBe(false);
  });

  it('dispatches manifest commands through the declared native shortcut', async () => {
    await session.navigate('page', 'https://example.com/', {
      waitUntil: 'domcontentloaded',
      timeout: 20_000,
    });
    expect(await session.triggerCommand('test-command')).toBe('test-command');
    await waitForAsync(async () => (await session.storageGet('lastCommand')) === 'test-command');
    expect(await session.storageGet('lastCommand')).toBe('test-command');
  });

  it('dispatches toolbar-action clicks and context-menu selections', async () => {
    expect(await session.triggerAction()).toBeUndefined();
    await waitForAsync(async () => (await session.storageGet('actionClicked')) === true);
    expect(await session.storageGet('actionTabId')).toEqual(expect.any(Number));
    await session.triggerContextMenu('surface-menu', { pageUrl: 'https://example.com/' });
    await waitForAsync(async () => Boolean(await session.storageGet('lastMenu')));
    expect(await session.storageGet('lastMenu')).toEqual({
      id: 'surface-menu',
      pageUrl: 'https://example.com/',
    });
  });
});

async function activeTabUrl(session: Session): Promise<string> {
  return String(
    await session.evaluate(
      'worker',
      '(async () => (await chrome.tabs.query({ active: true, currentWindow: true }))[0]?.url ?? "")()',
    ),
  );
}

async function waitFor(check: () => boolean, timeout = 10_000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Condition was not met within ${timeout}ms`);
}

async function waitForAsync(check: () => Promise<boolean>, timeout = 10_000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Condition was not met within ${timeout}ms`);
}

async function waitForDownloadState(session: Session, id: number, state: string): Promise<void> {
  await waitForAsync(async () => {
    const current = await session.evaluate(
      'worker',
      '(async () => (await chrome.downloads.search({ id: args }))[0]?.state)()',
      id,
    );
    return current === state;
  });
}

async function downloadServer(
  respond: (path: string, response: ServerResponse) => void,
): Promise<{ url: string; close(): Promise<void> }> {
  const server = createServer((request, response) => respond(request.url ?? '/', response));
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  };
}
