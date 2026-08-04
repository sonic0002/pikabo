import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { RunResult, TestResult } from '../types.js';

/**
 * The cheapest artifact to read back. Deliberately short: totals, a table, and the detail of
 * failures only. Passing tests get one line each.
 */
export function renderMarkdown(result: RunResult): string {
  const { totals } = result;
  const verdict = totals.failed > 0 ? `❌ ${totals.failed} failed` : '✅ all passed';
  const lines: string[] = [];

  lines.push(`# ${result.extension.name} — extension test report`);
  lines.push('');
  lines.push(
    `**${verdict}** · ${totals.passed}/${totals.tests} passed` +
      (totals.skipped ? ` · ${totals.skipped} skipped` : '') +
      ` · ${formatMs(result.durationMs)}`,
  );
  lines.push('');
  lines.push(
    `\`${result.extension.id}\` · v${result.extension.version} · MV${result.extension.manifestVersion} · ` +
      `${result.browser.headless ? 'headless' : 'headed'} ${result.browser.channel ?? result.browser.name}` +
      (result.browser.version ? ` ${result.browser.version}` : ''),
  );
  lines.push('');

  lines.push('| Suite | Test | Result | Steps | Time |');
  lines.push('| --- | --- | --- | --- | --- |');
  for (const suite of result.suites) {
    for (const test of suite.tests) {
      lines.push(
        `| ${escapeCell(suite.name)} | ${escapeCell(test.name)} | ${icon(test.status)} | ${test.steps.length} | ${formatMs(test.durationMs)} |`,
      );
    }
  }
  lines.push('');

  const videoWarnings = result.suites.flatMap((suite) =>
    suite.tests.flatMap((test) => (test.videoWarning ? [`${suite.name} › ${test.name}: ${test.videoWarning}`] : [])),
  );
  if (videoWarnings.length) {
    lines.push('## Video warnings', '');
    for (const warning of videoWarnings) lines.push(`- ${warning}`);
    lines.push('');
  }

  const audit = result.permissions;
  if (audit && (audit.unusedCount || audit.undeclaredCount)) {
    lines.push('## Permissions', '');
    if (audit.undeclaredCount) {
      lines.push(
        `**${audit.undeclaredCount} used but not declared.** These calls fail in a real install, ` +
          'where the namespace is undefined.',
        '',
      );
    }
    if (audit.unusedCount) {
      lines.push(
        audit.lowCoverage
          ? `**${audit.unusedCount} declared but not observed — but this run barely drove the ` +
            'extension.** Almost nothing was clicked, so this says more about the tests than the ' +
            'manifest. Write tests that exercise real features before drawing conclusions.'
          : `**${audit.unusedCount} declared but not observed.** Unjustified permissions are a ` +
            'common cause of Chrome Web Store review delays. Confirm they are not needed on a path ' +
            'this run did not cover before removing them.',
        '',
      );
    }
    lines.push('| Permission | Verdict | Evidence |');
    lines.push('| --- | --- | --- |');
    for (const finding of audit.findings) {
      lines.push(
        `| \`${finding.permission}\` | ${verdictLabel(finding.verdict)} | ${finding.evidence?.map((e) => `\`${e}\``).join(', ') ?? finding.note ?? ''} |`,
      );
    }
    lines.push('');
    lines.push(
      '_Content scripts run in an isolated world pikabo cannot instrument; their API use is not counted._',
      '',
    );
  }

  const failures = result.suites.flatMap((s) => s.tests.filter((t) => t.status === 'failed').map((t) => ({ suite: s.name, test: t })));
  if (failures.length) {
    lines.push('## Failures');
    lines.push('');
    for (const { suite, test } of failures) {
      lines.push(`### ${suite} › ${test.name}`);
      lines.push('');
      const failed = test.steps.find((s) => s.status === 'failed');
      if (failed) {
        lines.push(`Step ${failed.index + 1} — \`${failed.action}\`: ${failed.description}`);
        lines.push('');
        lines.push('```');
        lines.push(failed.error ?? 'unknown error');
        lines.push('```');
        lines.push('');
        if (failed.screenshot) lines.push(`Screenshot: \`${failed.screenshot}\``);
        if (failed.domSnapshot) lines.push(`DOM snapshot: \`${failed.domSnapshot}\``);
      } else if (test.error) {
        lines.push('```');
        lines.push(test.error);
        lines.push('```');
      }
      if (test.trace) lines.push(`Trace: \`${test.trace}\``);
      if (test.video) lines.push(`Testcase video: \`${test.video}\``);
      if (test.videoWarning) lines.push(`Video warning: ${test.videoWarning}`);
      const errors = test.console.filter((c) => c.type === 'error');
      if (errors.length) {
        lines.push('');
        lines.push('Console errors:');
        lines.push('');
        lines.push('```');
        for (const e of errors.slice(0, 10)) lines.push(`[${e.context}] ${e.text}`);
        lines.push('```');
      }
      const events = (test.events ?? []).slice(-10);
      if (events.length) {
        lines.push('');
        lines.push('Recent extension events:');
        lines.push('');
        lines.push('```');
        for (const event of events) {
          lines.push(`[${event.source}] ${event.type} ${event.detail === undefined ? '' : JSON.stringify(event.detail)}`.trim());
        }
        lines.push('```');
      }
      lines.push('');
    }
  }

  return `${lines.join('\n')}\n`;
}

export function writeMarkdownReport(result: RunResult, outDir: string): string {
  const file = join(outDir, 'summary.md');
  writeFileSync(file, renderMarkdown(result), 'utf8');
  return file;
}

function verdictLabel(verdict: string): string {
  return (
    {
      used: '✅ used',
      'not-observed': '⚠️ not observed',
      undeclared: '❌ undeclared',
      'not-observable': 'ℹ️ not observable',
    }[verdict] ?? verdict
  );
}

function icon(status: TestResult['status']): string {
  return status === 'passed' ? '✅ pass' : status === 'failed' ? '❌ fail' : '⏭ skip';
}

export function formatMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
}

function escapeCell(text: string): string {
  return text.replace(/\|/g, '\\|');
}
