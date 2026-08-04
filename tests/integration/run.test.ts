import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { exploreAndRun, runAndReport } from '../../src/run.js';
import { hasFfmpeg } from '../../src/report/video.js';
import type { RunResult } from '../../src/types.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const fixtures = join(root, 'fixtures');
const created: string[] = [];

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ext-run-'));
  created.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('running a suite end to end', () => {
  it('passes every test in the sample suite and writes all three reports', async () => {
    const outDir = scratch();
    const { result, reports } = await runAndReport(
      [join(root, 'tests/suites/sample.yaml')],
      {
        extensionPath: join(fixtures, 'sample-extension'),
        outDir,
        headless: true,
        shots: 'step-end',
      },
      { reporters: ['html', 'json', 'md'] },
    );

    expect(result.totals.failed, failureDetail(result)).toBe(0);
    expect(result.totals.passed).toBe(result.totals.tests);
    expect(result.totals.tests).toBeGreaterThanOrEqual(7);

    expect(existsSync(reports.html!)).toBe(true);
    expect(existsSync(reports.json!)).toBe(true);
    expect(existsSync(reports.markdown!)).toBe(true);

    const html = readFileSync(reports.html!, 'utf8');
    expect(html).toMatch(/data:image\/png;base64,/);
    expect(html).not.toMatch(/src="(https?:)?\/\//);

    const json = JSON.parse(readFileSync(reports.json!, 'utf8')) as RunResult;
    expect(json.extension.name).toBe('ext-tester sample');
    expect(json.browser.version).toMatch(/^\d+/);
    expect(json.browser.channel).toBeTruthy();
    expect(json.suites[0]!.tests.every((t) => t.steps.length > 0)).toBe(true);
  }, 180_000);

  it('records a screenshot for interactive steps', async () => {
    const outDir = scratch();
    const { result } = await runAndReport(
      [join(root, 'tests/suites/sample.yaml')],
      { extensionPath: join(fixtures, 'sample-extension'), outDir, headless: true, shots: 'all', grep: 'options page' },
      { reporters: ['json'] },
    );
    const test = result.suites[0]!.tests.find((t) => t.status !== 'skipped')!;
    const shots = test.steps.filter((s) => s.screenshot);
    expect(shots.length).toBeGreaterThan(0);
    for (const step of shots) expect(existsSync(join(outDir, step.screenshot!))).toBe(true);
  }, 180_000);

  it('composes one labelled testcase video and preserves its raw context recordings', async () => {
    if (!(await hasFfmpeg())) return;
    const outDir = scratch();
    const suite = join(outDir, 'video.yaml');
    const { writeFileSync } = await import('node:fs');
    writeFileSync(
      suite,
      `name: composed video
tests:
  - name: page popup page
    steps:
      - navigate: https://example.com/
      - openPopup
      - click: "#bump"
      - closePopup
`,
    );
    const { result } = await runAndReport(
      [suite],
      {
        extensionPath: join(fixtures, 'sample-extension'),
        outDir,
        headless: true,
        video: 'on',
        trace: 'off',
      },
      { reporters: ['json', 'html'] },
    );
    const test = result.suites[0]!.tests[0]!;
    expect(test.status, failureDetail(result)).toBe('passed');
    expect(test.video).toMatch(/^videos\/.+\.webm$/);
    expect(test.videoWarning).toBeUndefined();
    expect(test.videos?.length).toBeGreaterThanOrEqual(2);
    expect(statSync(join(outDir, test.video!)).size).toBeGreaterThan(1000);
    for (const raw of test.videos ?? []) {
      expect(raw).toContain('videos/raw/');
      expect(statSync(join(outDir, raw)).size).toBeGreaterThan(0);
    }
  }, 180_000);

  it('gives every test its own screenshot directory, losing none', async () => {
    const outDir = scratch();
    const { result } = await runAndReport(
      [join(root, 'tests/suites/sample.yaml')],
      { extensionPath: join(fixtures, 'sample-extension'), outDir, headless: true, shots: 'all' },
      { reporters: ['json'] },
    );

    const shots = result.suites
      .flatMap((s) => s.tests)
      .flatMap((t) => t.steps)
      .map((s) => s.screenshot)
      .filter((s): s is string => Boolean(s));

    // Several tests in this suite open with `openPopup`, so step indices repeat across them. A
    // flat directory would let the later ones overwrite the earlier, and the report would show
    // one test's screenshot against another's failure.
    expect(shots.length).toBeGreaterThan(10);
    expect(new Set(shots).size, 'screenshot paths must be unique across tests').toBe(shots.length);
    for (const shot of shots) expect(existsSync(join(outDir, shot)), `missing ${shot}`).toBe(true);

    // Each test owns one directory, and no two tests share one.
    const dirByTest = new Map<string, Set<string>>();
    for (const suite of result.suites) {
      for (const test of suite.tests) {
        for (const step of test.steps) {
          if (!step.screenshot) continue;
          const dir = dirname(step.screenshot);
          dirByTest.set(test.name, (dirByTest.get(test.name) ?? new Set()).add(dir));
        }
      }
    }
    for (const [name, dirs] of dirByTest) {
      expect(dirs.size, `${name} scattered across ${[...dirs].join(', ')}`).toBe(1);
    }
    const allDirs = [...dirByTest.values()].map((d) => [...d][0]!);
    expect(new Set(allDirs).size, 'two tests share a directory').toBe(allDirs.length);

    // Filenames must sort into execution order under plain lexicographic sorting, which is what
    // `ls`, zip viewers and CI artifact browsers use. Unpadded indices put step 10 before step 2.
    for (const suite of result.suites) {
      for (const test of suite.tests) {
        const captured = test.steps.filter((s) => s.screenshot);
        if (captured.length < 2) continue;
        const executionOrder = captured.map((s) => basename(s.screenshot!));
        const lexicographic = [...executionOrder].sort();
        expect(lexicographic, `${test.name} screenshots do not sort into execution order`).toEqual(
          executionOrder,
        );
        for (const file of executionOrder) expect(file).toMatch(/^\d{2,}-/);
      }
    }
  }, 180_000);

  it('runs only the tests matching --grep', async () => {
    const outDir = scratch();
    const { result } = await runAndReport(
      [join(root, 'tests/suites/sample.yaml')],
      { extensionPath: join(fixtures, 'sample-extension'), outDir, headless: true, grep: 'downloads' },
      { reporters: ['json'] },
    );
    expect(result.totals.passed).toBe(1);
    expect(result.totals.skipped).toBeGreaterThan(0);
  }, 180_000);

  it('runs one test whose name exactly matches --test', async () => {
    const outDir = scratch();
    const testName = 'declared permissions are actually held';
    const { result } = await runAndReport(
      [join(root, 'tests/suites/sample.yaml')],
      { extensionPath: join(fixtures, 'sample-extension'), outDir, headless: true, testName },
      { reporters: ['json'] },
    );
    expect(result.totals.passed).toBe(1);
    expect(result.totals.skipped).toBeGreaterThan(0);
    expect(result.suites[0]!.tests.find((test) => test.status === 'passed')?.name).toBe(testName);
  }, 180_000);

  it('reports a failing assertion with the real cause instead of a timeout', async () => {
    const outDir = scratch();
    const suite = join(outDir, 'failing.yaml');
    const { writeFileSync } = await import('node:fs');
    writeFileSync(
      suite,
      `name: deliberate failure
tests:
  - name: asserts something untrue
    steps:
      - openPopup
      - assertText:
          selector: "#count"
          equals: "999"
`,
    );
    const { result } = await runAndReport(
      [suite],
      { extensionPath: join(fixtures, 'sample-extension'), outDir, headless: true, timeout: 4000 },
      { reporters: ['json', 'md'] },
    );
    expect(result.totals.failed).toBe(1);
    const failing = result.suites[0]!.tests[0]!.steps.find((s) => s.status === 'failed')!;
    expect(failing.action).toBe('assertText');
    expect(failing.error).toMatch(/Expected "#count" to equal "999", but its text is "0"/);
    expect(failing.screenshot).toBeTruthy();
    expect(failing.domSnapshot).toBeTruthy();
    expect(existsSync(join(outDir, failing.domSnapshot!))).toBe(true);
    const failedTest = result.suites[0]!.tests[0]!;
    expect(failedTest.trace).toBeTruthy();
    expect(existsSync(join(outDir, failedTest.trace!))).toBe(true);
  }, 180_000);

  it('continues past a failing test so the report is complete', async () => {
    const outDir = scratch();
    const suite = join(outDir, 'mixed.yaml');
    const { writeFileSync } = await import('node:fs');
    writeFileSync(
      suite,
      `name: mixed
tests:
  - name: fails
    steps:
      - openPopup
      - assertVisible: "#definitely-not-here"
  - name: passes afterwards
    steps:
      - openPopup
      - assertVisible: "#bump"
`,
    );
    const { result } = await runAndReport(
      [suite],
      { extensionPath: join(fixtures, 'sample-extension'), outDir, headless: true, timeout: 3000 },
      { reporters: ['json'] },
    );
    expect(result.totals.failed).toBe(1);
    expect(result.totals.passed).toBe(1);
  }, 180_000);

  it('uses a fresh browser profile per test by default', async () => {
    const outDir = scratch();
    const suite = join(outDir, 'isolation.yaml');
    const { writeFileSync } = await import('node:fs');
    writeFileSync(
      suite,
      `name: isolation
tests:
  - name: leaves state behind
    steps:
      - setStorage:
          key: shouldNotLeak
          value: dirty
      - assertStorage:
          key: shouldNotLeak
          equals: dirty
  - name: receives a clean profile
    steps:
      - assertStorage:
          key: shouldNotLeak
          exists: false
`,
    );
    const { result } = await runAndReport(
      [suite],
      { extensionPath: join(fixtures, 'sample-extension'), outDir, headless: true },
      { reporters: ['json'] },
    );
    expect(result.totals.failed, failureDetail(result)).toBe(0);
    expect(result.totals.passed).toBe(2);
  }, 180_000);

  it('reset mode reuses a cleaned profile but relaunches Chrome to clear worker memory', async () => {
    const outDir = scratch();
    const suite = join(outDir, 'reset-isolation.yaml');
    const { writeFileSync } = await import('node:fs');
    writeFileSync(
      suite,
      `name: reset isolation
tests:
  - name: leaves every kind of state behind
    steps:
      - setStorage:
          key: resetLeak
          value: dirty
      - eval:
          in: worker
          script: self.__resetLeak = 'dirty'; return true
      - navigate: https://example.com/?reset-leak
      - eval:
          script: localStorage.setItem('resetLeak', 'dirty'); return true
  - name: receives the cleaned reusable profile
    steps:
      - assertStorage:
          key: resetLeak
          exists: false
      - eval:
          in: worker
          script: self.__resetLeak === undefined
      - expect:
          truthy: true
      - navigate: https://example.com/?reset-clean
      - eval:
          script: localStorage.getItem('resetLeak') === null
      - expect:
          truthy: true
`,
    );
    const { result } = await runAndReport(
      [suite],
      {
        extensionPath: join(fixtures, 'sample-extension'),
        outDir,
        headless: true,
        isolation: 'reset',
      },
      { reporters: ['json'] },
    );
    expect(result.totals.failed, failureDetail(result)).toBe(0);
    expect(result.totals.passed).toBe(2);
    for (const test of result.suites[0]!.tests) {
      expect(test.events?.some((event) => event.type === 'worker.coldStarted')).toBe(true);
    }
  }, 180_000);
});

describe('permission audit', () => {
  it('distinguishes permissions the extension really uses from ones it only declares', async () => {
    const outDir = scratch();
    const { result } = await runAndReport(
      [join(root, 'tests/suites/sample.yaml')],
      { extensionPath: join(fixtures, 'sample-extension'), outDir, headless: true },
      { reporters: ['json', 'md'] },
    );

    const audit = result.permissions!;
    expect(audit).toBeDefined();

    // The fixture stores settings and downloads files, so both must register as used.
    const used = audit.findings.filter((f) => f.verdict === 'used').map((f) => f.permission);
    expect(used).toContain('storage');
    expect(used).toContain('downloads');

    // It declares `tabs` and never calls chrome.tabs — the case this feature exists to catch.
    const tabs = audit.findings.find((f) => f.permission === 'tabs');
    expect(tabs?.verdict).toBe('not-observed');
    expect(audit.unusedCount).toBeGreaterThanOrEqual(1);

    // ext-tester reads chrome.storage itself to implement assertStorage; that must not be what
    // makes `storage` look used, and it must never invent usage of anything else.
    expect(audit.undeclaredCount).toBe(0);
    expect(audit.observed).not.toContain('permissions');
    expect(audit.lowCoverage).toBe(false);

    const summary = readFileSync(join(outDir, 'summary.md'), 'utf8');
    expect(summary).toMatch(/## Permissions/);
    expect(summary).toMatch(/tabs/);
  }, 180_000);

  it('does not credit an extension for APIs only ext-tester touched', async () => {
    // no-worker-extension declares no permissions at all, so any finding would be invented.
    const outDir = scratch();
    const suite = join(outDir, 'bare.yaml');
    writeFileSync(
      suite,
      `name: bare\ntests:\n  - name: loads a page\n    steps:\n      - navigate: https://example.com/\n`,
    );
    const { result } = await runAndReport(
      [suite],
      { extensionPath: join(fixtures, 'no-worker-extension'), outDir, headless: true },
      { reporters: ['json'] },
    );
    expect(result.permissions!.findings).toEqual([]);
    expect(result.permissions!.undeclaredCount).toBe(0);
  }, 180_000);
});

describe('explore', () => {
  it('generates and passes a smoke suite with no hand-written test', async () => {
    const outDir = scratch();
    const suiteFile = join(outDir, 'smoke.generated.yaml');
    const { result, suite } = await exploreAndRun(
      join(fixtures, 'sample-extension'),
      suiteFile,
      { extensionPath: join(fixtures, 'sample-extension'), outDir, headless: true },
      { reporters: ['json', 'html'] },
    );
    expect(existsSync(suiteFile)).toBe(true);
    expect(suite.tests.length).toBeGreaterThanOrEqual(4);
    expect(result.totals.failed, failureDetail(result)).toBe(0);
  }, 180_000);

  it('fails the broken extension and names the actual cause', async () => {
    const outDir = scratch();
    const { result } = await exploreAndRun(
      join(fixtures, 'broken-extension'),
      join(outDir, 'smoke.generated.yaml'),
      { extensionPath: join(fixtures, 'broken-extension'), outDir, headless: true },
      { reporters: ['json', 'md'] },
    );
    expect(result.totals.failed).toBeGreaterThan(0);
    const allErrors = result.suites
      .flatMap((s) => s.tests)
      .flatMap((t) => [t.error ?? '', ...t.console.map((c) => c.text)])
      .join('\n');
    expect(allErrors).toMatch(/undefinedFunctionThatDoesNotExist/);
    expect(allErrors).toMatch(/Cannot set properties of null/);
  }, 180_000);
});

function failureDetail(result: RunResult): string {
  return result.suites
    .flatMap((s) => s.tests)
    .filter((t) => t.status === 'failed')
    .map((t) => `${t.name}: ${t.error}`)
    .join('\n');
}
