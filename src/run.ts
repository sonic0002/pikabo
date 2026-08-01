import { mkdirSync, writeFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
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

/** Load suite files, run them, and write whichever reports were asked for. */
export async function runAndReport(
  files: string[],
  runOptions: RunOptions,
  reportOptions: ReportOptions,
  log: (message: string) => void = () => {},
): Promise<{ result: RunResult; reports: WrittenReports }> {
  const loaded = files.map((file) => ({ file: resolve(file), suite: parseSuiteFile(file) }));
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
