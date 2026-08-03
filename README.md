# ext-tester

Automated testing for Chrome extensions.

Building an extension means testing it by hand: load the unpacked build in `chrome://extensions`,
click the popup, poke the options page, watch three separate DevTools windows for errors, repeat
after every change. None of it is reachable by ordinary browser automation, because an extension
lives outside the page — the popup is browser chrome, the MV3 background is a service worker with
no tab, and stable Chrome 137+ refuses `--load-extension` outright.

ext-tester loads your unpacked extension into a real Chromium, drives all of it, and writes a
report with a screenshot of every step.

```console
$ ext-test explore --ext ./my-extension

my-extension v2.1.0 · MV3
popup: popup.html · options: options.html · service worker · 2 content script blocks · 5 permissions

Generated 5 smoke test(s) → tests/smoke.generated.yaml
my-extension smoke tests
  ✓ service worker starts without errors      12ms
  ✓ popup renders                            431ms
  ✓ options page renders                     318ms
  ✓ content script injects on github.com     772ms

  4 passed · 3.8s
  html      ext-test-results/report.html
```

No hand-written test was involved in that run.

## Install

```bash
npm install --save-dev ext-tester
npx playwright install chromium     # one-time browser download
npx ext-test doctor                 # confirm the environment
```

### Running it before it is published

Not on npm yet. Clone the repo and build once:

```bash
git clone <this repo> && cd ext-tester
npm install
npm run build
npx playwright install chromium
```

Then pick whichever fits:

**Straight from the repo** — nothing installed, good for hacking on the tool itself:

```bash
node dist/cli.js explore --ext ../my-extension
npm run dev -- explore --ext ../my-extension     # via tsx, no build step needed
```

**`npm link`** — gives you a real `ext-test` command everywhere, and is the only option for an
extension with no `package.json` of its own:

```bash
npm link                                  # once, from the ext-tester repo
cd ../my-extension
ext-test explore --ext .
```

Undo with `npm unlink -g ext-tester`. Re-run `npm run build` in the repo after changing the
source — the linked binary points at `dist/`.

**A local tarball** — closest to a published install, so it also proves packaging is sound:

```bash
npm pack                                          # → ext-tester-0.1.0.tgz
cd ../my-extension
npm install --save-dev ../ext-tester/ext-tester-0.1.0.tgz
npx ext-test explore --ext .
```

A `file:` dependency (`npm install --save-dev ../ext-tester`) works the same way and picks up
rebuilds automatically, but only if the extension has a `package.json`.

Whichever you choose, `ext-test doctor --ext .` first — it confirms the Chromium binary is
present and your `manifest.json` parses before anything tries to launch a browser.

## Getting started

```bash
npx ext-test explore --ext .        # generate a smoke suite from manifest.json and run it
npx ext-test init                   # scaffold tests/smoke.yaml to edit yourself
npx ext-test run tests --ext .      # run a directory of suites
npx ext-test run tests/popup.yaml --ext . --test "popup saves a PDF"
```

`run` exits non-zero when anything fails, so it drops straight into CI.

Use `--test "exact test name"` to run one named test from the supplied suite files. Use `--grep`
when substring or regular-expression filtering is more convenient:

```bash
ext-test run tests --ext . --grep "PDF"
ext-test run tests --ext . --grep '/popup .* PDF/i'
```

`--test` and `--grep` are mutually exclusive. If an exact test name is not found, the command
fails before launching Chromium and lists the available names.

## Writing tests

Suites are YAML. A step is one action; `in:` chooses which part of the extension it acts on.

```yaml
name: PageSaver

after:
  - clearStorage           # runs after every test, passing or failing

tests:
  - name: popup saves a PDF
    steps:
      - navigate: https://example.com
      - openPopup
      - click: "#save-pdf"
      - waitForDownload: "*.pdf"
      - screenshot: after-save
      - assertStorage:
          key: lastSave
          exists: true
      - assertNoConsoleErrors

  - name: options page persists the theme
    steps:
      - openOptions
      - select:
          selector: "#theme"
          value: dark
      - click: "#save"
      - assertStorage:
          key: theme
          equals: dark
```

Extension surfaces are addressable by name, and this is most of the point of the tool:

