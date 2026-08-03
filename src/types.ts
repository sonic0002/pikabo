/**
 * Shared types for suites, steps and results.
 *
 * The step vocabulary is deliberately flat: each step is a single-key object
 * (`{ click: "#save" }`) or a key with an options bag (`{ click: { selector, in } }`).
 * That shape is easy for a human to write, easy for an agent to generate, and easy to
 * validate.
 */

/** Which browsing context a step acts on. */
export type ContextName = 'page' | 'popup' | 'options' | 'worker' | string;

export interface Suite {
  /** Human-readable suite name. Defaults to the file basename. */
  name: string;
  /** Path to the unpacked extension. Overrides --ext for this suite. */
  extension?: string;
  /** Default context for steps that do not specify `in`. */
  defaultContext?: ContextName;
  /** Per-step timeout in ms for this suite. */
  timeout?: number;
  /** Steps run before every test in the suite. */
  before?: Step[];
  /** Steps run after every test, including failed ones. */
  after?: Step[];
  /** Tests. A suite with `steps` at the top level is sugar for one test. */
  tests: Test[];
  /** Free-form values interpolated into steps as `${vars.foo}`. */
  vars?: Record<string, unknown>;
}

export interface Test {
  name: string;
  steps: Step[];
  skip?: boolean;
  timeout?: number;
}

/** A step is a single-key record; the key is the action name. */
export type Step = Record<string, unknown>;

export type Status = 'passed' | 'failed' | 'skipped';

export interface StepResult {
  index: number;
  action: string;
  description: string;
  status: Status;
  durationMs: number;
  error?: string;
  /** Path (relative to the output dir) of a screenshot captured for this step. */
  screenshot?: string;
  /** Serialized DOM captured at the failure boundary, relative to the output directory. */
  domSnapshot?: string;
  /** Value returned by an `eval` step, JSON-safe. */
  value?: unknown;
}

export interface ConsoleEntry {
  context: string;
  type: string;
  text: string;
  timestamp: number;
  location?: string;
}

/** A Chrome-extension runtime event observed while a test is running. */
export interface ExtensionEvent {
  /** Monotonically increasing within one browser session. */
  sequence: number;
  /** Dot-separated event name, for example `runtime.message` or `storage.changed`. */
  type: string;
  /** Context that observed the event. */
  source: 'worker' | 'browser';
  timestamp: number;
  /** JSON-safe event payload. */
  detail?: unknown;
}

export interface TestResult {
  name: string;
  status: Status;
  durationMs: number;
  steps: StepResult[];
  console: ConsoleEntry[];
  /** Extension events observed from the start of this test. */
  events?: ExtensionEvent[];
  error?: string;
  /** Composed whole-testcase replay, relative to the output directory. */
  video?: string;
  /** Raw per-page recordings used to compose the testcase replay. */
  videos?: string[];
  /** Why composition failed, while preserving the raw recordings for diagnosis. */
  videoWarning?: string;
  gif?: string;
  /** Playwright trace archive, relative to the output directory. */
  trace?: string;
}

export interface SuiteResult {
  name: string;
  file: string;
  status: Status;
  durationMs: number;
  tests: TestResult[];
  error?: string;
}

export interface RunResult {
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  extension: ExtensionInfo;
  browser: { name: string; channel?: string; version: string; headless: boolean; executablePath?: string };
  suites: SuiteResult[];
  totals: { suites: number; tests: number; passed: number; failed: number; skipped: number };
}

export interface ExtensionInfo {
  path: string;
  id: string;
  name: string;
  version: string;
  manifestVersion: number;
  popup?: string;
  optionsPage?: string;
  /** Manifest-declared side panel document, when present. */
  sidePanel?: string;
  /** Manifest-declared DevTools extension page, when present. */
  devtoolsPage?: string;
  /** MV2 background page, including Chrome's generated scripts page. */
  backgroundPage?: string;
  hasOffscreenPermission?: boolean;
  permissions: string[];
  hostPermissions: string[];
  contentScripts: { matches: string[]; js: string[] }[];
  commands: Record<string, { suggested_key?: unknown; description?: string }>;
  hasServiceWorker: boolean;
  /** How the id was determined — useful when debugging a load failure. */
  idSource: 'service-worker' | 'chrome://extensions' | 'path-hash';
}
