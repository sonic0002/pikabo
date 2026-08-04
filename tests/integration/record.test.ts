import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { record } from '../../src/record/recorder.js';
import { runAndReport } from '../../src/run.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const fixtures = join(root, 'fixtures');
const created: string[] = [];

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ext-record-'));
  created.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('record', () => {
  it('records a session and produces a suite that passes when replayed', async () => {
    const dir = scratch();
    const suiteFile = join(dir, 'recorded.yaml');

    const result = await record({
      extensionPath: join(fixtures, 'sample-extension'),
      outFile: suiteFile,
      headless: true,
      testName: 'counts a click and saves options',
      onReady: async (session) => {
        const popup = session.page('popup');
        await popup.click('#bump');
        await popup.waitForSelector('#status:not(:empty)');

        const options = await session.openOptions();
        await options.selectOption('#theme', 'dark');
        await options.fill('#label', 'Recorded label');
        await options.click('#save-options');
        await options.waitForSelector('#saved:not(:empty)');
      },
    });

    // The steps a person would have written by hand, in the order they happened.
    const steps = result.suite.tests[0]!.steps;
    const actions = steps.map((step) => Object.keys(step)[0]);
    expect(actions).toContain('openPopup');
    expect(actions).toContain('click');
    expect(actions).toContain('openOptions');
    expect(actions).toContain('select');
    expect(actions).toContain('fill');

    // Typing produces one event per keystroke; the recording must not.
    const fills = steps.filter((step) => 'fill' in step);
    expect(fills).toHaveLength(1);
    expect(fills[0]).toMatchObject({ fill: { selector: '#label', value: 'Recorded label' } });

    // Selectors must come from what the author named, not a brittle structural path.
    const yaml = readFileSync(result.file, 'utf8');
    expect(yaml).toMatch(/#bump/);
    expect(yaml).toMatch(/#theme/);
    expect(yaml).not.toMatch(/nth-of-type/);

    // The real test: what was written actually runs.
    const outDir = scratch();
    const replay = await runAndReport(
      [result.file],
      { extensionPath: join(fixtures, 'sample-extension'), outDir, headless: true },
      { reporters: ['json'] },
    );
    expect(
      replay.result.totals.failed,
      replay.result.suites
        .flatMap((s) => s.tests)
        .filter((t) => t.status === 'failed')
        .map((t) => `${t.name}: ${t.error}`)
        .join('\n'),
    ).toBe(0);
    expect(replay.result.totals.passed).toBe(1);
  }, 180_000);

  it('writes an empty suite rather than inventing steps when nothing happened', async () => {
    const dir = scratch();
    const result = await record({
      extensionPath: join(fixtures, 'sample-extension'),
      outFile: join(dir, 'empty.yaml'),
      headless: true,
      addAssertions: false,
      openPopup: false,
      onReady: async () => {},
    });
    expect(result.suite.tests[0]!.steps).toEqual([]);
  }, 120_000);

  it('records a page navigation and keeps page and popup steps in their own contexts', async () => {
    const dir = scratch();
    const result = await record({
      extensionPath: join(fixtures, 'sample-extension'),
      outFile: join(dir, 'contexts.yaml'),
      headless: true,
      url: 'https://example.com/',
      addAssertions: false,
      onReady: async (session) => {
        await session.page('popup').click('#bump');
      },
    });

    const steps = result.suite.tests[0]!.steps;
    expect(steps[0]).toEqual({ navigate: 'https://example.com/' });
    // Switching to the popup has to emit the step that opens it, or replay would click nothing.
    const openIndex = steps.findIndex((step) => 'openPopup' in step);
    const clickIndex = steps.findIndex((step) => 'click' in step);
    expect(openIndex).toBeGreaterThanOrEqual(0);
    expect(openIndex).toBeLessThan(clickIndex);
  }, 180_000);
});