| `in:` | What it is |
| --- | --- |
| `page` | the web page under test, where content scripts run |
| `popup` | the extension popup, as a real document |
| `options` | the options page |
| `worker` | the MV3 service worker — `chrome.storage`, `chrome.runtime`, alarms, messaging |
| `sidepanel` | the manifest-declared side-panel document |
| `devtools` | the DevTools extension page for document/console smoke tests |
| `background` | an MV2 persistent background page, when the browser still supports MV2 |
| `offscreen` | an MV3 offscreen document; `eval` only because it has no visible page |

The lifecycle steps `openSidePanel`, `openDevtoolsPage`, `openBackground`,
`createOffscreenDocument`, and `closeOffscreenDocument` expose those surfaces. `triggerAction`,
`triggerCommand`, and `triggerContextMenu` invoke the extension’s registered Chrome event
listeners deterministically; `openContextMenu` separately opens the native menu for visual smoke
testing.

These are functional-test handles, not browser-UI pixel emulation: `sidepanel` and `devtools`
open the extension documents as pages so their DOM, scripts, APIs, and console can be tested.
They do not reproduce the surrounding Chrome side-panel or DevTools shell. `openContextMenu`
checks the native menu-opening gesture; `triggerContextMenu` tests the extension listener and
payload without trying to click Chrome’s operating-system menu UI.

Anything the DSL does not cover, `eval` does:

```yaml
- eval:
    script: |
      const tabs = await chrome.tabs.query({ active: true });
      return tabs.length;
    in: worker
- expect:
    equals: 1
```

Chrome behavior that has no DOM representation is available as an ordered event timeline. Tests
can wait on the effect itself instead of sleeping or inspecting implementation state:

```yaml
- openPopup
- click: "#save"
- waitForExtensionEvent:
    type: runtime.message
    contains:
      message:
        type: save
- assertExtensionEvent:
    type: storage.changed
    contains:
      areaName: local
```

Observed events include runtime messages and ports, storage changes, tab activity, downloads,
alarms, permissions, commands, context menus, notifications, content-script execution, and
service-worker cold-start / stop / restart boundaries reported by Chrome.

## Use it inside Playwright Test

You do not have to replace an existing Playwright suite with YAML. Extend your own `test` once:

```ts
// fixtures.ts
import path from 'node:path';
import { test as base, expect } from '@playwright/test';
import { createExtensionTest } from 'ext-tester/playwright';

export const test = createExtensionTest(base);
test.use({ extensionPath: path.resolve('dist/extension') });
export { expect };
```

```ts
import { test, expect } from './fixtures';

test('popup changes the current page', async ({ extensionPage, extensionPopup }) => {
  await extensionPage.goto('https://example.com/');
  await extensionPopup.getByRole('button', { name: 'Apply' }).click();
  await expect(extensionPage.locator('[data-extension-applied]')).toBeVisible();
});
```

This keeps Playwright locators, assertions, routing, retries, parallel workers, reporters, and
configuration. The added fixtures are `extensionSession`, `extensionContext`, `extensionPage`,
`extensionWorker`, `extensionPopup`, `extensionOptions`, and `extensionSidePanel`. A separate
extension trace is attached on failure by default (`extensionTrace: 'on' | 'off' |
'retain-on-failure'`).

## Test isolation

Every test gets a fresh Chromium profile by default. Extension storage, cookies, tabs, workers,
and install-time state therefore cannot leak from one test to the next. This is the reliable mode
for CI:

```bash
ext-test run tests --ext . --isolation fresh-profile
```

`--isolation reset` reuses one on-disk browser profile, scrubs extension storage, alarms, download
history, optional permission grants, cookies, and storage owned by visited origins, then relaunches
Chrome between tests so arbitrary service-worker globals cannot leak. It is useful when profile
reuse matters, but the default fresh-profile mode remains the simplest CI boundary. Use
`closeOtherTabs` inside a test when an install or welcome tab would interfere before cleanup runs.

The full list of steps is in [docs/steps.md](docs/steps.md). A JSON Schema for editor
autocomplete is in [schema/suite.schema.json](schema/suite.schema.json):

