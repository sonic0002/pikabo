# pikabo

Automated testing for Chrome extensions.

Building an extension means testing it by hand: load the unpacked build in `chrome://extensions`,
click the popup, poke the options page, watch three separate DevTools windows for errors, repeat
after every change. None of it is reachable by ordinary browser automation, because an extension
lives outside the page — the popup is browser chrome, the MV3 background is a service worker with
no tab, and stable Chrome 137+ refuses `--load-extension` outright.

pikabo loads your unpacked extension into a real Chromium, drives all of it, and writes a
report with a screenshot of every step.

```console
$ pikabo explore --ext ./my-extension

my-extension v2.1.0 · MV3
popup: popup.html · options: options.html · service worker · 2 content script blocks · 5 permissions

Generated 5 smoke test(s) → tests/smoke.generated.yaml
my-extension smoke tests
  ✓ service worker starts without errors      12ms
  ✓ popup renders                            431ms
  ✓ options page renders                     318ms
  ✓ content script injects on github.com     772ms

  4 passed · 3.8s
  html      pikabo-results/report.html
```

No hand-written test was involved in that run.

## Install

```bash
npm install --save-dev pikabo
npx playwright install chromium     # one-time browser download
npx pikabo doctor                   # confirm the environment
```

Not on npm yet — until it is, run it from a checkout. [CONTRIBUTING.md](CONTRIBUTING.md#running-it-against-a-real-extension-before-it-is-published)
covers the three ways to do that.

## Getting started

```bash
npx pikabo explore --ext .        # generate a smoke suite from manifest.json and run it
npx pikabo init                   # scaffold tests/smoke.yaml to edit yourself
npx pikabo run tests --ext .      # run a directory of suites
npx pikabo run tests/popup.yaml --ext . --test "popup saves a PDF"
```

`run` exits non-zero when anything fails, so it drops straight into CI.

Use `--test "exact test name"` to run one named test, or `--grep` for substring and regular
expressions (`--grep '/popup .* PDF/i'`). The two are mutually exclusive, and an unmatched
`--test` name fails before launching Chromium and lists the available names.

## Recording a test

Writing the first suite by hand is the slowest part. `record` opens a real browser, watches what
you do, and writes it out:

```bash
pikabo record --ext . --url https://example.com --out tests/save-flow.yaml
```

Click through the extension, close the browser, and you get a runnable suite. Typing collapses
into one `fill` with the final value, switching surfaces emits `openPopup` / `openOptions`, and
selectors prefer whatever you named deliberately — `id`, `data-testid`, `name`, `aria-label`,
then button text.

**A recording captures what you did, not what should be true.** It ends with a screenshot and a
console check; the assertions that matter — `assertText`, `assertStorage`, `assertPdf` — are yours
to add. Treat the output as a first draft.

Full detail: [docs/recording.md](docs/recording.md).

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

Lifecycle steps open those surfaces, `trigger*` steps invoke the extension's registered Chrome
event listeners deterministically, `eval` runs arbitrary JavaScript in any of them, and Chrome
behaviour with no DOM representation is available as an ordered event timeline you can wait on.
All of it is in [docs/surfaces.md](docs/surfaces.md).

The full list of steps is in [docs/steps.md](docs/steps.md). A JSON Schema for editor
autocomplete is in [schema/suite.schema.json](schema/suite.schema.json):

```yaml
# yaml-language-server: $schema=./node_modules/pikabo/schema/suite.schema.json
```

## Use it inside Playwright Test

You do not have to replace an existing Playwright suite with YAML. Extend your own `test` once:

```ts
// fixtures.ts
import path from 'node:path';
import { test as base, expect } from '@playwright/test';
import { createExtensionTest } from 'pikabo/playwright';

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
pikabo run tests --ext . --isolation fresh-profile
```

`--isolation reset` instead reuses one on-disk profile, scrubs extension storage, alarms, download
history, optional permission grants, cookies, and origin storage, then relaunches Chrome between
tests so arbitrary service-worker globals cannot leak. Useful when profile reuse matters, but
fresh-profile remains the simplest CI boundary. Use `closeOtherTabs` inside a test when an install
or welcome tab would interfere before cleanup runs.

## What you get back

Written to `pikabo-results/` (change with `--out`):

- **`report.html`** — one self-contained file. Screenshots are inlined, so it can be attached to
  an issue and opened anywhere. Per-step timeline, expandable console log, failure detail.
- **`results.json`** — the full result tree, for CI gates and for tooling.
- **`summary.md`** — a short pass/fail table plus failure detail.
- **`videos/`**, **`dom/`**, **`traces/`** — replays, page HTML at each failed step, and
  Playwright traces retained on failure.

Screenshots are captured after every interactive step by default (`--shots all | step-end |
failures | none`), into a per-test directory named by step index, so a failure at step 7 is
`07-*.png`. The output directory is cleared at the start of every run — safely, and only when it
holds nothing but pikabo's own output.

How cleaning decides what is safe, what the numbering gaps mean, and the `--shots` / `--trace` /
`--video` flags: [docs/reports.md](docs/reports.md).

## Errors you would otherwise have to go looking for

**Service worker startup errors.** The console of an MV3 service worker is invisible unless you
have its inspector open at the moment it starts. pikabo attaches over the DevTools protocol
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

## Permission audit

Every run records which `chrome.*` namespaces the extension actually reaches and compares that
against `manifest.json`:

```
  1 permission(s) declared but never used: tabs
```

Unjustified permissions are a common cause of Chrome Web Store review delays and are invisible to
a linter — the manifest is valid either way. The reverse case is worse: a namespace used but not
declared is simply `undefined` in a real install, so the code throws for users and not for you.

The report is evidence, not a verdict, and it says so — findings read *not observed* rather than
*unused*, because a permission used only on a path your tests never take is indistinguishable
from a dead one. [docs/permission-audit.md](docs/permission-audit.md) covers that distinction and
the two cases the audit cannot see.

## Validating a generated file

Extensions that export something — a PDF, an image, a Markdown file — are the awkward case,
because "did it work" means looking at the artefact, not the DOM.

Downloads are captured wherever they come from, including `chrome.downloads.download()` calls made
from the service worker with no page involved, and `assertPdf` reads the resulting file:

```yaml
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

Page count, geometry, byte size, producer, and text where the document has any. Page-capture
extensions usually draw the page as an image, so the PDF has no text at all — the step says
`rasterised` rather than failing an unmatchable `containsText`.

[docs/testing-downloads.md](docs/testing-downloads.md) covers `assertFile`, and the habits that
keep tests against a live website from being flaky. A complete worked example is in
[`examples/pagesaver-pdf.yaml`](examples/pagesaver-pdf.yaml).

## Use it from an AI agent

The bundled skill teaches an agent the workflow and the non-obvious parts, and installs into
whichever convention your agent reads:

```bash
pikabo skill install --global         # every project, no per-repo setup
pikabo skill install --dir .          # this repo only; detects what it already uses
pikabo skill check --global           # is the installed copy current?
```

`pikabo mcp` serves the same primitives over MCP (stdio) for interactive exploration, so an agent
can drive the browser and then freeze what worked into a YAML suite.

Prefer the skill for everyday use — it costs nothing until it is needed, whereas MCP tool schemas
sit in the context window of every session. Install targets, drift, and the MCP tool list:
[docs/agents.md](docs/agents.md).

## CI

```yaml
- uses: actions/setup-node@v4
  with: { node-version: 20 }
- run: npm ci
- run: npx playwright install --with-deps chromium
- run: npx pikabo run tests --ext . --shots failures
- uses: actions/upload-artifact@v4
  if: always()
  with:
    name: pikabo-report
    path: pikabo-results/
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
| `pikabo run [suites...]` | Run suite files or directories. Default command. |
| `pikabo explore` | Generate a smoke suite from `manifest.json` and run it. |
| `pikabo record` | Record a browser session into a suite. |
| `pikabo init` | Scaffold `tests/smoke.yaml`. |
| `pikabo doctor` | Check Node, the Chromium binary, ffmpeg, and a manifest. |
| `pikabo skill` | Install the agent skill into a repo or globally. |
| `pikabo mcp` | Serve the runner over MCP for an agent. |

Common flags: `--ext`, `--out`, `--headed`, `--browser-path`, `--browser-channel`, `--timeout`,
`--shots`, `--video`, `--gif`, `--reporter`, `--test`, `--grep`, `--bail`, `--isolation`,
`--keep-profile`, `--no-color`.

Something misbehaving? [docs/troubleshooting.md](docs/troubleshooting.md).

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

`fixtures/` holds the extensions the tests run against — a working one, one that fails on
purpose, one with no service worker, and one exercising side panels and devtools. What each covers
is listed in [CONTRIBUTING.md](CONTRIBUTING.md#fixtures), so it stays correct in one place.

## Documentation

Everything this file leaves out is indexed in [docs/](docs/README.md).

## Contributing

Bug reports, ideas and pull requests are welcome. [CONTRIBUTING.md](CONTRIBUTING.md) covers the
test tiers, the fixtures, how to add a step, and the conventions that are not obvious from the
code. Participation is governed by the [Code of Conduct](CODE_OF_CONDUCT.md).

Security issues go through [private reporting](SECURITY.md), not public issues. That document is
also worth reading before running pikabo anywhere sensitive: it disables a browser protection
by design, and reports capture screenshots and console output that often contain secrets.

Changes are recorded in the [changelog](CHANGELOG.md).

## License

MIT © PixelsTech
