# Changelog

Notable changes to pikabo. Format follows [Keep a Changelog][kac]; versions follow
[Semantic Versioning][semver].

Before 1.0 the suite format is the stable surface: a change that stops an existing suite running
is a minor version bump and is listed under **Changed** with the migration.

## [Unreleased]

## [0.1.0] — unreleased

First release.

### Requirements

- **Node 22 or newer.** Node 20 and 21 have no global `WebSocket`, which the service-worker
  console capture depends on; on those versions a broken extension could report a clean run.
  pikabo now refuses rather than degrading silently.
- **Chromium / Chrome for Testing**, not stable Google Chrome — see above.

### Added

- **Extension loading without a patched browser.** `--load-extension` plus
  `--disable-features=DisableLoadExtensionCommandLineSwitch` against a throwaway profile, so no
  forked or recompiled Chromium is needed. Requires Chromium / Chrome for Testing, which
  Playwright installs and pikabo uses by default; stable Google Chrome no longer loads unpacked
  extensions from the command line and is not supported.
- **Four addressable contexts** — `page`, `popup`, `options` and the MV3 service `worker` — so a
  suite can drive the parts of an extension that ordinary browser automation cannot reach.
- **YAML suites** with 50 steps and an `eval` escape hatch, validated against a JSON Schema before
  the browser launches, with line numbers and "did you mean" suggestions on a typo.
- **`pikabo explore`** — reads `manifest.json`, generates a smoke suite covering every declared
  surface, and runs it. No hand-written test required.
- **`pikabo record`** — drives a real browser and writes what you did as a suite. Typing
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
- **MCP server** (`pikabo mcp`) exposing the runner primitives to an agent over stdio.
- **Agent skill** (`pikabo skill install`) for Claude Code, Codex/AGENTS.md and Cursor, project
  or global, with `skill check` to find copies that have fallen behind.
- CI across Linux, macOS and Windows, and against Chromium, Chrome and Chrome Beta.

[kac]: https://keepachangelog.com/en/1.1.0/
[semver]: https://semver.org/spec/v2.0.0.html
[Unreleased]: https://github.com/sonic0002/pikabo/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/sonic0002/pikabo/releases/tag/v0.1.0
