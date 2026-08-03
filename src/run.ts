import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { parseSuiteFile } from './dsl/parse.js';
import { runSuites, type RunOptions } from './dsl/runner.js';
import { generateSmokeSuite, suiteToYaml, type ExploreOptions } from './explore/generate.js';
import { writeHtmlReport } from './report/html.js';
import { writeJsonReport } from './report/json.js';
import { writeMarkdownReport } from './report/markdown.js';
import { convertVideosToGif } from './report/video.js';
import type { RunResult, Suite } from './types.js';

export interface ReportOptions {
  reporters: ('html' | 'json' | 'md')[];
  gif?: boolean;
}

export interface WrittenReports {
  html?: string;
  json?: string;
  markdown?: string;
}


/**
 * Marks a directory as owned by ext-tester, so a later run knows it may clear it.
 *
 * `--out` is user-supplied and could point anywhere — `--out .` is a plausible typo. Deleting
 * only directories carrying this marker means a run can never wipe something it did not create.
 */
const OWNERSHIP_MARKER = '.ext-test-results';

/**
 * Top-level entries ext-tester produces. A directory containing nothing else is one of ours even
 * without a marker file — which is what an output directory created by an older version looks
 * like, and refusing to clean those forever would be worse than not having the guard at all.
 */
const GENERATED_ENTRIES = new Set([
  OWNERSHIP_MARKER,
  'screenshots',
  'downloads',
  'videos',
  'results.json',
  'report.html',
  'summary.md',
]);

export interface PreparedOutput {
  /** True when a previous run's artefacts were removed. */
  cleaned: boolean;
  /** Set when cleaning was skipped and stale files may remain. */
  warning?: string;
}

/**
 * Make `outDir` ready to receive a run's artefacts.
 *
 * Reports are rewritten every run but screenshots are not, so without this a renamed test leaves
 * its old directory behind and a reader cannot tell which images belong to the current run.
 *
 * `--out` is user-supplied and could point anywhere — `--out .` is a plausible typo — so a
 * directory is only cleared when it is recognisably ext-tester's: it carries the marker file, or
 * everything in it is something ext-tester writes.
 */
export function prepareOutputDir(outDir: string, clean = true): PreparedOutput {
  const dir = resolve(outDir);
  const marker = join(dir, OWNERSHIP_MARKER);

  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(marker, markerContents(), 'utf8');
    return { cleaned: false };
  }

  const entries = readdirSync(dir);
  const foreign = entries.filter((entry) => !GENERATED_ENTRIES.has(entry));
  const owned = existsSync(marker) || foreign.length === 0;

  if (!clean) {
    if (owned) writeFileSync(marker, markerContents(), 'utf8');
    return { cleaned: false };
  }

  if (owned) {
    const hadArtefacts = entries.some((entry) => entry !== OWNERSHIP_MARKER);
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    writeFileSync(marker, markerContents(), 'utf8');
    return { cleaned: hadArtefacts };
  }

  const listed = foreign.slice(0, 5).join(', ') + (foreign.length > 5 ? `, and ${foreign.length - 5} more` : '');
  return {
    cleaned: false,
    warning:
      `${dir} holds files ext-tester does not recognise (${listed}), so nothing was deleted and ` +
      `artefacts from previous runs may be mixed in with this one. Point --out at a directory ` +
      `used only for results, or remove those files.`,
  };
}

function markerContents(): string {
  return [
    '# This directory holds ext-tester run artefacts and is cleared at the start of each run.',
    '# Run with --no-clean to keep the previous run, or point --out somewhere else.',
    `# Last run: ${new Date().toISOString()}`,
    '',
  ].join('\n');
}

/** Load suite files, run them, and write whichever reports were asked for. */
export async function runAndReport(
  files: string[],
  runOptions: RunOptions,
  reportOptions: ReportOptions,
  log: (message: string) => void = () => {},
): Promise<{ result: RunResult; reports: WrittenReports }> {
  // Parse before clearing: a suite with a typo should fail without destroying the last report.
  const loaded = files.map((file) => ({ file: resolve(file), suite: parseSuiteFile(file) }));
  announce(prepareOutputDir(runOptions.outDir, runOptions.clean), log);
  const result = await runSuites(loaded, runOptions);
  const reports = await writeReports(result, runOptions.outDir, reportOptions, log);
  return { result, reports };
}

/** Generate a smoke suite from the manifest, write it to disk, and run it. */
export async function exploreAndRun(
  extensionPath: string,
  suiteFile: string,
  runOptions: RunOptions,
  reportOptions: ReportOptions,
  exploreOptions: ExploreOptions = {},
  log: (message: string) => void = () => {},
): Promise<{ result: RunResult; reports: WrittenReports; suite: Suite; suiteFile: string }> {
  const suite = generateSmokeSuite(extensionPath, exploreOptions);
  // Clear before writing the generated suite, in case it is being written inside the output dir.
  announce(prepareOutputDir(runOptions.outDir, runOptions.clean), log);
  mkdirSync(resolve(suiteFile, '..'), { recursive: true });
  writeFileSync(suiteFile, suiteToYaml(suite), 'utf8');
  log(`Generated ${suite.tests.length} smoke test(s) → ${suiteFile}`);

  const result = await runSuites([{ suite, file: basename(suiteFile) }], runOptions);
  const reports = await writeReports(result, runOptions.outDir, reportOptions, log);
  return { result, reports, suite, suiteFile };
}

export async function writeReports(
  result: RunResult,
  outDir: string,
  options: ReportOptions,
  log: (message: string) => void,
): Promise<WrittenReports> {
  mkdirSync(outDir, { recursive: true });
  if (options.gif) await convertVideosToGif(result, outDir, log);

  const reports: WrittenReports = {};
  // JSON first: it is the artifact other tools depend on, so it should exist even if HTML
  // generation trips over something.
  if (options.reporters.includes('json')) reports.json = writeJsonReport(result, outDir);
  if (options.reporters.includes('md')) reports.markdown = writeMarkdownReport(result, outDir);
  if (options.reporters.includes('html')) reports.html = writeHtmlReport(result, outDir);
  return reports;
}

function announce(prepared: PreparedOutput, log: (message: string) => void): void {
  if (prepared.warning) log(prepared.warning);
}
