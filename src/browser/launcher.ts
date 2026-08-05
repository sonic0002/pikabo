import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium, type BrowserContext } from 'playwright-core';

export interface LaunchOptions {
  /** Absolute or relative path to the unpacked extension directory. */
  extensionPath: string;
  headless?: boolean;
  /** Use a specific Chromium/Chrome binary instead of Playwright's bundled one. */
  browserPath?: string;
  /** Playwright browser channel, for example `chromium`, `chrome`, or `chrome-beta`. */
  browserChannel?: string;
  /** Keep the temporary profile directory after the run, for debugging. */
  keepProfile?: boolean;
  /** Reuse a fixed profile directory so extension state survives between runs. */
  profileDir?: string;
  /** Directory for downloads and video recordings. */
  artifactsDir?: string;
  recordVideo?: boolean;
  viewport?: { width: number; height: number };
  /** Extra Chromium switches, appended after the defaults. */
  extraArgs?: string[];
  /** Open a loopback DevTools port so worker startup logs can be captured. Default true. */
  debugPort?: boolean;
  /** Locale forced on the browser, so date/number assertions are stable. */
  locale?: string;
  timezone?: string;
}

export interface LaunchedBrowser {
  context: BrowserContext;
  profileDir: string;
  headless: boolean;
  executablePath?: string;
  channel: string;
  version: string;
  close(): Promise<void>;
}

export const DEFAULT_VIEWPORT = { width: 1280, height: 800 };

/**
 * Headless runs need a deterministic viewport for screenshots. In headed mode, leaving the
 * viewport unset lets Chromium use the real maximized window instead of emulating a fixed page
 * size that may be clipped on the developer's display.
 */
export function windowSettings(options: Pick<LaunchOptions, 'headless' | 'viewport'>): {
  viewport: { width: number; height: number } | null;
  args: string[];
} {
  const headless = options.headless ?? true;
  if (options.viewport) return { viewport: options.viewport, args: [] };
  return headless
    ? { viewport: DEFAULT_VIEWPORT, args: [] }
    : { viewport: null, args: ['--start-maximized'] };
}

/**
 * The switches that make extension loading work.
 *
 * `--load-extension` is the switch stable Chrome 137+ ignores; the accompanying feature flag is
 * what re-enables it. Playwright's bundled Chromium does not carry that restriction, but the
 * flag is harmless there and makes `--browser-path` against a stable Chrome work too.
 */
export function extensionArgs(extensionPath: string): string[] {
  const abs = resolve(extensionPath);
  return [
    `--disable-extensions-except=${abs}`,
    `--load-extension=${abs}`,
    '--disable-features=DisableLoadExtensionCommandLineSwitch',
  ];
}

/** Switches that keep a fresh profile from interrupting the run with first-run UI. */
export const QUIET_ARGS = [
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-search-engine-choice-screen',
  '--disable-component-update',
  '--disable-background-networking',
  '--disable-client-side-phishing-detection',
  '--disable-sync',
  '--metrics-recording-only',
  '--no-service-autorun',
  '--password-store=basic',
  '--use-mock-keychain',
  '--propagate-iph-for-testing',
];

/**
 * Opens a DevTools endpoint on a random loopback port, which is how the service worker's console
 * is captured from its first line. Playwright drives the browser over its own pipe, so the two
 * coexist. Pass `debugPort: false` to leave it closed.
 */
export const DEBUG_PORT_ARG = '--remote-debugging-port=0';

export async function launchBrowser(options: LaunchOptions): Promise<LaunchedBrowser> {
  const headless = options.headless ?? true;
  const window = windowSettings(options);
  const profileDir = options.profileDir
    ? resolve(options.profileDir)
    : mkdtempSync(join(tmpdir(), 'pikabo-profile-'));

  const args = [
    ...extensionArgs(options.extensionPath),
    ...QUIET_ARGS,
    ...window.args,
    ...(options.debugPort === false ? [] : [DEBUG_PORT_ARG]),
    ...(options.extraArgs ?? []),
  ];

  let context: BrowserContext;
  const channel = options.browserPath
    ? 'custom'
    : options.browserChannel ?? process.env['PIKABO_BROWSER_CHANNEL'] ?? 'chromium';
  try {
    context = await chromium.launchPersistentContext(profileDir, {
      // Extensions do not load in the headless shell. `channel: 'chromium'` selects the full
      // browser build, whose headless mode is the real browser and does support them.
      channel: options.browserPath ? undefined : channel,
      executablePath: options.browserPath,
      headless,
      args,
      viewport: window.viewport,
      acceptDownloads: true,
      locale: options.locale ?? 'en-US',
      timezoneId: options.timezone,
      ...(options.recordVideo && options.artifactsDir
        ? { recordVideo: { dir: join(options.artifactsDir, 'videos') } }
        : {}),
    });
  } catch (err) {
    if (!options.profileDir && !options.keepProfile) rmSync(profileDir, { recursive: true, force: true });
    throw new BrowserLaunchError(err as Error, options);
  }

  return {
    context,
    profileDir,
    headless,
    executablePath: options.browserPath,
    channel,
    version: context.browser()?.version() ?? '',
    async close() {
      await context.close().catch(() => undefined);
      if (!options.profileDir && !options.keepProfile) {
        rmSync(profileDir, { recursive: true, force: true });
      }
    },
  };
}

export class BrowserLaunchError extends Error {
  constructor(cause: Error, options: LaunchOptions) {
    const hint = /Executable doesn't exist|Chromium distribution/.test(cause.message)
      ? "\n\nChromium is not installed. Run:\n  npx playwright-core install chromium\n\nOr point at an existing browser with --browser-path."
      : '\n\nRun `pikabo doctor` to check the environment.';
    super(`Failed to launch the browser for ${options.extensionPath}: ${cause.message}${hint}`);
    this.name = 'BrowserLaunchError';
    this.cause = cause;
  }
}
