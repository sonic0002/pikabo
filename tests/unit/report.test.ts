import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { renderHtml } from '../../src/report/html.js';
import { renderMarkdown } from '../../src/report/markdown.js';
import type { RunResult } from '../../src/types.js';

function fixtureResult(overrides: Partial<RunResult> = {}): RunResult {
  return {
    startedAt: '2026-08-01T10:00:00.000Z',
    finishedAt: '2026-08-01T10:00:05.000Z',
    durationMs: 5000,
    extension: {
      path: '/tmp/ext',
      id: 'a'.repeat(32),
      name: 'Sample <Extension>',
      version: '1.2.3',
      manifestVersion: 3,
      popup: 'popup.html',
      permissions: ['storage'],
      hostPermissions: [],
      contentScripts: [],
      commands: {},
      hasServiceWorker: true,
      idSource: 'service-worker',
    },
    browser: { name: 'chromium', version: '130', headless: true },
    suites: [
      {
        name: 'suite one',
        file: 'tests/one.yaml',
        status: 'failed',
        durationMs: 5000,
        tests: [
          {
            name: 'passing test',
            status: 'passed',
            durationMs: 1200,
            console: [],
            steps: [{ index: 0, action: 'openPopup', description: 'openPopup', status: 'passed', durationMs: 300 }],
          },
          {
            name: 'failing test',
            status: 'failed',
            durationMs: 3800,
            error: 'assertVisible: Expected "#missing" to be visible.',
            console: [
              { context: 'popup', type: 'error', text: 'TypeError: boom', timestamp: 1 },
              { context: 'worker', type: 'log', text: 'started', timestamp: 2 },
            ],
            steps: [
              {
                index: 0,
                action: 'assertVisible',
                description: 'assertVisible #missing',
                status: 'failed',
                durationMs: 3000,
                error: 'Expected "#missing" to be visible.',
                screenshot: 'screenshots/0-assertVisible.png',
              },
            ],
          },
        ],
      },
    ],
    totals: { suites: 1, tests: 2, passed: 1, failed: 1, skipped: 0 },
    ...overrides,
  };
}

describe('renderMarkdown', () => {
  it('leads with the verdict', () => {
    const md = renderMarkdown(fixtureResult());
    expect(md).toMatch(/❌ 1 failed/);
    expect(md).toMatch(/1\/2 passed/);
  });

  it('reports all-passing runs without a failures section', () => {
    const result = fixtureResult();
    result.suites[0]!.tests = [result.suites[0]!.tests[0]!];
    result.suites[0]!.status = 'passed';
    result.totals = { suites: 1, tests: 1, passed: 1, failed: 0, skipped: 0 };
    const md = renderMarkdown(result);
    expect(md).toMatch(/✅ all passed/);
    expect(md).not.toMatch(/## Failures/);
  });

  it('includes the failing step, its error and console errors', () => {
    const md = renderMarkdown(fixtureResult());
    expect(md).toMatch(/## Failures/);
    expect(md).toMatch(/assertVisible/);
    expect(md).toMatch(/Expected "#missing" to be visible/);
    expect(md).toMatch(/\[popup\] TypeError: boom/);
  });

  it('escapes pipes so the table survives', () => {
    const result = fixtureResult();
    result.suites[0]!.tests[0]!.name = 'a | b';
    expect(renderMarkdown(result)).toMatch(/a \\\| b/);
  });
});

describe('renderHtml', () => {
  const outDir = mkdtempSync(join(tmpdir(), 'ext-report-'));

  it('produces a standalone document', () => {
    const html = renderHtml(fixtureResult(), outDir);
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toMatch(/<style>/);
    expect(html).not.toMatch(/<link[^>]+href="http/);
    expect(html).not.toMatch(/<script[^>]+src=/);
  });

  it('escapes untrusted text from the extension and from errors', () => {
    const html = renderHtml(fixtureResult(), outDir);
    expect(html).toMatch(/Sample &lt;Extension&gt;/);
    expect(html).not.toMatch(/<Extension>/);
  });

  it('marks the run as failed and shows both tests', () => {
    const html = renderHtml(fixtureResult(), outDir);
    expect(html).toMatch(/class="has-failures"/);
    expect(html).toMatch(/passing test/);
    expect(html).toMatch(/failing test/);
    expect(html).toMatch(/1 failed/);
  });

  it('opens failing tests by default', () => {
    const html = renderHtml(fixtureResult(), outDir);
    const failingBlock = html.slice(html.indexOf('failing test') - 400, html.indexOf('failing test'));
    expect(failingBlock).toMatch(/<details class="test failed" open>/);
  });

  it('degrades gracefully when a screenshot file is missing', () => {
    const html = renderHtml(fixtureResult(), outDir);
    expect(html).not.toMatch(/<img[^>]+src="undefined"/);
  });
});
