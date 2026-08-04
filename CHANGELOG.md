# Changelog

Notable changes to ext-tester. Format follows [Keep a Changelog][kac]; versions follow
[Semantic Versioning][semver].

Before 1.0 the suite format is the stable surface: a change that stops an existing suite running
is a minor version bump and is listed under **Changed** with the migration.

## [Unreleased]

## [0.1.0] — unreleased

First release.

### Added

- **Extension loading without a patched browser.** `--load-extension` plus
  `--disable-features=DisableLoadExtensionCommandLineSwitch` against a throwaway profile, so no
  forked or recompiled Chromium is needed. Works with Playwright's Chromium or any binary passed
  to `--browser-path`.
- **Four addressable contexts** — `page`, `popup`, `options` and the MV3 service `worker` — so a
  suite can drive the parts of an extension that ordinary browser automation cannot reach.
- **YAML suites** with 50 steps and an `eval` escape hatch, validated against a JSON Schema before
  the browser launches, with line numbers and "did you mean" suggestions on a typo.
- **`ext-test explore`** — reads `manifest.json`, generates a smoke suite covering every declared
  surface, and runs it. No hand-written test required.
- **`ext-test record`** — drives a real browser and writes what you did as a suite. Typing
  collapses into one `fill`; context switches emit their opener; selectors prefer `id`,
  `data-testid`, `name`, `aria-label` and button text over structural paths.
- **Permission audit.** Records which `chrome.*` namespaces the extension actually reaches and
  compares against `manifest.json`, reporting permissions declared but not observed, and APIs used
  without being declared. Findings state their own coverage limits.
- **Service-worker startup errors** captured over the DevTools protocol, including anything thrown
  before instrumentation could be installed, with file and line.
- **Downloads captured wherever they originate**, including `chrome.downloads.download()` from a
  service worker, preserved under the filename the extension asked for.
- **Reports**: self-contained HTML with inlined screenshots, `results.json`, `summary.md`, and
  optional WebM/GIF recordings. One screenshot directory per test, zero-padded so files sort into
  execution order.
- **`assertPdf` and `assertFile`** for validating exported artefacts — page count, geometry, byte
  size, producer, and text where the document has any.
- **MCP server** (`ext-test mcp`) exposing the runner primitives to an agent over stdio.
- **Agent skill** (`ext-test skill install`) for Claude Code, Codex/AGENTS.md and Cursor, project
  or global, with `skill check` to find copies that have fallen behind.
- CI across Linux, macOS and Windows, and against Chromium, Chrome and Chrome Beta.

[kac]: https://keepachangelog.com/en/1.1.0/
[semver]: https://semver.org/spec/v2.0.0.html
[Unreleased]: https://github.com/sonic0002/ExtTester/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/sonic0002/ExtTester/releases/tag/v0.1.0
