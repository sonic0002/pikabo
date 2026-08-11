# pikabo — Chrome Extension Automation & Testing Tool

**Date:** 2026-08-01
**Status:** Implemented. Reconciled against the shipped code on 2026-08-04.

> **As-built.** This started as the pre-implementation design. Where the implementation diverged
> from the plan, this document has been corrected to follow the code — the code is the source of
> truth. Divergences worth knowing about are called out inline as **As-built** notes rather than
> silently overwritten, because the reasoning behind each one is the useful part.
>
> Anything still unimplemented is tracked in [enhancement-plan.md](enhancement-plan.md), not here.

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

**As-built.** `src/browser/launcher.ts` also passes `--remote-debugging-port=0`, so
service-worker startup logs can be captured over CDP before Playwright attaches, `--start-maximized`,
and a set of noise-suppression switches (`--disable-background-networking`, `--disable-sync`,
`--disable-component-update`, `--disable-client-side-phishing-detection`, `--metrics-recording-only`,
`--no-service-autorun`, `--password-store=basic`, `--use-mock-keychain`,
`--propagate-iph-for-testing`) that keep first-run network chatter and OS keychain prompts out of
runs. The debug port binds to loopback for the life of the run and can be disabled with
`debugPort: false` through the library API.

`DisableLoadExtensionCommandLineSwitch` is the feature flag behind stable Chrome's refusal to
honour `--load-extension`. Disabling it restored the switch. Playwright's bundled Chromium does
not ship that restriction.

**As-built.** The plan assumed the flag would keep stable Chrome usable via `--browser-path`. It
no longer does: by Chrome 150 the escape hatch has been removed, and an unpacked extension does
not load in stable Chrome with or without the flag — verified against 150.0.7871.187, and
`--enable-unsafe-extension-debugging` does not bring it back either. The supported browser is
therefore Chromium / Chrome for Testing, which Playwright installs and pikabo uses by default.
The flag is still passed because it costs nothing and helps on older builds. Microsoft Edge also
works — the removal was scoped to Chrome-branded builds, and Edge is branded by Microsoft.

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
| `sidepanel` | the side-panel document | manifest path opened as an extension page |
| `devtools` | the DevTools extension document | manifest path opened for DOM/console smoke tests |
| `background` | an MV2 persistent background page | Playwright `backgroundpage`, where supported |
| `offscreen` | an MV3 offscreen document | created through `chrome.offscreen`; evaluated over CDP |

`chrome.storage`, `chrome.runtime`, alarms, and any other extension API are reached by
evaluating inside `worker`. Console messages and page errors from all eight contexts are
collected into one ordered stream. Chrome protocol events also mark service-worker cold starts,
stops, and restarts in the extension event timeline.

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

50 steps, generated into [steps.md](steps.md) from `STEP_SPECS` in `src/dsl/schema.ts`.

*Navigation & lifecycle:* `navigate`, `openPopup`, `openOptions`, `openSidePanel`,
`openDevtoolsPage`, `openBackground`, `closePopup`, `closeOtherTabs`, `triggerAction`,
`triggerCommand`, `createOffscreenDocument`, `closeOffscreenDocument`, `reloadExtension`,
`newTab`, `switchTo`, `wait`.

*Interaction:* `click`, `fill`, `type`, `press`, `select`, `check`, `uncheck`, `hover`,
`openContextMenu`, `triggerContextMenu`, `scroll`, `upload`.

*Waiting:* `waitFor` (selector), `waitForText`, `waitForDownload`, `waitForUrl`,
`waitForExtensionEvent`.

*Assertions:* `assertVisible`, `assertText`, `assertCount`, `assertUrl`, `assertStorage`,
`assertNoConsoleErrors`, `assertDownload`, `assertPermission`, `assertExtensionEvent`,
`assertPdf`, `assertFile`, `expect`.

*Storage:* `setStorage`, `clearStorage`.

*Capture:* `screenshot`, `note`.

*Escape hatch:* `eval` — runs JS in any addressable context, its return value is available to
later steps as `${last}` and can be asserted on with `expect`. A reference that makes up the
entire string keeps its original type, so `value: ${last}` can carry an object.

Every step accepts optional `in:` (which context), `timeout:`, and `description:`. Screenshots
are captured automatically per `--shots <all | step-end | failures | none>`, default `step-end`.

**As-built.** The lifecycle and trigger steps for side panels, DevTools pages, MV2 background
pages, offscreen documents, and context menus were added with the broader-surfaces work (P1b),
and `assertPdf` / `assertFile` with artefact validation (P0). `setStorage` / `clearStorage`
became first-class steps rather than `eval` recipes because suite-level `after:` cleanup needs
them.

