/** Public API. The CLI is a thin wrapper over these. */

export { Session, type SessionOptions, type DownloadRecord } from './browser/session.js';
export { launchBrowser, extensionArgs, QUIET_ARGS, BrowserLaunchError, type LaunchOptions } from './browser/launcher.js';
export { resolveExtension, extensionUrl, ExtensionLoadError } from './browser/extension.js';
export { computeUnpackedExtensionId, extensionIdFromUrl, isValidExtensionId } from './browser/extension-id.js';
export {
  readManifest,
  popupPath,
  optionsPath,
  sidePanelPath,
  devtoolsPath,
  backgroundPath,
  hasServiceWorker,
  ManifestError,
} from './browser/manifest.js';

export { parseSuite, parseSuiteFile, readStep, SuiteParseError } from './dsl/parse.js';
export { SUITE_SCHEMA, STEP_SPECS, STEP_NAMES } from './dsl/schema.js';
export { runSuites, validateRunOptions, type IsolationMode, type RunOptions, type RunEvent, type ShotPolicy } from './dsl/runner.js';
export { STEP_HANDLERS, AssertionError, type StepContext, type StepHandler } from './dsl/steps/index.js';
export { interpolate } from './dsl/interpolate.js';

export { generateSmokeSuite, suiteToYaml, matchPatternToUrl } from './explore/generate.js';

export { renderHtml, writeHtmlReport } from './report/html.js';
export { renderMarkdown, writeMarkdownReport } from './report/markdown.js';
export { writeJsonReport } from './report/json.js';
export { convertVideosToGif, hasFfmpeg } from './report/video.js';

export {
  runAndReport,
  exploreAndRun,
  writeReports,
  prepareOutputDir,
  type ReportOptions,
  type WrittenReports,
  type PreparedOutput,
} from './run.js';

export { inspectPdf, describePageSize, pointsToMm, type PdfInfo } from './util/pdf.js';
export { globToRegExp, matchesPattern, matchesLoose, deepEqual } from './util/match.js';
export { installSkill, readSkill, detectTargets, skillSourcePath, type SkillTarget, type InstallResult } from './skill.js';
export { REPO_URL, STEP_REFERENCE_URL, SCHEMA_ID } from './constants.js';

export type * from './types.js';
