import { mkdtempSync, rmSync } from 'node:fs';
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
    expect(session.extension.name).toBe('ext-tester sample');
    expect(session.extension.manifestVersion).toBe(3);
    expect(session.extension.popup).toBe('popup.html');
  });

  it('opens the popup as a real document', async () => {
    const popup = await session.openPopup();
    expect(popup.url()).toContain(session.extension.id);
    expect(await popup.textContent('h1')).toBe('ext-tester sample');
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