```yaml
# yaml-language-server: $schema=./node_modules/ext-tester/schema/suite.schema.json
```

## What you get back

Written to `ext-test-results/` (change with `--out`). **The directory is cleared at the start of
every run**, so what you see always belongs to the run that just finished — a renamed or deleted
test never leaves a stale folder behind pretending to be current. Pass `--no-clean` to keep the
previous run's artefacts.

Only directories ext-tester recognises are cleared: ones holding nothing but its own output
(`screenshots/`, `dom/`, `downloads/`, `videos/`, `traces/`, `results.json`, `report.html`, `summary.md`) or carrying
the `.ext-test-results` marker it writes. A single unrecognised file protects the whole directory
and produces a warning naming it, so `--out .` cannot delete your project.

- **`report.html`** — one self-contained file. Screenshots are inlined, so it can be attached to
  an issue and opened anywhere. Per-step timeline, expandable console log, failure detail.
- **`results.json`** — the full result tree, for CI gates and for tooling.
- **`summary.md`** — a short pass/fail table plus failure detail.
- **`videos/<test>.webm`** — one composed testcase replay with context/step labels when
  `--video on` is enabled. The Playwright page recordings used as sources remain under
  `videos/raw/`. Composition and optional `--gif` conversion require ffmpeg; without it the raw
  recordings remain available and the result contains a warning.
- **`dom/**/*.html`** — page HTML captured at each failed step.
- **`traces/*.zip`** — Playwright trace retained on failure by default; open with
  `npx playwright show-trace <file>`.

Screenshots are captured after every interactive step by default (`--shots step-end`). Use
`--shots all` for a screenshot after literally every step, or `--shots failures` for the minimum.
Use `--trace on|off|retain-on-failure` to control trace retention. Reports include the actual
browser channel and version, which makes a browser-specific failure diagnosable.

Each test gets its own directory, so step numbering never collides between tests:

```
ext-test-results/screenshots/
  my-suite/
    popup-counts-clicks/       00-openPopup.png  02-click.png  06-after-save.png
    options-page-saves/        00-openOptions.png  01-select.png
```

The number is the **step index**, zero-padded so the files sort into execution order, and it is
the same index shown in the report and `results.json` — so a failure at step 7 is `07-*.png`.
Gaps are expected: under the default `--shots step-end` only steps that change what is on screen
are captured, so assertions and `eval` leave holes in the numbering. Use `--shots all` to capture
after every step and close the gaps.

## Errors you would otherwise have to go looking for

**Service worker startup errors.** The console of an MV3 service worker is invisible unless you
have its inspector open at the moment it starts. ext-tester attaches over the DevTools protocol
before assertions run and picks up the buffered output, so a background script that throws on its
first line is reported with the file and line:

```
✗ service worker starts without errors
  assertNoConsoleErrors: 2 console error(s):
    [worker] ReferenceError: initialise is not defined
      at chrome-extension://abc…/background.js:4:1
    [worker] Error: Unhandled rejection: storage quota exceeded
      at chrome-extension://abc…/background.js:31:16
```

**Silent popup failures.** A popup whose script throws still renders its HTML — you see an empty
rectangle and no error. `assertNoConsoleErrors` catches it, and the generated smoke suite checks
that the popup rendered actual content.

**Selector drift.** When a selector matches nothing, the failure says what *is* on the page
rather than just timing out:

```
Expected "#save-pdf" to be visible in popup, but it was not within 15000ms.
Elements present: #save, #cancel, #status.
```

## Validating a generated file

Extensions that export something — a PDF, an image, a Markdown file — are the awkward case,
because "did it work" means looking at the artefact, not the DOM. Two things make that work.

**Downloads are captured wherever they come from.** Most extensions save from their service
worker with `chrome.downloads.download()`, which involves no page at all and is invisible to
page-level automation. Every download first gets a collision-free browser filename, is mapped back
to the extension-requested name by Chrome download ID, and is recorded in `<out>/downloads/`,
under the filename the extension asked for.

**`assertPdf` reads the file.** Page count, page geometry, byte size, producer, and text where
the document has any:

