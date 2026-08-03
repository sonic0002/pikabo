import { existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { basename, dirname, join, relative } from 'node:path';
import { Session, type SessionOptions } from '../browser/session.js';
import type {
  ConsoleEntry,
  ExtensionInfo,
  RunResult,
  Status,
  Step,
  StepResult,
  Suite,
  SuiteResult,
  Test,
  TestResult,
} from '../types.js';
import { interpolate } from './interpolate.js';
import { readStep } from './parse.js';
import { STEP_HANDLERS, type StepContext } from './steps/index.js';

export type ShotPolicy = 'all' | 'step-end' | 'failures' | 'none';
export type IsolationMode = 'fresh-profile' | 'reset';

export interface RunOptions {
  extensionPath: string;
  outDir: string;
  headless?: boolean;
  browserPath?: string;
  keepProfile?: boolean;
  timeout?: number;
  shots?: ShotPolicy;
  video?: 'on' | 'off' | 'retain-on-failure';
  /**
   * `fresh-profile` launches a clean browser for every test. `reset` reuses one browser and
   * clears the state ext-tester can reach between tests. Defaults to `fresh-profile`.
   */
  isolation?: IsolationMode;
  /** Only run tests whose name matches this substring or /regex/. */
  grep?: string;
  /** Only run tests whose name exactly matches this value. */
  testName?: string;
  /** Stop the whole run after the first failing test. */
  bail?: boolean;
  /** Clear artefacts from the previous run before starting. Defaults to true. */
  clean?: boolean;
  onEvent?: (event: RunEvent) => void;
}

export type RunEvent =
  | { type: 'suite:start'; name: string; file: string }
  | { type: 'suite:end'; name: string; status: Status; durationMs: number }
  | { type: 'test:start'; name: string }
  | { type: 'test:end'; name: string; status: Status; durationMs: number; error?: string }
  | { type: 'step'; result: StepResult };

interface LoadedSuite {
  suite: Suite;
  file: string;
}

/** Steps whose failure is a bug in the extension, not a crash of the tool. */
const DEFAULT_TIMEOUT = 15_000;

export async function runSuites(suites: LoadedSuite[], options: RunOptions): Promise<RunResult> {
  validateRunOptions(options);
  validateTestSelection(suites, options);
  const startedAt = new Date();
  const started = Date.now();
  mkdirSync(options.outDir, { recursive: true });

  const recordVideo = options.video === 'on' || options.video === 'retain-on-failure';
  const sessionOptions: SessionOptions = {
    extensionPath: options.extensionPath,
    headless: options.headless ?? true,
    browserPath: options.browserPath,
    keepProfile: options.keepProfile,
    artifactsDir: options.outDir,
    recordVideo,
  };

  // Fresh profiles are the correctness-first default. Recording also needs one session per test
  // so each video maps cleanly to a single result.
  const isolation = options.isolation ?? 'fresh-profile';
  const perTest = isolation === 'fresh-profile' || recordVideo;
  let shared: Session | undefined;
  let extensionInfo: ExtensionInfo | undefined;
  const results: SuiteResult[] = [];
  // Two suites may share a test name, and one suite may repeat one; artifact directories have to
  // stay distinct regardless.
  const usedKeys = new Set<string>();

  try {
    if (!perTest) {
      shared = await Session.start(sessionOptions);
      extensionInfo = shared.extension;
    }

    outer: for (const { suite, file } of suites) {
      const suiteStarted = Date.now();
      options.onEvent?.({ type: 'suite:start', name: suite.name, file });
      const testResults: TestResult[] = [];

      for (const test of selectTests(suite, options.grep, options.testName)) {
        if (test.skip) {
          testResults.push({ name: test.name, status: 'skipped', durationMs: 0, steps: [], console: [] });
          options.onEvent?.({ type: 'test:end', name: test.name, status: 'skipped', durationMs: 0 });
          continue;
        }

        options.onEvent?.({ type: 'test:start', name: test.name });
        let session = shared;
        if (perTest) session = await Session.start(sessionOptions);
        extensionInfo ??= session!.extension;

        const artifactKey = uniqueArtifactKey(usedKeys, suite.name, test.name);
        const result = await runTest(session!, suite, test, options, artifactKey);
        testResults.push(result);
        options.onEvent?.({
          type: 'test:end',
          name: test.name,
          status: result.status,
          durationMs: result.durationMs,
          error: result.error,
        });

        if (perTest) {
          await session!.close();
          const videos = await collectVideos(session!, options, result, artifactKey);
          if (videos.primary) result.video = videos.primary;
          if (videos.all.length > 1) result.videos = videos.all;
        } else {
          await session!.reset();
        }

        if (options.bail && result.status === 'failed') {
          results.push(summariseSuite(suite, file, testResults, suiteStarted));
          break outer;
        }
      }

      results.push(summariseSuite(suite, file, testResults, suiteStarted));
      const last = results[results.length - 1]!;
      options.onEvent?.({
        type: 'suite:end',
        name: suite.name,
        status: last.status,
        durationMs: last.durationMs,
      });
    }
  } finally {
    if (shared) await shared.close();
  }

  const finished = Date.now();
  return {
    startedAt: startedAt.toISOString(),
    finishedAt: new Date(finished).toISOString(),
    durationMs: finished - started,
    extension: extensionInfo ?? {
      path: options.extensionPath,
      id: '',
      name: basename(options.extensionPath),
      version: '',
      manifestVersion: 0,
      permissions: [],
      hostPermissions: [],
      contentScripts: [],
      commands: {},
      hasServiceWorker: false,
      idSource: 'path-hash',
    },
    browser: {
      name: 'chromium',
      version: '',
      headless: options.headless ?? true,
      executablePath: options.browserPath,
    },
    suites: results,
    totals: tally(results),
  };
}

export function validateRunOptions(options: Pick<RunOptions, 'isolation'>): void {
  if (options.isolation && !['fresh-profile', 'reset'].includes(options.isolation)) {
    throw new Error(
      `Unknown isolation mode ${JSON.stringify(options.isolation)}. Use "fresh-profile" or "reset".`,
    );
  }
}

async function runTest(
  session: Session,
  suite: Suite,
  test: Test,
  options: RunOptions,
  /** Directory under `screenshots/` owned solely by this test, e.g. `my-suite/popup-saves`. */
  artifactKey: string,
): Promise<TestResult> {
  const started = Date.now();
  const steps: StepResult[] = [];
  const consoleStart = session.console.length;
  await session.drainWorkerEvents().catch(() => undefined);
  const eventStart = session.lastEventSequence;
  const shots = options.shots ?? 'step-end';
  // Screenshot filenames carry the step index so they join back to results.json. Pad it so the
  // files also sort into execution order under plain lexicographic sorting — `ls`, zip viewers
  // and CI artifact browsers do not natural-sort, and would otherwise put step 10 before step 2.
  const stepCount =
    (suite.before?.length ?? 0) + test.steps.length + (suite.after?.length ?? 0);
  const indexWidth = Math.max(2, String(Math.max(stepCount - 1, 0)).length);
  const stepLabel = (index: number) => String(index).padStart(indexWidth, '0');
  let downloadCursor = session.downloads.length;
  let last: unknown;
  let failure: string | undefined;

  const scope = { vars: suite.vars ?? {}, last: undefined as unknown };

  const execute = async (list: Step[], phase: 'before' | 'main' | 'after'): Promise<boolean> => {
    for (const step of list) {
      const index = steps.length;
      const { action, options: rawOptions } = readStep(step);
      scope.last = last;
      const resolved = interpolate(rawOptions, scope) as Record<string, unknown>;
      const notes: string[] = [];
      const stepStarted = Date.now();

      const target =
        typeof resolved['in'] === 'string' ? String(resolved['in']) : suite.defaultContext ?? session.active;
      const timeout =
        typeof resolved['timeout'] === 'number'
          ? resolved['timeout']
          : (test.timeout ?? suite.timeout ?? options.timeout ?? DEFAULT_TIMEOUT);

      const ctx: StepContext = {
        session,
        options: resolved,
        target,
        timeout,
        last,
        eventStart,
        downloadStart: downloadCursor,
        consumeDownload: (index) => {
          downloadCursor = Math.max(downloadCursor, index + 1);
        },
        note: (text) => notes.push(text),
        capture: (name, opts) =>
          capture(session, options, target, artifactKey, `${stepLabel(index)}-${slug(name)}`, opts),
      };

      const result: StepResult = {
        index,
        action,
        description: describeStep(action, resolved, phase),
        status: 'passed',
        durationMs: 0,
      };

      try {
        const handler = STEP_HANDLERS[action];
        if (!handler) throw new Error(`No handler for step "${action}".`);
        const value = await handler(ctx);
        if (value !== undefined) {
          result.value = toJsonSafe(value);
          if (action === 'eval') last = value;
        }
        result.status = 'passed';
      } catch (err) {
        result.status = 'failed';
        result.error = cleanError(err);
        failure ??= `${result.description}: ${result.error}`;
      }

      result.durationMs = Date.now() - stepStarted;
      if (notes.length) result.description += ` — ${notes.join('; ')}`;

      const wantShot =
        shots === 'all' ||
        (shots === 'step-end' && (result.status === 'failed' || isVisualStep(action))) ||
        (shots === 'failures' && result.status === 'failed');
      if (wantShot && action !== 'screenshot') {
        result.screenshot = await capture(
          session,
          options,
          target,
          artifactKey,
          `${stepLabel(index)}-${action}`,
        ).catch(() => undefined);
      } else if (action === 'screenshot' && typeof result.value === 'string') {
        result.screenshot = result.value;
        delete result.value;
      }

      steps.push(result);
      options.onEvent?.({ type: 'step', result });

      if (result.status === 'failed') return false;
    }
    return true;
  };

  let ok = true;
  try {
    ok = await execute(suite.before ?? [], 'before');
    if (ok) ok = await execute(test.steps, 'main');
  } catch (err) {
    ok = false;
    failure ??= cleanError(err);
  }
  // `after` runs even when the test failed, so cleanup still happens.
  await execute(suite.after ?? [], 'after').catch(() => false);

  await session.drainWorkerConsole().catch(() => undefined);
  await session.drainWorkerEvents().catch(() => undefined);

  return {
    name: test.name,
    status: ok && !failure ? 'passed' : 'failed',
    durationMs: Date.now() - started,
    steps,
    console: session.console.slice(consoleStart),
    events: session.events.filter((event) => event.sequence > eventStart),
    error: failure,
  };
}

async function capture(
  session: Session,
  options: RunOptions,
  target: string,
  artifactKey: string,
  name: string,
  opts?: { fullPage?: boolean; selector?: string },
): Promise<string> {
  // One directory per test. Step indices restart at zero for every test, so a flat directory
  // lets two tests write `0-openPopup.png` and the second silently overwrites the first — which
  // then shows the wrong screenshot against a failure.
  const dir = join(options.outDir, 'screenshots', artifactKey);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${name}.png`);
  // The worker has nothing to look at; fall back to whatever page is in front.
  const page = session.page(target === 'worker' ? 'page' : target);
  if (opts?.selector) {
    await page.locator(opts.selector).first().screenshot({ path: file });
  } else {
    await page.screenshot({ path: file, fullPage: opts?.fullPage ?? false });
  }
  return relative(options.outDir, file);
}

/**
 * Gather the recordings for a finished test.
 *
 * Playwright records one video per page and names each after an internal hash. A test that opens
 * a popup therefore leaves behind a mostly-blank recording of the background page alongside the
 * interesting one, so the recordings are renamed after the test and the largest is promoted to
 * the test's primary video — file size is a good proxy for where anything actually happened.
 */
async function collectVideos(
  session: Session,
  options: RunOptions,
  result: TestResult,
  artifactKey: string,
): Promise<{ primary?: string; all: string[] }> {
  const discard = options.video === 'retain-on-failure' && result.status !== 'failed';

  const found: { path: string; label: string; size: number }[] = [];
  for (const [label, page] of session.pages) {
    const video = page.video();
    if (!video) continue;
    const path = await video.path().catch(() => undefined);
    if (!path || !existsSync(path)) continue;
    found.push({ path, label, size: statSync(path).size });
  }

  if (discard) {
    for (const { path } of found) rmSync(path, { force: true });
    return { all: [] };
  }

  found.sort((a, b) => b.size - a.size);
  const base = artifactKey.split('/').join('-');
  const all: string[] = [];
  for (const [index, entry] of found.entries()) {
    const target = join(dirname(entry.path), `${base}-${entry.label}${index === 0 ? '' : `-${index}`}.webm`);
    try {
      renameSync(entry.path, target);
      all.push(relative(options.outDir, target));
    } catch {
      all.push(relative(options.outDir, entry.path));
    }
  }
  return { primary: all[0], all };
}

export function selectTests(suite: Suite, grep?: string, testName?: string): Test[] {
  if (!grep && !testName) return suite.tests;
  if (grep && testName) throw new Error('Choose either --test or --grep, not both.');
  if (testName) return suite.tests.map((test) => (test.name === testName ? test : { ...test, skip: true }));
  const pattern = grep!;
  const asRegex = /^\/(.*)\/([gimsuy]*)$/.exec(pattern);
  const test = asRegex
    ? (name: string) => new RegExp(asRegex[1]!, asRegex[2]).test(name)
    : (name: string) => name.toLowerCase().includes(pattern.toLowerCase());
  return suite.tests.map((t) => (test(t.name) ? t : { ...t, skip: true }));
}

export function validateTestSelection(suites: LoadedSuite[], options: Pick<RunOptions, 'grep' | 'testName'>): void {
  if (options.grep && options.testName) throw new Error('Choose either --test or --grep, not both.');
  if (!options.testName) return;
  if (suites.some(({ suite }) => suite.tests.some((test) => test.name === options.testName))) return;

  const available = suites.flatMap(({ suite }) => suite.tests.map((test) => test.name));
  const shown = available.slice(0, 12).map((name) => `  - ${name}`).join('\n');
  const more = available.length > 12 ? `\n  …and ${available.length - 12} more` : '';
  throw new Error(
    `No test named ${JSON.stringify(options.testName)} was found.` +
      (shown ? `\n\nAvailable tests:\n${shown}${more}` : ''),
  );
}

function summariseSuite(suite: Suite, file: string, tests: TestResult[], started: number): SuiteResult {
  const failed = tests.some((t) => t.status === 'failed');
  const allSkipped = tests.length > 0 && tests.every((t) => t.status === 'skipped');
  return {
    name: suite.name,
    file,
    status: failed ? 'failed' : allSkipped ? 'skipped' : 'passed',
    durationMs: Date.now() - started,
    tests,
  };
}

function tally(suites: SuiteResult[]): RunResult['totals'] {
  const tests = suites.flatMap((s) => s.tests);
  return {
    suites: suites.length,
    tests: tests.length,
    passed: tests.filter((t) => t.status === 'passed').length,
    failed: tests.filter((t) => t.status === 'failed').length,
    skipped: tests.filter((t) => t.status === 'skipped').length,
  };
}

function describeStep(action: string, options: Record<string, unknown>, phase: string): string {
  if (typeof options['description'] === 'string') return options['description'];
  const primary =
    options['selector'] ?? options['url'] ?? options['text'] ?? options['key'] ?? options['name'] ??
    options['pattern'] ?? options['context'] ?? options['permission'] ?? options['ms'] ?? options['script'];
  const label = primary == null ? action : `${action} ${truncate(String(primary), 80)}`;
  return phase === 'main' ? label : `[${phase}] ${label}`;
}

/** Steps after which a screenshot is worth having by default. */
function isVisualStep(action: string): boolean {
  return ['navigate', 'openPopup', 'openOptions', 'click', 'fill', 'type', 'press', 'select', 'newTab'].includes(
    action,
  );
}

function cleanError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  // Playwright appends a long "call log" that buries the actual problem.
  return truncate(message.split('\nCall log:')[0]!.trim(), 1200);
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/**
 * A unique `<suite>/<test>` path for one test's artefacts, suffixed if that pair repeats.
 */
function uniqueArtifactKey(used: Set<string>, suiteName: string, testName: string): string {
  const base = `${slug(suiteName)}/${slug(testName)}`;
  let candidate = base;
  for (let n = 2; used.has(candidate); n++) candidate = `${base}-${n}`;
  used.add(candidate);
  return candidate;
}

function slug(text: string): string {
  const cleaned = text
    .replace(/[^a-z0-9._-]+/gi, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();
  // Long test names make unwieldy paths and can breach filesystem limits once nested.
  return (cleaned.length > 60 ? cleaned.slice(0, 60).replace(/-+$/, '') : cleaned) || 'shot';
}

function toJsonSafe(value: unknown): unknown {
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return String(value);
  }
}

export type { ConsoleEntry, LoadedSuite };
