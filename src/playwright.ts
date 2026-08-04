import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { BrowserContext, Page, Worker } from 'playwright-core';
import type { TestType } from 'playwright/test';
import { Session } from './browser/session.js';

export interface ExtensionFixtureOptions {
  /** Unpacked extension directory. Set this in playwright.config.ts with `use`. */
  extensionPath: string;
  extensionHeadless: boolean;
  extensionBrowserPath?: string;
  extensionBrowserChannel?: string;
  extensionTrace: 'on' | 'off' | 'retain-on-failure';
}

export interface ExtensionFixtures {
  /** The complete pikabo API, for storage, lifecycle, events and extension surfaces. */
  extensionSession: Session;
  /** Persistent context containing the loaded extension. */
  extensionContext: BrowserContext;
  /** Ordinary page the extension should act on. */
  extensionPage: Page;
  /** MV3 background worker. Requested lazily, so extensions without one can use other fixtures. */
  extensionWorker: Worker;
  /** Manifest-declared popup opened as an automatable document. */
  extensionPopup: Page;
  /** Manifest-declared options page. */
  extensionOptions: Page;
  /** Manifest-declared side-panel document. */
  extensionSidePanel: Page;
}

/**
 * Add extension-aware fixtures to an existing Playwright Test instance.
 *
 * The caller supplies its own `test`, so this adapter does not replace Playwright's runner,
 * locators, assertions, retries, workers, reporters, network interception or configuration.
 */
export function createExtensionTest<TestArgs extends {}, WorkerArgs extends {}>(
  base: TestType<TestArgs, WorkerArgs>,
): TestType<TestArgs & ExtensionFixtureOptions & ExtensionFixtures, WorkerArgs> {
  const extensionBase = base as unknown as TestType<{}, {}>;
  const extended = extensionBase.extend<ExtensionFixtureOptions & ExtensionFixtures>({
    extensionPath: ['', { option: true }],
    extensionHeadless: [true, { option: true }],
    extensionBrowserPath: [undefined, { option: true }],
    extensionBrowserChannel: [undefined, { option: true }],
    extensionTrace: ['retain-on-failure', { option: true }],

    extensionSession: async (
      { extensionPath, extensionHeadless, extensionBrowserPath, extensionBrowserChannel, extensionTrace },
      use,
      testInfo,
    ) => {
      if (!extensionPath) {
        throw new Error(
          'extensionPath is required. Set use: { extensionPath: path.resolve("dist/extension") } in playwright.config.ts.',
        );
      }
      const artifactsDir = testInfo.outputPath('extension-artifacts');
      mkdirSync(artifactsDir, { recursive: true });
      const session = await Session.start({
        extensionPath,
        headless: extensionHeadless,
        browserPath: extensionBrowserPath,
        browserChannel: extensionBrowserChannel,
        artifactsDir,
      });
      let tracing = false;
      if (extensionTrace !== 'off') {
        tracing = await session.context.tracing
          .start({ screenshots: true, snapshots: true, sources: true })
          .then(() => true)
          .catch(() => false);
      }
      try {
        await use(session);
      } finally {
        if (tracing) {
          const failed = testInfo.status !== testInfo.expectedStatus;
          const keep = extensionTrace === 'on' || failed;
          if (keep) {
            const tracePath = testInfo.outputPath('extension-trace.zip');
            mkdirSync(dirname(tracePath), { recursive: true });
            const saved = await session.context.tracing
              .stop({ path: tracePath })
              .then(() => true)
              .catch(() => false);
            if (saved) {
              await testInfo.attach('extension-trace', {
                path: tracePath,
                contentType: 'application/zip',
              });
            }
          } else {
            await session.context.tracing.stop().catch(() => undefined);
          }
        }
        await session.close();
      }
    },
    extensionContext: async ({ extensionSession }, use) => await use(extensionSession.context),
    extensionPage: async ({ extensionSession }, use) => await use(extensionSession.page('page')),
    extensionWorker: async ({ extensionSession }, use) => await use(await extensionSession.worker()),
    extensionPopup: async ({ extensionSession }, use) => await use(await extensionSession.openPopup()),
    extensionOptions: async ({ extensionSession }, use) => await use(await extensionSession.openOptions()),
    extensionSidePanel: async ({ extensionSession }, use) => await use(await extensionSession.openSidePanel()),
  });
  return extended as unknown as TestType<TestArgs & ExtensionFixtureOptions & ExtensionFixtures, WorkerArgs>;
}