```yaml
- name: normal PDF export of pixelstech.net produces a full-page document
  steps:
    - navigate: https://www.pixelstech.net
    - openPopup
    - click: "#pdfBtn"
    - waitForDownload:
        pattern: "PixelsTech*.pdf"
        timeout: 90000
    - assertPdf:
        pattern: "PixelsTech*.pdf"
        pages: 1
        width: 595.28        # A4 width in points; 72pt = 1 inch
        minHeight: 1000      # a short page means only the viewport was captured
        minBytes: 50000      # a blank capture collapses to a few KB
        producer: /jsPDF/
```

The step reports what it found, so a passing run still tells you something:

```
✓ assertPdf — PixelsTech_…_2026-08-01T06-18-27.pdf: 1 page(s),
  A4 width × 809.3mm tall, 576KB, jsPDF 2.5.1, rasterised
```

`rasterised` is the useful word there. Extensions that capture a page usually draw it as an
image, so the PDF has no text in it at all — `containsText` will never match, and says so
rather than just failing. Assert on geometry and size instead. `assertFile` covers the simpler
cases (`minBytes`, `contains`) for text formats like Markdown.

### Testing against a real website

Two habits keep these tests from being flaky.

**Scope console assertions to your own surfaces.** A live site logs its own errors, which have
nothing to do with your extension and change without warning:

```yaml
- assertNoConsoleErrors:
    contexts: [popup, worker]     # not the page
```

**Give generation steps their own timeout.** Rasterising a long page takes tens of seconds,
well past the default:

```yaml
- waitForDownload:
    pattern: "*.pdf"
    timeout: 90000
```

**Handle welcome tabs opened on install.** `navigate` brings the page under test to the
foreground, so active-tab APIs such as `captureVisibleTab` and `tabs.query({ active: true })`
target it. The welcome tab remains open and its console is still captured. If it is noisy or the
test must start with exactly one tab, close install tabs in `before`:

```yaml
before:
  - eval:
      in: worker
      script: |
        const tabs = await chrome.tabs.query({});
        const keep = tabs.filter((tab) => (tab.url || '').startsWith('chrome-extension://'));
        const close = tabs.filter((tab) => !keep.includes(tab) && tab.url !== 'about:blank');
        await Promise.all(close.map((tab) => chrome.tabs.remove(tab.id).catch(() => {})));
        return close.length;
```

Use a URL rule specific to the extension when the page under test has already been opened.

A complete worked example against a real extension is in
[`examples/pagesaver-pdf.yaml`](examples/pagesaver-pdf.yaml).

## Teaching an agent to use it

Most of what an agent needs is not the command list — it is the workflow and the handful of
things that are not obvious (scope console assertions on live sites, give capture steps a long
timeout, a bare `{` breaks YAML in an `eval`). That is written once in
[`skills/testing-extensions/SKILL.md`](skills/testing-extensions/SKILL.md), with a body that
names no particular tool, and installed into whichever convention your agent reads:

```bash
ext-test skill install --ext .          # detects what the repo already uses
ext-test skill install --target claude,codex,cursor
ext-test skill print                    # write it somewhere yourself
```

| Target | Writes |
| --- | --- |
| `claude` | `.claude/skills/testing-extensions/SKILL.md` |
| `codex` / `agents` | `docs/testing-extensions.md`, plus a delimited pointer in `AGENTS.md` |
| `cursor` | `.cursor/rules/testing-extensions.mdc` |

An existing `AGENTS.md` is never overwritten. If it has no ext-tester block the command prints
the section for you to paste, and only appends with `--force`; on later runs it replaces its own
block between the markers rather than adding another copy.

Prefer the skill over the MCP server for everyday use: it costs nothing until it is needed,
whereas MCP tool schemas sit in the context window of every session. Reach for MCP when an
agent needs to explore an unfamiliar extension interactively.

## Driving it from an AI agent

`ext-test mcp` serves the same primitives over MCP (stdio), so an agent can launch the browser,
click through the extension, read the merged console, and then freeze what worked into a YAML
suite.

```json
{
  "mcpServers": {
    "ext-tester": {
      "command": "npx",
      "args": ["ext-test", "mcp", "--ext", "/path/to/extension"]
    }
  }
}
```

