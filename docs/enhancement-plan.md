# pikabo enhancement plan

This plan keeps pikabo focused on extension-aware functional testing rather than recreating
Playwright. Priorities are ordered by correctness, developer impact, and how difficult the same
capability is to build reliably in a project-local Playwright fixture.

## P0 — artefact and active-tab correctness

Status: completed on 2026-08-01.

- Preserve Chrome download IDs through filename restoration.
- Record consecutive and repeated-filename downloads as distinct events.
- Make download waits and file assertions select the newest match.
- Preserve values returned by synchronous and async IIFEs in `eval`.
- Foreground ordinary pages after `navigate` so active-tab APIs target the test page.
- Cover each behavior with unit or real-Chromium regression tests.

## P1a — deterministic functional-test lifecycle

Goal: remove the remaining suite-level sources of stale state and timing ambiguity.

Status: completed on 2026-08-03.

- [x] Add a lifecycle step for closing unowned/install tabs without custom `eval`.
- [x] Let `waitForDownload` distinguish a newly triggered download from an earlier unconsumed match.
- [x] Add fresh-profile isolation by default and an explicit reusable-session mode.
- [x] Expand reusable-profile cleanup across extension storage, alarms, download history, optional
  permission grants, cookies, and origin-backed storage; relaunch Chrome to clear worker memory.
- [x] Exercise callback-style, concurrent, cancelled, and interrupted `chrome.downloads` cases.
- [x] Report CDP-observed service-worker cold-start, stop, and restart boundaries in the result
  timeline.

Acceptance: two tests may export the same filename and use the same selectors without observing
one another's tabs, state, errors, or artefacts.

## P2 — extension-event assertions

Goal: test behavior that does not have a DOM representation.

Status: initial event timeline and wait/assert steps completed on 2026-08-03.

- [x] Observe and assert runtime messages, port connections, tabs, storage, downloads, alarms,
  permissions, commands, context menus, and notifications.
- [x] Add wait/assert steps that use events instead of fixed sleeps.
- [x] Verify content-script execution through its isolated browser execution context.
- [ ] Capture messages sent outward by the worker and the full lifetime of connected ports.
- [x] Capture service-worker lifecycle boundaries from Chrome protocol events without polling.
- [ ] Test natural MV3 idle suspension across supported Chrome versions without debugger lifetime
  skew.

Acceptance: a test can prove the causal chain from a page or popup action through the worker to a
Chrome API side effect without writing instrumentation into the extension.

## P1b — broader surfaces, Playwright adoption, forensics, compatibility

Status: completed on 2026-08-03.

- [x] Address side-panel, DevTools-page, offscreen-document, and MV2 background-page surfaces.
- [x] Add deterministic action, command, and context-menu triggers with capability-aware errors.
- [x] Publish `pikabo/playwright`, extending an existing Playwright `test` with extension
  fixtures instead of replacing its runner or APIs.
- [x] Capture DOM snapshots at failed steps, retain Playwright traces on failure, and report the
  real browser channel/version.
- [x] Run unit checks on Linux/macOS/Windows and integration checks across bundled Chromium,
  Chrome Stable, and Chrome Beta in CI. *(Stable Chrome and Chrome Beta were dropped on
  2026-08-05: they no longer load unpacked extensions at all, so the jobs could never pass. CI
  now runs all three platforms on Chromium.)*

Acceptance: extension authors can cover the major extension-only surfaces from YAML or adopt the
same runtime in an existing Playwright suite, with actionable failure artifacts and continuous
browser/platform verification.

## P3 — richer Playwright assertions and unified trace

Goal: make pikabo complementary to Playwright for teams that need TypeScript-level control.

- [x] Publish reusable Playwright fixtures for the extension, popup, options page, side panel, and worker.
- Expose extension-aware assertions through Playwright's `expect` API.
- [x] Attach an extension-context Playwright trace to failed Playwright tests.
- Attach the merged extension console, downloads, screenshots, and worker lifecycle to Playwright
  reports and traces.
- Keep YAML suites and MCP as the low-code and agent-facing layer over the same runtime.

Acceptance: an existing Playwright suite can adopt pikabo incrementally without rewriting
tests into YAML or losing Playwright fixtures, locators, retries, and trace tooling.

## P4 — development loop and compatibility

- Add watch mode that reloads the unpacked extension and reruns affected tests.
- Test supported Chromium Stable/Beta versions in CI and diagnose flag incompatibilities.
- Add documented capability boundaries for popup emulation and native browser UI.
- Consider Firefox only after the browser adapter boundary is proven by Chromium version testing.
