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
```

`run` exits non-zero when anything fails, so it drops straight into CI.

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

Four contexts are addressable, and this is most of the point of the tool:

| `in:` | What it is |
| --- | --- |
| `page` | the web page under test, where content scripts run |
| `popup` | the extension popup, as a real document |
| `options` | the options page |
| `worker` | the MV3 service worker — `chrome.storage`, `chrome.runtime`, alarms, messaging |

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

The full list of steps is in [docs/steps.md](docs/steps.md). A JSON Schema for editor
autocomplete is in [schema/suite.schema.json](schema/suite.schema.json):

```yaml
# yaml-language-server: $schema=./node_modules/ext-tester/schema/suite.schema.json
```

## What you get back

Written to `ext-test-results/` (change with `--out`):

- **`report.html`** — one self-contained file. Screenshots are inlined, so it can be attached to
  an issue and opened anywhere. Per-step timeline, expandable console log, failure detail.
- **`results.json`** — the full result tree, for CI gates and for tooling.
- **`summary.md`** — a short pass/fail table plus failure detail.
- **`videos/*.webm`** — with `--video on`; add `--gif` to also produce GIFs (needs ffmpeg).

Screenshots are captured after every interactive step by default (`--shots step-end`). Use
`--shots all` for a screenshot after literally every step, or `--shots failures` for the minimum.

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
`--gif`, `--reporter`, `--grep`, `--bail`, `--keep-profile`.

## Limitations

- Chrome and Chromium only. The browser layer is isolated so Firefox could follow, but it is not
  supported today.
- Unpacked extensions only — not `.crx` installs from the Web Store.
- Browser-chrome UI outside a document (the extension's toolbar icon menu, the puzzle-piece
  overflow, native permission prompts) cannot be clicked. Everything those surfaces trigger is
  reachable through the popup document, the options page, or the worker.
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

MIT
