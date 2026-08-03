/**
 * Emit the artefacts derived from the step table: the JSON Schema editors use for autocomplete,
 * and the step reference in the docs. Run with `npm run docs`.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { STEP_SPECS, SUITE_SCHEMA, type StepSpec } from '../src/dsl/schema.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

mkdirSync(join(root, 'schema'), { recursive: true });
writeFileSync(join(root, 'schema/suite.schema.json'), `${JSON.stringify(SUITE_SCHEMA, null, 2)}\n`, 'utf8');

const GROUPS: { title: string; note: string; steps: string[] }[] = [
  {
    title: 'Navigation and lifecycle',
    note: 'Moving between contexts. `openPopup` and `openOptions` also make that context active, so following steps do not need `in:`.',
    steps: ['navigate', 'openPopup', 'openOptions', 'closePopup', 'closeOtherTabs', 'reloadExtension', 'newTab', 'switchTo', 'wait'],
  },
  {
    title: 'Interaction',
    note: 'All of these act on the active context unless `in:` says otherwise.',
    steps: ['click', 'fill', 'type', 'press', 'select', 'check', 'uncheck', 'hover', 'scroll', 'upload'],
  },
  {
    title: 'Waiting',
    note: 'Prefer these over `wait`, which sleeps for a fixed time and makes suites slow and flaky.',
    steps: ['waitFor', 'waitForText', 'waitForDownload', 'waitForUrl', 'waitForExtensionEvent'],
  },
  {
    title: 'Assertions',
    note: 'A failing assertion ends the test and captures a screenshot, but the run continues to the next test.',
    steps: [
      'assertVisible', 'assertText', 'assertCount', 'assertUrl', 'assertStorage',
      'assertNoConsoleErrors', 'assertDownload', 'assertPermission', 'assertExtensionEvent', 'assertPdf', 'assertFile', 'expect',
    ],
  },
  {
    title: 'Storage',
    note: 'These go through the service worker, so they need an extension that declares one.',
    steps: ['setStorage', 'clearStorage'],
  },
  {
    title: 'Capture and escape hatch',
    note: '`eval` runs arbitrary JavaScript in any context and stores its result for the next `expect`.',
    steps: ['screenshot', 'note', 'eval'],
  },
];

function signature(spec: StepSpec): string {
  switch (spec.arity) {
    case 'none':
      return `- ${spec.name}`;
    case 'string':
      return `- ${spec.name}: <${spec.primary}>`;
    case 'number':
      return `- ${spec.name}: <${spec.primary}>`;
    case 'object':
      return `- ${spec.name}: { ${(spec.props ?? []).join(', ')} }`;
  }
}

const lines: string[] = [
  '# Step reference',
  '',
  '_Generated from `src/dsl/schema.ts` by `npm run docs`. Do not edit by hand._',
  '',
  'Every step accepts three options on top of its own:',
  '',
  '| Option | Meaning |',
  '| --- | --- |',
  '| `in` | Which context to act on: `page`, `popup`, `options`, `worker`, or a tab you named. Defaults to the active context. |',
  '| `timeout` | Milliseconds to allow this step. Defaults to the test, then the suite, then `--timeout`. |',
  '| `description` | Replaces the label shown in the report. |',
  '',
];

for (const group of GROUPS) {
  lines.push(`## ${group.title}`, '', group.note, '');
  lines.push('| Step | Form | Options | What it does |');
  lines.push('| --- | --- | --- | --- |');
  for (const name of group.steps) {
    const spec = STEP_SPECS.find((s) => s.name === name);
    if (!spec) continue;
    const options = [...new Set([spec.primary, ...(spec.props ?? [])].filter(Boolean))] as string[];
    const marked = options.map((o) => (spec.required?.includes(o) ? `**${o}**` : o));
    lines.push(
      `| \`${spec.name}\` | \`${signature(spec).replace(/^- /, '')}\` | ${marked.map((o) => `\`${o}\``).join(', ') || '—'} | ${spec.summary} |`,
    );
  }
  lines.push('');
}

lines.push('Bold options are required. Anything not listed is rejected before the browser starts.', '');

mkdirSync(join(root, 'docs'), { recursive: true });
writeFileSync(join(root, 'docs/steps.md'), lines.join('\n'), 'utf8');

console.log(`Wrote schema/suite.schema.json and docs/steps.md (${STEP_SPECS.length} steps).`);
