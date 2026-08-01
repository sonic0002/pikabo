# ext-tester enhancement plan

This plan keeps ext-tester focused on extension-aware functional testing rather than recreating
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

## P1 — deterministic functional-test lifecycle

Goal: remove the remaining suite-level sources of stale state and timing ambiguity.

- Add a lifecycle step for closing unowned/install tabs without custom `eval`.
- Let `waitForDownload` distinguish a newly triggered download from an earlier unconsumed match.
- Add explicit test isolation controls for tabs, storage, downloads, cookies, and profile reuse.
- Exercise callback-style, concurrent, cancelled, and interrupted `chrome.downloads` cases.
- Report service-worker stop, restart, and cold-start events in the result timeline.

Acceptance: two tests may export the same filename and use the same selectors without observing
one another's tabs, state, errors, or artefacts.

## P2 — extension-event assertions

Goal: test behavior that does not have a DOM representation.

- Observe and assert runtime messages and ports.
- Observe tab creation, updates, activation, and removal.
- Observe storage changes, alarms, permission requests, commands, context menus, and notifications.
- Add wait/assert steps that use events instead of fixed sleeps.
- Verify content-script execution rather than inferring it from an error-free page load.

Acceptance: a test can prove the causal chain from a page or popup action through the worker to a
Chrome API side effect without writing instrumentation into the extension.

## P3 — Playwright bridge and unified trace

Goal: make ext-tester complementary to Playwright for teams that need TypeScript-level control.

- Publish reusable Playwright fixtures for the extension, popup, options page, and worker.
- Expose extension-aware assertions through Playwright's `expect` API.
- Attach the merged extension console, downloads, screenshots, and worker lifecycle to Playwright
  reports and traces.
- Keep YAML suites and MCP as the low-code and agent-facing layer over the same runtime.

Acceptance: an existing Playwright suite can adopt ext-tester incrementally without rewriting
tests into YAML or losing Playwright fixtures, locators, retries, and trace tooling.

## P4 — development loop and compatibility

- Add watch mode that reloads the unpacked extension and reruns affected tests.
- Test supported Chromium Stable/Beta versions in CI and diagnose flag incompatibilities.
- Add documented capability boundaries for popup emulation and native browser UI.
- Consider Firefox only after the browser adapter boundary is proven by Chromium version testing.

