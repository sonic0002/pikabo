#!/usr/bin/env node
import { existsSync, readdirSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { Command, Option } from 'commander';
import { SuiteParseError } from './dsl/parse.js';
import type { IsolationMode, RunOptions, ShotPolicy } from './dsl/runner.js';
import { readManifest, popupPath, optionsPath, hasServiceWorker, resolveMessages } from './browser/manifest.js';
import { hasFfmpeg } from './report/video.js';
import { exploreAndRun, runAndReport, type ReportOptions, type WrittenReports } from './run.js';
import { formatMs } from './report/markdown.js';
import type { RunResult } from './types.js';
import { STEP_REFERENCE_URL } from './constants.js';

// Declared before any command action, which can run before the rest of the module finishes
// evaluating.

/**
 * Decide whether to emit ANSI styling.
 *
 * `--no-color` is read straight from argv rather than through commander, because output can
 * happen before parsing finishes. Getting this wrong prints `[1m` at the reader instead of
 * bolding anything, so every common way of saying "no colour" is honoured.
 */
function detectColor(): boolean {
  const argv = process.argv;
  if (argv.includes('--no-color') || argv.includes('--no-colour')) return false;
  if (process.env['NO_COLOR'] != null && process.env['NO_COLOR'] !== '') return false;
  const force = process.env['FORCE_COLOR'];
  if (force != null && force !== '' && force !== '0' && force !== 'false') return true;
  const term = process.env['TERM'];
  if (term === 'dumb' || term === '' || term == null) return false;
  return Boolean(process.stdout.isTTY);
}

const useColor = detectColor();
const wrap = (code: string) => (text: string) => (useColor ? `[${code}m${text}[0m` : text);
const red = wrap('31');
const green = wrap('32');
const dim = wrap('2');
const bold = wrap('1');

const program = new Command();

program
  .name('ext-test')
  .description('Automated testing for unpacked Chrome extensions — drives the popup, options page, content scripts and service worker, then reports with screenshots.')
  .version('0.1.0')
  .option('--no-color', 'disable ANSI colour codes in the output');

interface CommonFlags {
  ext: string;
  out: string;
  headed?: boolean;
  browserPath?: string;
  keepProfile?: boolean;
  timeout: string;
  shots: string;
  video: string;
  isolation: string;
  gif?: boolean;
  reporter: string;
  grep?: string;
  test?: string;
  bail?: boolean;
  /** Commander sets this false when `--no-clean` is passed, true otherwise. */
  clean?: boolean;
}

function withCommonFlags(cmd: Command): Command {
  return cmd
    .option('-e, --ext <path>', 'path to the unpacked extension (directory containing manifest.json)', '.')
    .option('-o, --out <dir>', 'output directory for reports and artifacts', 'ext-test-results')
    .option('--headed', 'run with a visible browser window')
    .option('--browser-path <path>', 'use a specific Chromium/Chrome binary')
    .option('--keep-profile', 'keep the temporary browser profile after the run')
    .option('-t, --timeout <ms>', 'default per-step timeout', '15000')
    .option('--shots <policy>', 'screenshots: all | step-end | failures | none', 'step-end')
    .option('--video <mode>', 'video recording: on | off | retain-on-failure', 'off')
    .option('--isolation <mode>', 'test isolation: fresh-profile | reset', 'fresh-profile')
    .option('--gif', 'also convert recordings to GIF (needs ffmpeg)')
    .option('--reporter <list>', 'comma-separated: html,json,md', 'html,json,md')
    .addOption(new Option('--test <name>', 'run tests whose name exactly matches').conflicts('grep'))
    .option('-g, --grep <pattern>', 'only run tests whose name matches')
    .option('--bail', 'stop after the first failing test')
    .option('--no-clean', 'keep artifacts from the previous run instead of clearing --out');
}

function toRunOptions(flags: CommonFlags): RunOptions {
  return {
    extensionPath: resolve(flags.ext),
    outDir: resolve(flags.out),
    headless: !flags.headed,
    browserPath: flags.browserPath,
    keepProfile: flags.keepProfile,
    timeout: Number(flags.timeout),
    shots: flags.shots as ShotPolicy,
    video: flags.video as 'on' | 'off' | 'retain-on-failure',
    isolation: flags.isolation as IsolationMode,
    grep: flags.grep,
    testName: flags.test,
    bail: flags.bail,
    clean: flags.clean,
    onEvent: reporterEvents(),
  };
}

function toReportOptions(flags: CommonFlags): ReportOptions {
  const reporters = flags.reporter
    .split(',')
    .map((r) => r.trim())
    .filter(Boolean) as ('html' | 'json' | 'md')[];
  return { reporters, gif: flags.gif };
}

// ---------------------------------------------------------------- run

withCommonFlags(
  program
    .command('run', { isDefault: true })
    .description('run one or more suite files (or a directory of them)')
    .argument('[suites...]', 'suite files or directories', ['tests']),
).action(async (suites: string[], flags: CommonFlags) => {
  const files = expandSuites(suites);
  if (!files.length) {
    fail(
      `No suite files found in ${suites.join(', ')}.\n\n` +
        `Create one with \`ext-test init\`, or generate a smoke suite with \`ext-test explore --ext <path>\`.`,
    );
  }
  console.log(`${files.length} suite file(s) · extension ${resolve(flags.ext)}\n`);

  try {
    const { result, reports } = await runAndReport(files, toRunOptions(flags), toReportOptions(flags), (m) =>
      console.log(dim(m)),
    );
    printSummary(result, reports, flags.out);
    process.exit(result.totals.failed > 0 ? 1 : 0);
  } catch (err) {
    fail(formatError(err));
  }
});

// ------------------------------------------------------------ explore

withCommonFlags(
  program
    .command('explore')
    .description('inspect the manifest, generate a smoke suite, and run it')
    .option('--sample-url <url>', 'URL used to exercise broad content-script match patterns', 'https://example.com/')
    .option('--suite-out <file>', 'where to write the generated suite', 'tests/smoke.generated.yaml'),
).action(async (flags: CommonFlags & { sampleUrl: string; suiteOut: string }) => {
  const extPath = resolve(flags.ext);
  try {
    printManifest(extPath);
    const { result, reports } = await exploreAndRun(
      extPath,
      resolve(flags.suiteOut),
      toRunOptions(flags),
      toReportOptions(flags),
      { sampleUrl: flags.sampleUrl },
      (m) => console.log(dim(m)),
    );
    printSummary(result, reports, flags.out);
    process.exit(result.totals.failed > 0 ? 1 : 0);
  } catch (err) {
    fail(formatError(err));
  }
});

// ------------------------------------------------------------- doctor

program
  .command('doctor')
  .description('check that the environment can run extension tests')
  .option('-e, --ext <path>', 'also validate an extension directory')
  .action(async (flags: { ext?: string }) => {
    const checks: { label: string; ok: boolean; detail: string }[] = [];

    const nodeOk = Number(process.versions.node.split('.')[0]) >= 20;
    checks.push({ label: 'Node ≥ 20', ok: nodeOk, detail: process.versions.node });

    let browserDetail = 'not found';
    let browserOk = false;
    try {
      const { chromium } = await import('playwright-core');
      const path = chromium.executablePath();
      browserOk = Boolean(path) && existsSync(path);
      browserDetail = browserOk ? path : 'run `npx playwright install chromium`';
    } catch (err) {
      browserDetail = (err as Error).message;
    }
    checks.push({ label: 'Chromium binary', ok: browserOk, detail: browserDetail });

    const ffmpeg = await hasFfmpeg();
    checks.push({
      label: 'ffmpeg (optional, for --gif)',
      ok: ffmpeg,
      detail: ffmpeg ? 'available' : 'not installed — GIF conversion will be skipped',
    });

    if (flags.ext) {
      try {
        const extPath = resolve(flags.ext);
        const manifest = readManifest(extPath);
        const name = resolveMessages(extPath, manifest, manifest.name) ?? 'unnamed';
        checks.push({
          label: 'manifest.json',
          ok: true,
          detail: `${name} v${manifest.version ?? '?'} (MV${manifest.manifest_version ?? 2})`,
        });
      } catch (err) {
        checks.push({ label: 'manifest.json', ok: false, detail: (err as Error).message });
      }
    }

    console.log('');
    for (const c of checks) {
      console.log(`  ${c.ok ? green('✓') : red('✗')} ${c.label.padEnd(32)} ${dim(c.detail)}`);
    }
    console.log('');
    const required = checks.filter((c) => !c.label.includes('optional'));
    process.exit(required.every((c) => c.ok) ? 0 : 1);
  });

// --------------------------------------------------------------- init

program
  .command('init')
  .description('scaffold a tests/ directory with a first suite')
  .option('-e, --ext <path>', 'path to the extension', '.')
  .option('-d, --dir <dir>', 'directory to create', 'tests')
  .action((flags: { ext: string; dir: string }) => {
    const extPath = resolve(flags.ext);
    let manifestName = 'extension';
    try {
      const manifest = readManifest(extPath);
      manifestName = resolveMessages(extPath, manifest, manifest.name) ?? manifestName;
    } catch (err) {
      fail(formatError(err));
    }
    const dir = resolve(flags.dir);
    mkdirSync(dir, { recursive: true });
    const file = join(dir, 'smoke.yaml');
    if (existsSync(file)) fail(`${relative(process.cwd(), file)} already exists.`);
    writeFileSync(file, starterSuite(manifestName), 'utf8');
    console.log(`\n  ${green('✓')} Created ${relative(process.cwd(), file)}\n`);
    console.log(`  Run it with:\n    ${bold(`ext-test run ${relative(process.cwd(), dir)} --ext ${flags.ext}`)}\n`);
  });

// --------------------------------------------------------------- skill

program
  .command('skill')
  .description('install the bundled agent instructions into this repository')
  .argument('[action]', 'install | print', 'install')
  .option('-d, --dir <dir>', 'repository to install into', '.')
  .option(
    '--target <list>',
    'comma-separated: claude, codex, cursor, agents. Defaults to whatever is detected.',
  )
  .option('--force', 'append to an existing AGENTS.md that has no ext-tester block')
  .action(async (action: string, flags: { dir: string; target?: string; force?: boolean }) => {
    const { detectTargets, installSkill, readSkill } = await import('./skill.js');

    if (action === 'print') {
      process.stdout.write(readSkill().full);
      return;
    }
    if (action !== 'install') fail(`Unknown action "${action}". Use "install" or "print".`);

    const root = resolve(flags.dir);
    const targets = (
      flags.target
        ? flags.target.split(',').map((t) => t.trim()).filter(Boolean)
        : detectTargets(root)
    ) as import('./skill.js').SkillTarget[];

    const valid = new Set(['claude', 'codex', 'cursor', 'agents']);
    for (const t of targets) if (!valid.has(t)) fail(`Unknown target "${t}". Use claude, codex, cursor or agents.`);

    console.log('');
    for (const target of targets) {
      try {
        const result = installSkill(target, root, flags.force);
        for (const file of result.written) console.log(`  ${green('✓')} ${target.padEnd(7)} ${file}`);
        if (result.manual) console.log(`\n  ${dim(result.manual)}\n`);
      } catch (err) {
        console.log(`  ${red('✗')} ${target.padEnd(7)} ${(err as Error).message}`);
      }
    }
    console.log('');
  });

// ---------------------------------------------------------------- mcp

program
  .command('mcp')
  .description('serve the runner primitives over MCP (stdio) for an AI agent')
  .option('-e, --ext <path>', 'default extension path for ext_launch', '.')
  .option('-o, --out <dir>', 'output directory for screenshots', 'ext-test-results')
  .option('--headed', 'launch with a visible browser window')
  .action(async (flags: { ext: string; out: string; headed?: boolean }) => {
    const { startMcpServer } = await import('./mcp/server.js');
    await startMcpServer({
      defaultExtension: resolve(flags.ext),
      outDir: resolve(flags.out),
      headless: !flags.headed,
    });
  });

program.parseAsync(process.argv).catch((err) => fail(formatError(err)));

// ------------------------------------------------------------- output

function reporterEvents(): RunOptions['onEvent'] {
  let currentSuite = '';
  return (event) => {
    if (event.type === 'suite:start') {
      currentSuite = event.name;
      console.log(bold(event.name));
    } else if (event.type === 'test:end') {
      const mark = event.status === 'passed' ? green('✓') : event.status === 'failed' ? red('✗') : dim('–');
      console.log(`  ${mark} ${event.name} ${dim(formatMs(event.durationMs))}`);
      if (event.error) console.log(`    ${red(indent(event.error))}`);
      if (event.status !== 'failed') void currentSuite;
    }
  };
}

function printSummary(result: RunResult, reports: WrittenReports, outDir: string): void {
  const { totals } = result;
  console.log('');
  const verdict =
    totals.failed > 0
      ? red(`${totals.failed} failed`)
      : green(`${totals.passed} passed`);
  console.log(
    `  ${verdict}${totals.skipped ? dim(` · ${totals.skipped} skipped`) : ''} · ${dim(formatMs(result.durationMs))}`,
  );
  for (const [kind, path] of Object.entries(reports)) {
    if (path) console.log(`  ${dim(kind.padEnd(9))} ${relative(process.cwd(), path)}`);
  }
  console.log(`  ${dim('artifacts')} ${relative(process.cwd(), resolve(outDir))}/`);
  console.log('');
}

function printManifest(extPath: string): void {
  const manifest = readManifest(extPath);
  const name = resolveMessages(extPath, manifest, manifest.name) ?? 'unnamed';
  console.log(`\n${bold(name)} ${dim(`v${manifest.version ?? '?'} · MV${manifest.manifest_version ?? 2}`)}`);
  const bits: string[] = [];
  if (popupPath(manifest)) bits.push(`popup: ${popupPath(manifest)}`);
  if (optionsPath(manifest)) bits.push(`options: ${optionsPath(manifest)}`);
  if (hasServiceWorker(manifest)) bits.push('service worker');
  const cs = manifest.content_scripts?.length ?? 0;
  if (cs) bits.push(`${cs} content script block(s)`);
  const perms = [...(manifest.permissions ?? []), ...(manifest.host_permissions ?? [])];
  if (perms.length) bits.push(`${perms.length} permission(s)`);
  console.log(dim(bits.join(' · ') || 'nothing declared'));
  console.log('');
}

function expandSuites(inputs: string[]): string[] {
  const files: string[] = [];
  for (const input of inputs) {
    const path = resolve(input);
    if (!existsSync(path)) continue;
    if (statSync(path).isDirectory()) {
      for (const entry of readdirSync(path).sort()) {
        if (/\.ya?ml$/i.test(entry)) files.push(join(path, entry));
      }
    } else {
      files.push(path);
    }
  }
  return files;
}

function formatError(err: unknown): string {
  if (err instanceof SuiteParseError) {
    return [err.message, ...err.issues.map((i) => `  ${i}`)].join('\n');
  }
  return err instanceof Error ? err.message : String(err);
}

function fail(message: string): never {
  console.error(`\n${red('✗')} ${message}\n`);
  process.exit(1);
}

function indent(text: string): string {
  return text.split('\n').join('\n    ');
}

function starterSuite(name: string): string {
  return `# Test suite for ${name}
# Run with: ext-test run tests --ext .
# Step reference: ${STEP_REFERENCE_URL}

name: ${name} smoke tests

tests:
  - name: popup renders and has no console errors
    steps:
      - openPopup
      - screenshot: popup
      - assertNoConsoleErrors

  - name: service worker responds
    steps:
      - eval:
          script: chrome.runtime.getManifest().version
          in: worker
      - expect:
          truthy: true

  # - name: saves a value to storage
  #   steps:
  #     - openPopup
  #     - click: "#save"
  #     - assertStorage:
  #         key: lastSave
  #         exists: true
`;
}
