# Step reference

_Generated from `src/dsl/schema.ts` by `npm run docs`. Do not edit by hand._

Every step accepts three options on top of its own:

| Option | Meaning |
| --- | --- |
| `in` | Which context to act on: `page`, `popup`, `options`, `worker`, or a tab you named. Defaults to the active context. |
| `timeout` | Milliseconds to allow this step. Defaults to the test, then the suite, then `--timeout`. |
| `description` | Replaces the label shown in the report. |

## Navigation and lifecycle

Moving between contexts. `openPopup` and `openOptions` also make that context active, so following steps do not need `in:`.

| Step | Form | Options | What it does |
| --- | --- | --- | --- |
| `navigate` | `navigate: <url>` | `url`, `waitUntil` | Navigate the target context to a URL. |
| `openPopup` | `openPopup` | `width`, `height` | Open the extension's popup as a page and make it the active context. |
| `openOptions` | `openOptions` | — | Open the extension's options page and make it the active context. |
| `closePopup` | `closePopup` | — | Close the popup page. |
| `reloadExtension` | `reloadExtension` | — | Call chrome.runtime.reload() and wait for the worker to come back. |
| `newTab` | `newTab: <url>` | `url`, `name` | Open a new tab, optionally naming it for later `switchTo`. |
| `switchTo` | `switchTo: <context>` | `context` | Make a named context active for subsequent steps. |
| `wait` | `wait: <ms>` | `ms` | Wait a fixed number of milliseconds. |

## Interaction

All of these act on the active context unless `in:` says otherwise.

| Step | Form | Options | What it does |
| --- | --- | --- | --- |
| `click` | `click: <selector>` | `selector`, `button`, `clickCount`, `force` | Click an element. |
| `fill` | `fill: { selector, value }` | `**selector**`, `**value**` | Set the value of an input. |
| `type` | `type: { selector, text, delay }` | `**selector**`, `**text**`, `delay` | Type text with per-key events. |
| `press` | `press: <key>` | `key`, `selector` | Press a key. |
| `select` | `select: { selector, value }` | `**selector**`, `**value**` | Choose an option in a <select>. |
| `check` | `check: <selector>` | `selector` | Check a checkbox or radio. |
| `uncheck` | `uncheck: <selector>` | `selector` | Uncheck a checkbox. |
| `hover` | `hover: <selector>` | `selector` | Hover over an element. |
| `scroll` | `scroll: { selector, x, y }` | `selector`, `x`, `y` | Scroll the page or an element. |
| `upload` | `upload: { selector, files }` | `**selector**`, `**files**` | Attach files to a file input. |

## Waiting

Prefer these over `wait`, which sleeps for a fixed time and makes suites slow and flaky.

| Step | Form | Options | What it does |
| --- | --- | --- | --- |
| `waitFor` | `waitFor: <selector>` | `selector`, `state` | Wait for a selector to reach a state. |
| `waitForText` | `waitForText: <text>` | `text`, `selector` | Wait for text to appear. |
| `waitForDownload` | `waitForDownload: <pattern>` | `pattern`, `saveAs` | Wait for a download whose filename matches a glob. |
| `waitForUrl` | `waitForUrl: <pattern>` | `pattern` | Wait for the context URL to match a glob or regex. |

## Assertions

A failing assertion ends the test and captures a screenshot, but the run continues to the next test.

| Step | Form | Options | What it does |
| --- | --- | --- | --- |
| `assertVisible` | `assertVisible: <selector>` | `selector`, `not` | Assert an element is visible. |
| `assertText` | `assertText: { selector, equals, contains, matches, not }` | `selector`, `equals`, `contains`, `matches`, `not` | Assert on an element’s text. |
| `assertCount` | `assertCount: { selector, equals, atLeast, atMost }` | `**selector**`, `equals`, `atLeast`, `atMost` | Assert how many elements match a selector. |
| `assertUrl` | `assertUrl: { equals, contains, matches }` | `equals`, `contains`, `matches` | Assert on the context URL. |
| `assertStorage` | `assertStorage: { key, area, equals, contains, exists }` | `**key**`, `area`, `equals`, `contains`, `exists` | Assert on a chrome.storage value. |
| `assertNoConsoleErrors` | `assertNoConsoleErrors` | `ignore` | Assert no console errors were logged in any context so far. |
| `assertDownload` | `assertDownload: { pattern, minBytes }` | `pattern`, `minBytes` | Assert a matching download has occurred. |
| `assertPermission` | `assertPermission: <permission>` | `permission`, `not` | Assert the extension holds a permission at runtime. |
| `expect` | `expect: { value, equals, contains, matches, truthy }` | `value`, `equals`, `contains`, `matches`, `truthy` | Assert on the value produced by the previous `eval`. |

## Storage

These go through the service worker, so they need an extension that declares one.

| Step | Form | Options | What it does |
| --- | --- | --- | --- |
| `setStorage` | `setStorage: { key, value, area }` | `**key**`, `value`, `area` | Write a chrome.storage value. |
| `clearStorage` | `clearStorage` | `area` | Clear a chrome.storage area. |

## Capture and escape hatch

`eval` runs arbitrary JavaScript in any context and stores its result for the next `expect`.

| Step | Form | Options | What it does |
| --- | --- | --- | --- |
| `screenshot` | `screenshot: <name>` | `name`, `fullPage`, `selector` | Capture a named screenshot. |
| `note` | `note: <text>` | `text` | Record a note in the report without acting. |
| `eval` | `eval: <script>` | `script`, `args` | Run JavaScript in the target context and capture its return value. |

Bold options are required. Anything not listed is rejected before the browser starts.