### Schema validation

Suites are validated against a JSON Schema before any browser launches, so a typo fails in
milliseconds with a line number rather than after a 30-second timeout. The schema is also
written to `schema/suite.schema.json` for editor autocomplete.

## Commands

```
pikabo run <suite...> --ext <path>       run suites, write reports
pikabo explore <ext path>                inspect manifest, generate a smoke suite, run it
pikabo record                            drive a browser, write what you did as a suite
pikabo doctor                            verify browser binary, ffmpeg, permissions
pikabo skill                             install the agent skill into a repo or globally
pikabo mcp                               serve the same primitives over MCP (stdio)
pikabo init                              scaffold tests/ and a first suite in an extension repo
```

Key flags: `--headed`, `--browser-path`, `--browser-channel`, `--out <dir>`,
`--shots <all|step-end|failures|none>`, `--video <on|off|retain-on-failure>`, `--gif`,
`--keep-profile`, `--isolation <fresh-profile|reset>`, `--timeout`, `--test`, `--grep`, `--bail`,
`--no-clean`, `--no-color`, `--trace <on|off|retain-on-failure>`, `--reporter <html,json,md>`.

**As-built.** `record` and `skill` were not in the original plan. `record` exists because writing
the first suite by hand turned out to be the main barrier to adoption; `skill` because shipping
agent instructions as a copied file beat requiring an MCP server for the common case. Test
isolation (`--isolation`) came out of P1a — fresh profile per test is now the default.

Exit code is non-zero when any test fails, so CI gating works without parsing output.

## Reports

Written to `--out` (default `pikabo-results/`), which is cleared at the start of every run unless
`--no-clean` is passed — and only when it holds nothing but pikabo's own output. See
[reports.md](reports.md).

- **`report.html`** — self-contained single file. Screenshots inlined as base64 data URIs, so it
  can be attached to an issue or opened from anywhere. Per-test timeline, per-step status,
  expandable console log, failure diff, embedded video link.
- **`results.json`** — machine-readable: suite/test/step tree, timings, statuses, error messages,
  artifact paths. This is what CI and agents parse.
- **`summary.md`** — a compact pass/fail table plus failure details. Cheapest artifact for an
  agent to read back mid-loop.
- **`videos/<test>.webm`** — one testcase replay composed from Playwright’s per-page recordings
  using the step/context timeline. Source recordings remain under `videos/raw/`. Converted to
  `*.gif` when `--gif` is passed and ffmpeg is on PATH; absence of ffmpeg preserves the raw
  recordings and records a warning, never a test failure.
- **`screenshots/<suite>/<test>/`** — per-test directories named by zero-padded step index, so a
  failure at step 7 is `07-*.png`.
- **`dom/**/*.html`** — page HTML captured at each failed step.
- **`downloads/`** — every file the extension downloaded, under the name it asked for.
- **`traces/*.zip`** — Playwright trace, retained on failure by default.

**As-built.** The last four came out of P0 and P1b — download capture had to be an artefact
directory once filename restoration needed Chrome download IDs, and DOM snapshots plus traces were
added so a CI failure is diagnosable without a local reproduction.

## Explore mode

`pikabo explore <path>` reads `manifest.json` and derives a smoke suite without any
human-authored spec:

- popup declared → open it, screenshot, assert no console errors, assert the document has
  rendered content
- options page declared → same
- `content_scripts[].matches` → navigate to a representative URL for each match pattern and
  assert the script injected without errors
- service worker → assert it activates, and report unhandled rejections
- an extension declaring none of the above → a single `extension loads` test

The generated suite is written to disk so it can be edited and kept, rather than being a
black box.

**As-built.** Two planned items are not generated. `commands` → dispatch each keyboard shortcut
was dropped: `manifest.commands` shortcuts cannot be delivered as real browser key events, so the
generated test would have proved nothing. `triggerCommand` dispatches the handler directly for
suites that want it. And declared permissions are not written into the generated suite — the
permission audit runs on every run from the instrumented worker instead, so it needs no generated
steps. See [permission-audit.md](permission-audit.md).

## MCP server

`pikabo mcp` exposes the runner primitives as tools — `ext_launch`, `ext_step`, `ext_screenshot`,
`ext_console`, `ext_generate_suite`, `ext_run_suite`, `ext_close` — over stdio. A launched browser
persists across tool calls in a session, so an agent can iterate interactively and then freeze
what it learned into a YAML suite.

