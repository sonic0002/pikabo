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
| `navigate` | `navigate: <url>` | `url`, `waitUntil` | Navigate the target context to a URL. Ordinary web tabs are brought to the foreground so active-tab extension APIs act on the page under test. |
| `openPopup` | `openPopup` | `width`, `height`, `keepPageActive` | Open the extension's popup. The page under test stays the active tab, so chrome.tabs.query resolves the way it does for a real popup. |
| `openOptions` | `openOptions` | — | Open the extension's options page and make it the active context. |
| `closePopup` | `closePopup` | — | Close the popup page. |
| `closeOtherTabs` | `closeOtherTabs` | — | Close every browser tab except the target context, including install or welcome tabs opened by the extension. |
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
| `waitForDownload` | `waitForDownload: <pattern>` | `pattern`, `saveAs` | Wait for a new download whose filename matches a glob. Consecutive waits cannot consume the same download. |
| `waitForUrl` | `waitForUrl: <pattern>` | `pattern` | Wait for the context URL to match a glob or regex. |
| `waitForExtensionEvent` | `waitForExtensionEvent: { type, source, equals, contains, matches }` | `**type**`, `source`, `equals`, `contains`, `matches` | Wait for a Chrome-extension runtime event observed after the test began. |

## Assertions

A failing assertion ends the test and captures a screenshot, but the run continues to the next test.

| Step | Form | Options | What it does |
| --- | --- | --- | --- |
| `assertVisible` | `assertVisible: <selector>` | `selector`, `not` | Assert an element is visible. |
| `assertText` | `assertText: { selector, equals, contains, matches, not }` | `selector`, `equals`, `contains`, `matches`, `not` | Assert on an element’s text. |
| `assertCount` | `assertCount: { selector, equals, atLeast, atMost }` | `**selector**`, `equals`, `atLeast`, `atMost` | Assert how many elements match a selector. |
| `assertUrl` | `assertUrl: { equals, contains, matches }` | `equals`, `contains`, `matches` | Assert on the context URL. |
| `assertStorage` | `assertStorage: { key, area, equals, contains, exists }` | `**key**`, `area`, `equals`, `contains`, `exists` | Assert on a chrome.storage value. |
| `assertNoConsoleErrors` | `assertNoConsoleErrors` | `ignore`, `contexts` | Assert no console errors were logged. Defaults to every context; `contexts` narrows it to the extension’s own surfaces, which is what you want against a live site. |
| `assertDownload` | `assertDownload: { pattern, minBytes }` | `pattern`, `minBytes` | Assert a matching download has occurred. When several match, the newest is checked. |
| `assertPermission` | `assertPermission: <permission>` | `permission`, `not` | Assert the extension holds a permission at runtime. |
| `assertExtensionEvent` | `assertExtensionEvent: { type, source, equals, contains, matches }` | `**type**`, `source`, `equals`, `contains`, `matches` | Assert that a matching Chrome-extension runtime event occurred after the test began. |
| `assertPdf` | `assertPdf: { pattern, pages, minPages, maxPages, minBytes, maxBytes, width, height, minHeight, tolerance, producer, containsText }` | `pattern`, `pages`, `minPages`, `maxPages`, `minBytes`, `maxBytes`, `width`, `height`, `minHeight`, `tolerance`, `producer`, `containsText` | Assert on the newest matching downloaded PDF: page count, page geometry, byte size, producer, and text where the document has any. |
| `assertFile` | `assertFile: { pattern, minBytes, maxBytes, contains }` | `pattern`, `minBytes`, `maxBytes`, `contains` | Assert the newest matching downloaded file exists, is a sane size, and optionally contains some text. |
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
| `eval` | `eval: <script>` | `script`, `args` | Run JavaScript in the target context and capture its value. Expressions and IIFEs yield their value; statement bodies must use a top-level return. |

Bold options are required. Anything not listed is rejected before the browser starts.
