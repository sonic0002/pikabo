# ext-tester — Chrome Extension Automation & Testing Tool

**Date:** 2026-08-01
**Status:** Approved for implementation

## Problem

Building a Chrome extension requires manual testing: load the unpacked extension in
`chrome://extensions`, click the popup, poke the options page, watch the console in three
separate DevTools windows, and repeat after every change. Nothing about this is automatable
through ordinary browser automation, because extensions live outside the page: the popup is a
browser-chrome surface, the MV3 background is a service worker with no tab, and stable Chrome
137+ refuses `--load-extension` outright.

The result is that extension authors — and coding agents working on extensions — cannot verify
their work without a human driving the browser.

## Goal

A command-line tool and MCP server that loads an unpacked extension into a real Chromium,
drives its popup / options page / content scripts / service worker, asserts on the results, and
emits a shareable report with screenshots of every step.

## Non-Goals

- Compiling a patched Chromium from source. Chrome for Testing and Playwright's bundled
  Chromium already accept `--load-extension`; a source build costs ~100 GB and hours per
  platform for no additional capability. A documented escape hatch describes how to point the
  tool at a custom binary if that ever changes.
- Testing packaged `.crx` installs from the Web Store.
- Firefox / Safari extension support. The architecture keeps the browser layer isolated so this
  stays possible, but it is out of scope.

## Approach

Build on **Playwright's Chromium** via `launchPersistentContext`. Extensions require a
persistent context, which Playwright supports, and the same API supplies screenshots, video
recording, download interception, and console capture — all of which the report needs. The
alternative (raw CDP over `@puppeteer/browsers`) would mean reimplementing those four
subsystems.

### Removing the constraint

Launch flags:

```
--disable-extensions-except=<abs path>
--load-extension=<abs path>
--disable-features=DisableLoadExtensionCommandLineSwitch
--no-first-run
--no-default-browser-check
--disable-search-engine-choice-screen
```

plus an ephemeral profile directory per run, deleted on exit unless `--keep-profile`.

`DisableLoadExtensionCommandLineSwitch` is the feature flag behind stable Chrome's refusal to
honour `--load-extension`. Disabling it restores the switch. Playwright's bundled Chromium does
not ship that restriction today, but the flag is passed unconditionally so the tool also works
against a user-supplied stable Chrome via `--browser-path`.

### Resolving the extension ID

1. Wait for a service-worker target whose URL is `chrome-extension://<id>/...` (MV3, the common
   case).
2. Fall back to reading the loaded-extension list from a page opened on `chrome://extensions`
   via its Shadow DOM.
3. Fall back to computing the ID the way Chrome does for unpacked extensions: SHA-256 of the
   absolute extension path, first 16 bytes, each nibble mapped `0-f` → `a-p`.

Step 3 makes extensions with no background service worker (content-script-only, MV2) testable.

### Contexts the runner can address

| Handle | What it is | How it is obtained |
|---|---|---|
| `page` | the active web page under test | normal Playwright page |
| `popup` | `chrome-extension://<id>/<popup>` | new page sized to the popup's declared dimensions |
| `options` | `chrome-extension://<id>/<options>` | new page |
| `worker` | the MV3 service worker | Playwright `ServiceWorker`, `evaluate()` runs inside it |

`chrome.storage`, `chrome.runtime`, alarms, and any other extension API are reached by
evaluating inside `worker`. Console messages and page errors from all four contexts are
collected into one ordered stream.

## Test format

YAML suites, with an `eval` step as the escape hatch for anything the DSL does not express.

```yaml
name: PageSaver popup saves a PDF
steps:
  - navigate: https://example.com
  - openPopup
  - click: "#save-pdf"
  - waitForDownload: "*.pdf"
  - screenshot: after-save
  - assertStorage:
      key: lastSave
      exists: true
```

### Step vocabulary

*Navigation & lifecycle:* `navigate`, `openPopup`, `openOptions`, `closePopup`, `reloadExtension`,
`newTab`, `switchTo`, `wait`.

*Interaction:* `click`, `fill`, `type`, `press`, `select`, `check`, `uncheck`, `hover`, `scroll`,
`upload`.

*Waiting:* `waitFor` (selector), `waitForText`, `waitForDownload`, `waitForUrl`.

*Assertions:* `assertVisible`, `assertText`, `assertCount`, `assertUrl`, `assertStorage`,
`assertNoConsoleErrors`, `assertDownload`, `assertPermission`.

*Capture:* `screenshot`, `note`.

*Escape hatch:* `eval` — runs JS in a chosen context (`page` | `popup` | `options` | `worker`),
its return value is available to later steps as `${last}` and can be asserted on with `expect`.

Every step accepts optional `in:` (which context), `timeout:`, and `description:`. Screenshots
are captured automatically after each step at `--shots=all` (default `--shots=step-end`, or
`failures`).

### Schema validation

Suites are validated against a JSON Schema before any browser launches, so a typo fails in
milliseconds with a line number rather than after a 30-second timeout. The schema is also
written to `schema/suite.schema.json` for editor autocomplete.

