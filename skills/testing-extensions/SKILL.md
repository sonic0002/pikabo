---
name: testing-extensions
description: Use when writing, running, or debugging automated tests for a Chrome or Chromium extension — driving its popup, options page, content scripts or MV3 service worker, checking a file it exports (PDF, image, Markdown, CSV), or working out why it misbehaves in a real browser. Also use when asked to verify an extension change without testing it by hand.
---

# Testing a Chrome extension with ext-tester

`ext-test` loads an unpacked extension into a real Chromium and drives every part of it, then
writes a report. Use it instead of asking a human to click through the browser.

Run commands from the extension directory (the one containing `manifest.json`).

## Start here, always

```bash
ext-test doctor --ext .     # Chromium present? manifest parses?
ext-test explore --ext .    # generate a smoke suite from the manifest and run it
```

`explore` reads `manifest.json`, works out what surfaces exist, writes
`tests/smoke.generated.yaml`, and runs it. Do this before writing any test by hand: it tells you
the popup path, options path, content-script match patterns and permissions, and it establishes
whether the extension is healthy at all.

Never hand-write a suite before running `explore`. Half of what you would guess is already known.

## The four contexts

This is the point of the tool. `in:` picks which one a step acts on.

| `in:` | What it is |
| --- | --- |
| `page` | the web page under test, where content scripts run |
| `popup` | the extension popup, as a real document |
| `options` | the options page |
| `worker` | the MV3 service worker — `chrome.storage`, `chrome.runtime`, alarms, messaging |

`openPopup` and `openOptions` make that context active, so following steps need no `in:`.

## Writing a suite

YAML. One action per step. The complete step vocabulary — 38 steps with their options — is in
`docs/steps.md` in the ext-tester repo; `ext-test --help` lists commands and flags only. If
neither is to hand, `ext-test explore` output plus the examples below cover most cases.

```yaml
name: my extension

after:
  - clearStorage            # runs after every test, passing or failing

tests:
  - name: popup saves a setting
    steps:
      - navigate: https://example.com
      - openPopup
      - click: "#save"
      - waitForText:
          selector: "#status"
          text: Saved
      - assertStorage:
          key: lastSave
          exists: true
      - assertNoConsoleErrors:
          contexts: [popup, worker]
```

Run it:

```bash
ext-test run tests --ext .
```

Exit code is non-zero if anything failed.

## Gotchas that cost real time

These are not obvious and each one has bitten:

1. **Scope console assertions on live sites.** A bare `assertNoConsoleErrors` covers every
   context including the page, so third-party scripts on a real site fail your test at random.
   Use `contexts: [popup, worker]` whenever the page under test is not one you control.

2. **Give generation steps their own timeout.** Producing a PDF or a large image can take 10–90
   seconds, far past the default. Put `timeout: 90000` on the `waitForDownload` and the
   assertion, not on the whole suite.

3. **A bare `{` starts a YAML flow mapping.** Any `eval` script containing an object literal
   must use a block scalar:
   ```yaml
   - eval:
       script: |
         return await chrome.runtime.sendMessage({ type: 'ping' });
       in: popup
   ```

4. **`chrome.runtime.sendMessage` from the worker does not reach the worker's own listener.**
   Chrome never delivers a message back to its sender. Send from `popup` or a content script
   instead.

5. **Capture-style PDFs contain no text.** Extensions that screenshot a page produce a rasterised
   PDF, so `containsText` can never match. Assert on `pages`, `width`, `minHeight`, `minBytes`
   instead. `assertPdf` reports `rasterised` when this is the case.

## Checking an exported file

Downloads are captured wherever they come from — including
`chrome.downloads.download()` called from the service worker, which involves no page at all —
and land in `<out>/downloads/` under the name the extension asked for.

```yaml
- click: "#export-pdf"
- waitForDownload:
    pattern: "Report*.pdf"
    timeout: 90000
- assertPdf:
    pattern: "Report*.pdf"
    pages: 1
    width: 595.28          # A4 width in points; 72pt = 1 inch
    minHeight: 1000        # short page = only the viewport was captured
    minBytes: 50000        # a blank capture collapses to a few KB
    producer: /jsPDF/
```

`assertFile` covers other formats: `minBytes`, `maxBytes`, `contains`.

## Reading the results

Written to `ext-test-results/` by default.

- **`summary.md`** — read this first. Compact pass/fail table plus failure detail. Cheapest.
- **`results.json`** — the full tree: every step, its status, timing, error, and screenshot path.
  Parse this when you need specifics.
- **`screenshots/`** — one per interactive step. Look at the screenshot for a failing step before
  theorising about the cause.
- **`report.html`** — self-contained, for a human to open. Do not read it; it has base64 images
  inlined and will flood your context.

## When a test fails

1. Read `summary.md`. Failure messages are written to be actionable — a missing selector reports
   what elements *are* present, not just a timeout.
2. Look at the failing step's screenshot.
3. Check the console: failures include console errors from all four contexts. Service worker
   startup errors are captured with file and line.
4. Re-run just that test: `ext-test run tests --ext . --grep "part of the name"`.
5. To watch it happen, add `--headed`. To keep the browser profile, add `--keep-profile`.

Do not add `wait:` steps to fix flakiness. Use `waitFor`, `waitForText`, or `waitForDownload`.

## Exploring interactively

If a suite is hard to write because the extension's UI is unfamiliar, ext-tester also ships an
MCP server (`ext-test mcp --ext .`) that holds one browser open across calls, so you can click
around and read the console before committing to YAML. Only worth it when you are genuinely
exploring; for running tests the CLI is faster.

## Command reference

| Command | Purpose |
| --- | --- |
| `ext-test explore --ext .` | Generate a smoke suite from the manifest and run it |
| `ext-test run <paths> --ext .` | Run suite files or directories |
| `ext-test init --ext .` | Scaffold `tests/smoke.yaml` |
| `ext-test doctor --ext .` | Check the environment |

Useful flags: `--headed`, `--grep`, `--bail`, `--timeout`, `--shots all|step-end|failures|none`,
`--video on`, `--out <dir>`, `--no-color`.

If `ext-test` is not on PATH, it has not been installed — see the ext-tester README for running
it from a clone (`node <repo>/dist/cli.js`) or via `npm link`.