**As-built.** The plan called for one tool per action (`ext_open_popup`, `ext_click`, `ext_fill`,
`ext_eval`, `ext_storage_get`, `ext_storage_set`). Those collapsed into a single `ext_step` that
accepts any step name from the DSL. Two reasons: every new step would otherwise have meant a new
MCP tool and a wider schema in every agent's context window, and sharing one vocabulary means
nothing an agent discovers interactively has to be translated to be written down. `ext_generate_suite`
was added so the freeze-what-worked step is a tool rather than a convention.

## Error handling

- **Schema errors** fail before launch, naming the file, line, and the offending key.
- **Extension load failure** (bad manifest, syntax error in the worker) is detected by checking
  for the extension target within a timeout, then surfaced with Chrome's own error text scraped
  from `chrome://extensions`.
- **Step failure** captures a screenshot, the DOM snapshot, and the console tail, marks the test
  failed, and continues to the next test — a suite always produces a complete report.
- **Test failure** retains a Playwright trace with DOM/network/action snapshots; passing traces are
  discarded by default. Results identify the exact browser channel and version.
- **Browser crash / launch failure** aborts the run with a diagnostic pointing at
  `pikabo doctor`.
- **Timeouts** are per-step with a suite-level default; the message says which selector in which
  context was being awaited.

## Testing strategy

Test-driven, in three tiers:

1. **Unit** (vitest, no browser): schema validation, YAML parsing, the extension-ID hash
   algorithm, report generation from fixture result trees, manifest → smoke-suite generation.
2. **Integration** (real browser, fixture extensions): `fixtures/sample-extension` is a small MV3
   extension exercising popup, options, content script, storage, and downloads.
   `fixtures/broken-extension` has a deliberate worker error so failure paths are covered.
   `fixtures/no-worker-extension` is content-script only, which exercises the path-hash
   extension-ID fallback, and `fixtures/surfaces-extension` covers side panels, the DevTools page,
   and context menus. What each fixture covers is listed in
   [CONTRIBUTING.md](../CONTRIBUTING.md#fixtures).
3. **Self-test**: the repo's own suites run against those fixtures in CI, and the resulting
   report is checked for expected pass/fail counts. CI spans Linux, macOS, and Windows on bundled
   Chromium.

**As-built.** The matrix originally also covered Chrome Stable and Chrome Beta. Those were removed
once stable Chrome stopped loading unpacked extensions at all — the jobs could not pass, and a
permanently red matrix entry teaches people to ignore CI.

## Repository layout

```
pikabo/
├─ src/
│  ├─ cli.ts                 command parsing, exit codes
│  ├─ run.ts                 run orchestration shared by cli and mcp
│  ├─ index.ts               public library entry point
│  ├─ playwright.ts          `pikabo/playwright` fixtures
│  ├─ skill.ts               agent-skill install/check/print
│  ├─ browser/
│  │   ├─ launcher.ts        flags, profile, teardown
│  │   ├─ session.ts         context registry and lifecycle
│  │   ├─ extension.ts       manifest read, context handles
│  │   ├─ extension-id.ts    worker → chrome://extensions → path-hash fallback
│  │   ├─ manifest.ts        manifest parsing and capability detection
│  │   ├─ cdp-console.ts     worker startup logs captured over CDP
│  │   └─ permissions.ts     permission audit
│  ├─ dsl/
│  │   ├─ schema.ts          STEP_SPECS — the single source of truth
│  │   ├─ parse.ts           YAML → validated Suite
│  │   ├─ interpolate.ts     `${last}`, env, and variable references
│  │   ├─ steps/             navigation, interaction, assertions, events, files
│  │   └─ runner.ts          execution, capture, isolation, result tree
│  ├─ record/                recorder.ts, actions.ts
│  ├─ report/                html.ts, json.ts, markdown.ts, video.ts
│  ├─ explore/generate.ts
│  ├─ util/                  color.ts, match.ts, pdf.ts
│  └─ mcp/server.ts
├─ fixtures/                 sample-, broken-, no-worker-, surfaces-extension
├─ tests/                    unit/, integration/
├─ schema/suite.schema.json
├─ skills/testing-extensions/SKILL.md
└─ docs/
```

TypeScript, ESM, Node ≥ 22. MIT licensed, published as `pikabo` with a `pikabo` bin.

**As-built.** The planned `browser/contexts.ts` became `browser/session.ts`, and manifest reading
moved from `explore/` to `browser/` once the runner needed capability detection too. `record/`,
`skill.ts`, `playwright.ts`, and `util/pdf.ts` are all later additions covered above.

## Success criteria

- `pikabo explore ../pagesaver` produces a passing smoke report with screenshots, with no
  hand-written test.
- A deliberately broken extension produces a failing report that names the actual cause.
- A full suite run against a real extension completes headless in CI with no human interaction.
- The HTML report opens standalone and shows a screenshot for every step.