## Commands

```
ext-test run <suite...> --ext <path>       run suites, write reports
ext-test explore <ext path>                inspect manifest, generate a smoke suite, run it
ext-test doctor                            verify browser binary, ffmpeg, permissions
ext-test mcp                               serve the same primitives over MCP (stdio)
ext-test init                              scaffold tests/ and a first suite in an extension repo
```

Key flags: `--headed`, `--browser-path`, `--out <dir>`, `--shots <all|step-end|failures>`,
`--video <on|off|retain-on-failure>`, `--gif`, `--keep-profile`, `--timeout`, `--grep`,
`--reporter <html,json,md>`.

Exit code is non-zero when any test fails, so CI gating works without parsing output.

## Reports

All four outputs, written to `--out` (default `ext-test-results/`):

- **`report.html`** — self-contained single file. Screenshots inlined as base64 data URIs, so it
  can be attached to an issue or opened from anywhere. Per-test timeline, per-step status,
  expandable console log, failure diff, embedded video link.
- **`results.json`** — machine-readable: suite/test/step tree, timings, statuses, error messages,
  artifact paths. This is what CI and agents parse.
- **`summary.md`** — a compact pass/fail table plus failure details. Cheapest artifact for an
  agent to read back mid-loop.
- **`videos/*.webm`** — Playwright-recorded session per test. Converted to `*.gif` when `--gif`
  is passed and ffmpeg is on PATH; absence of ffmpeg is a warning, never a failure.

## Explore mode

`ext-test explore <path>` reads `manifest.json` and derives a smoke suite without any
human-authored spec:

- popup declared → open it, screenshot, assert no console errors, assert the document has
  rendered content
- options page declared → same
- `content_scripts[].matches` → navigate to a representative URL for each match pattern and
  assert the script injected without errors
- `commands` → dispatch each keyboard shortcut
- service worker → assert it activates, and report unhandled rejections
- every declared permission → record it in the report for review

The generated suite is written to disk so it can be edited and kept, rather than being a
black box.

## MCP server

`ext-test mcp` exposes the runner primitives as tools — `ext_launch`, `ext_open_popup`,
`ext_click`, `ext_fill`, `ext_eval`, `ext_storage_get`, `ext_storage_set`, `ext_screenshot`,
`ext_console`, `ext_run_suite`, `ext_close` — over stdio. A launched browser persists across
tool calls in a session, so an agent can iterate interactively and then freeze what it learned
into a YAML suite.

## Error handling

- **Schema errors** fail before launch, naming the file, line, and the offending key.
- **Extension load failure** (bad manifest, syntax error in the worker) is detected by checking
  for the extension target within a timeout, then surfaced with Chrome's own error text scraped
  from `chrome://extensions`.
- **Step failure** captures a screenshot, the DOM snapshot, and the console tail, marks the test
  failed, and continues to the next test — a suite always produces a complete report.
- **Browser crash / launch failure** aborts the run with a diagnostic pointing at
  `ext-test doctor`.
- **Timeouts** are per-step with a suite-level default; the message says which selector in which
  context was being awaited.

## Testing strategy

Test-driven, in three tiers:

1. **Unit** (vitest, no browser): schema validation, YAML parsing, the extension-ID hash
   algorithm, report generation from fixture result trees, manifest → smoke-suite generation.
2. **Integration** (real browser, fixture extensions): `fixtures/sample-extension` is a small MV3
   extension exercising popup, options, content script, storage, and downloads.
   `fixtures/broken-extension` has a deliberate worker error so failure paths are covered.
3. **Self-test**: the repo's own suites run against those fixtures in CI, and the resulting
   report is checked for expected pass/fail counts.

## Repository layout

```
ext-tester/
├─ src/
│  ├─ cli.ts                 command parsing, exit codes
│  ├─ browser/
│  │   ├─ launcher.ts        flags, profile, teardown
│  │   ├─ extension.ts       ID resolution, manifest read, context handles
│  │   └─ contexts.ts        page/popup/options/worker registry
│  ├─ dsl/
│  │   ├─ schema.ts          JSON Schema + types
│  │   ├─ parse.ts           YAML → validated Suite
│  │   ├─ steps/             one module per step family
│  │   └─ runner.ts          execution, capture, result tree
│  ├─ report/                html.ts, json.ts, markdown.ts, video.ts
│  ├─ explore/               manifest.ts, generate.ts
│  └─ mcp/server.ts
├─ fixtures/                 sample-extension/, broken-extension/
├─ tests/                    unit/, integration/
├─ schema/suite.schema.json
└─ docs/
```

TypeScript, ESM, Node ≥ 20. MIT licensed, published as `ext-tester` with a `ext-test` bin.

## Success criteria

- `ext-test explore ../pagesaver` produces a passing smoke report with screenshots, with no
  hand-written test.
- A deliberately broken extension produces a failing report that names the actual cause.
- A full suite run against a real extension completes headless in CI with no human interaction.
- The HTML report opens standalone and shows a screenshot for every step.
