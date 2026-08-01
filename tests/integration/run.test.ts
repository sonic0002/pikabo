import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { exploreAndRun, runAndReport } from '../../src/run.js';
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
