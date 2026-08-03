import { resolve } from 'node:path';
import type { BrowserContext, Worker } from 'playwright-core';
import { computeUnpackedExtensionId, extensionIdFromUrl, isValidExtensionId } from './extension-id.js';
import {
  hasServiceWorker,
  backgroundPath,
  devtoolsPath,
  optionsPath,
  popupPath,
  readManifest,
  resolveMessages,
  sidePanelPath,
  type RawManifest,
} from './manifest.js';
import type { ExtensionInfo } from '../types.js';

export class ExtensionLoadError extends Error {
  constructor(message: string, readonly details?: string) {
    super(details ? `${message}\n\n${details}` : message);
    this.name = 'ExtensionLoadError';
  }
}

export interface ResolveOptions {
  /** How long to wait for the service worker to appear, in ms. */
  timeout?: number;
}

/**
 * Work out the identity of the extension that was just loaded.
 *
 * Three strategies in order of reliability. The one that succeeded is recorded on the result,
 * because when something is wrong it is usually the first thing worth knowing.
 */
export async function resolveExtension(
  context: BrowserContext,
  extensionPath: string,
  options: ResolveOptions = {},
): Promise<ExtensionInfo> {
  const dir = resolve(extensionPath);
  const manifest = readManifest(dir);
  const timeout = options.timeout ?? 15_000;

  let id: string | undefined;
  let idSource: ExtensionInfo['idSource'] = 'path-hash';

  if (hasServiceWorker(manifest)) {
    const worker = await waitForServiceWorker(context, timeout).catch(() => undefined);
    if (worker) {
      id = extensionIdFromUrl(worker.url());
      idSource = 'service-worker';
    }
  }

  if (!id) {
    id = await readIdFromExtensionsPage(context, dir).catch(() => undefined);
    if (id) idSource = 'chrome://extensions';
  }

  if (!id) {
    id = computeUnpackedExtensionId(dir);
    idSource = 'path-hash';
  }

  if (!isValidExtensionId(id)) {
    throw new ExtensionLoadError(
      `Could not determine the extension ID for ${dir}`,
      await collectLoadErrors(context).catch(() => undefined),
    );
  }

  // Verify the extension is actually reachable. A path-hash ID for an extension Chrome refused
  // to load would otherwise produce a confusing "page not found" later.
  const reachable = await isExtensionReachable(context, id);
  if (!reachable) {
    throw new ExtensionLoadError(
      `Chrome did not load the extension at ${dir}`,
      (await collectLoadErrors(context).catch(() => undefined)) ??
        'Check manifest.json for syntax errors, and that every file it references exists.',
    );
  }

  return {
    path: dir,
    id,
    name: resolveMessages(dir, manifest, manifest.name) ?? 'unnamed extension',
    version: manifest.version ?? '0.0.0',
    manifestVersion: manifest.manifest_version ?? 2,
    popup: popupPath(manifest),
    optionsPage: optionsPath(manifest),
    sidePanel: sidePanelPath(manifest),
    devtoolsPage: devtoolsPath(manifest),
    backgroundPage: backgroundPath(manifest),
    hasOffscreenPermission: (manifest.permissions ?? []).includes('offscreen'),
    permissions: manifest.permissions ?? [],
    hostPermissions: manifest.host_permissions ?? [],
    contentScripts: (manifest.content_scripts ?? []).map((cs) => ({
      matches: cs.matches ?? [],
      js: cs.js ?? [],
    })),
    commands: manifest.commands ?? {},
    hasServiceWorker: hasServiceWorker(manifest),
    idSource,
  };
}

export async function waitForServiceWorker(context: BrowserContext, timeout: number): Promise<Worker> {
  const existing = context.serviceWorkers().find((w) => w.url().startsWith('chrome-extension://'));
  if (existing) return existing;
  return await context.waitForEvent('serviceworker', {
    timeout,
    predicate: (w) => w.url().startsWith('chrome-extension://'),
  });
}

/**
 * Read the extension ID out of `chrome://extensions`. The page is a nest of shadow roots, so
 * this walks them rather than using a selector.
 */
async function readIdFromExtensionsPage(context: BrowserContext, dir: string): Promise<string | undefined> {
  const page = await context.newPage();
  try {
    await page.goto('chrome://extensions', { waitUntil: 'domcontentloaded' });
    const items = await page.evaluate(() => {
      const manager = document.querySelector('extensions-manager');
      const itemList = manager?.shadowRoot?.querySelector('extensions-item-list');
      const items = itemList?.shadowRoot?.querySelectorAll('extensions-item') ?? [];
      return [...items].map((item) => ({
        id: item.getAttribute('id') ?? '',
        // The source path is shown only in developer mode, but the id is enough on its own
        // when there is exactly one extension loaded.
        name: item.shadowRoot?.querySelector('#name')?.textContent?.trim() ?? '',
      }));
    });
    if (items.length === 1) return items[0]!.id || undefined;
    const manifestName = readManifest(dir).name;
    return items.find((i) => i.name && manifestName?.includes(i.name))?.id;
  } finally {
    await page.close().catch(() => undefined);
  }
}

/** Scrape whatever Chrome is complaining about, so a load failure has a real explanation. */
export async function collectLoadErrors(context: BrowserContext): Promise<string | undefined> {
  const page = await context.newPage();
  try {
    await page.goto('chrome://extensions', { waitUntil: 'domcontentloaded' });
    const text = await page.evaluate(() => {
      const manager = document.querySelector('extensions-manager');
      const root = manager?.shadowRoot;
      const errorPage = root?.querySelector('extensions-error-page');
      const list = root?.querySelector('extensions-item-list');
      const collected: string[] = [];
      const scan = (node: Element | ShadowRoot | null | undefined, depth = 0) => {
        if (!node || depth > 6) return;
        for (const el of [...(node.querySelectorAll?.('*') ?? [])]) {
          const t = el.textContent?.trim();
          if (t && /error|failed|invalid|could not|manifest/i.test(t) && t.length < 400) collected.push(t);
          if ((el as HTMLElement & { shadowRoot?: ShadowRoot }).shadowRoot) {
            scan((el as HTMLElement & { shadowRoot?: ShadowRoot }).shadowRoot, depth + 1);
          }
        }
      };
      scan(errorPage?.shadowRoot ?? list?.shadowRoot);
      return [...new Set(collected)].slice(0, 5).join('\n');
    });
    return text || undefined;
  } finally {
    await page.close().catch(() => undefined);
  }
}

async function isExtensionReachable(context: BrowserContext, id: string): Promise<boolean> {
  if (context.serviceWorkers().some((w) => w.url().includes(id))) return true;
  const page = await context.newPage();
  try {
    const response = await page.goto(`chrome-extension://${id}/manifest.json`, {
      waitUntil: 'domcontentloaded',
      timeout: 5_000,
    });
    if (!response) return false;
    const body = await page.content();
    return body.includes('manifest_version') || body.includes('"name"');
  } catch {
    return false;
  } finally {
    await page.close().catch(() => undefined);
  }
}

/** Absolute URL for a path inside the extension. */
export function extensionUrl(info: ExtensionInfo, path: string): string {
  const clean = path.replace(/^\/+/, '').split('#')[0]!.split('?')[0]!;
  const suffix = path.slice(clean.length ? path.indexOf(clean) + clean.length : 0);
  return `chrome-extension://${info.id}/${clean}${suffix}`;
}

export type { RawManifest };