Tools: `ext_launch`, `ext_step`, `ext_screenshot`, `ext_console`, `ext_generate_suite`,
`ext_run_suite`, `ext_close`. `ext_step` takes any step name from the DSL, so nothing discovered
interactively has to be translated to be written down.

## CI

```yaml
- uses: actions/setup-node@v4
  with: { node-version: 20 }
- run: npm ci
- run: npx playwright install --with-deps chromium
- run: npx ext-test run tests --ext . --shots failures
- uses: actions/upload-artifact@v4
  if: always()
  with:
    name: ext-test-report
    path: ext-test-results/
```

## How the browser constraint is actually removed

No forked or recompiled browser. Chromium still honours the load switches; what changed in Chrome
137 is a feature flag that ignores them. Every run launches with:

```
--disable-extensions-except=<abs path>
--load-extension=<abs path>
--disable-features=DisableLoadExtensionCommandLineSwitch
```

against a fresh throwaway profile. The default browser is Playwright's Chromium, which has no such
restriction; the feature flag is passed anyway so `--browser-path /path/to/Google Chrome` works
too.

The extension's ID is resolved from its live service worker, falling back to reading
`chrome://extensions`, falling back to computing it the way Chrome does for unpacked extensions
(SHA-256 of the absolute path, first 16 bytes, hex mapped onto `a`–`p`). That last fallback is
what makes content-script-only and MV2 extensions testable, since they have no worker to ask.

## Command reference

| Command | Purpose |
| --- | --- |
| `ext-test run [suites...]` | Run suite files or directories. Default command. |
| `ext-test explore` | Generate a smoke suite from `manifest.json` and run it. |
| `ext-test init` | Scaffold `tests/smoke.yaml`. |
| `ext-test doctor` | Check Node, the Chromium binary, ffmpeg, and a manifest. |
| `ext-test mcp` | Serve the runner over MCP for an agent. |

Common flags: `--ext`, `--out`, `--headed`, `--browser-path`, `--timeout`, `--shots`, `--video`,
`--gif`, `--reporter`, `--test`, `--grep`, `--bail`, `--isolation`, `--keep-profile`, `--no-color`.

### Output shows `[1m` and `[2m` instead of colours

Those are ANSI styling codes — `1m` bold, `2m` dim, `32m` green, `0m` reset — that a terminal is
supposed to consume rather than print. Seeing them literally means whatever is displaying the
output does not interpret them. Turn styling off with any of:

```bash
ext-test run tests --ext . --no-color
NO_COLOR=1 ext-test run tests --ext .
```

Colour is disabled automatically when output is piped or redirected, and when `TERM` is `dumb`
or unset. `FORCE_COLOR=1` turns it on regardless; `--no-color` and `NO_COLOR` beat it.

## Limitations

- Chrome and Chromium only. The browser layer is isolated so Firefox could follow, but it is not
  supported today.
- Unpacked extensions only — not `.crx` installs from the Web Store.
- Browser-chrome UI outside a document (the extension's toolbar icon menu, the puzzle-piece
  overflow, native permission prompts) cannot be clicked. Everything those surfaces trigger is
  reachable through the popup document, the options page, or the worker.
- In headed mode, popup documents open as tabs and retain the maximized browser viewport. Chromium
  tabs share one physical window, so applying the popup's usual 400×600 viewport would also shrink
  the webpage tab. Headless runs still emulate the configured popup dimensions for deterministic
  screenshots.
- Keyboard commands declared in `manifest.commands` cannot be delivered as real browser shortcuts;
  dispatch their handlers through the worker with `eval` instead.
- `--remote-debugging-port=0` is passed so worker startup logs can be captured. It binds to
  loopback on a random port for the life of the run; pass `debugPort: false` through the library
  API to disable it.

## Development

```bash
npm install
npx playwright install chromium
npm test                  # unit tests, no browser
npm run test:integration  # real browser against fixtures/
npm run docs              # regenerate schema/ and docs/steps.md
```

`fixtures/sample-extension` is a working MV3 extension covering popup, options, content script,
storage and downloads. `fixtures/broken-extension` fails on purpose, so the failure paths stay
tested. `fixtures/no-worker-extension` has no service worker, covering the path-hash ID fallback.

## License

MIT © PixelsTech
