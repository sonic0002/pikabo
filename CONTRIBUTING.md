# Contributing

Thanks for helping. This document covers the parts of the repository that are not obvious from
reading it.

## Setup

```bash
npm install
npx playwright install chromium    # the integration tests need a real browser
npm run build
```

`npx pikabo doctor` confirms the environment before you go further.

## Running it against a real extension before it is published

Not on npm yet, so there are three ways to point a working copy at an extension. Pick whichever
fits what you are doing.

**Straight from the repo** — nothing installed, good for hacking on the tool itself:

```bash
node dist/cli.js explore --ext ../my-extension
npm run dev -- explore --ext ../my-extension     # via tsx, no build step needed
```

**`npm link`** — gives you a real `pikabo` command everywhere, and is the only option for an
extension with no `package.json` of its own:

```bash
npm link                                  # once, from the pikabo checkout
cd ../my-extension
pikabo explore --ext .
```

Undo with `npm unlink -g pikabo`. Re-run `npm run build` in the repo after changing the source —
the linked binary points at `dist/`.

**A local tarball** — closest to a published install, so it also proves packaging is sound:

```bash
npm pack                                          # → pikabo-0.1.0.tgz
cd ../my-extension
npm install --save-dev ../pikabo/pikabo-0.1.0.tgz
npx pikabo explore --ext .
```

A `file:` dependency (`npm install --save-dev ../pikabo`) works the same way and picks up
rebuilds automatically, but only if the extension has a `package.json`.

Whichever you choose, run `pikabo doctor --ext .` first — it confirms the Chromium binary is
present and the `manifest.json` parses before anything tries to launch a browser.

## Tests

Three tiers, and the distinction matters when deciding where a new test belongs.

```bash
npm test                  # unit — no browser, runs in about a second
npm run test:integration  # real Chromium against fixtures/
npm run test:all          # both
npm run typecheck
```

**Unit tests** cover anything expressible without a browser: parsing, the step schema, selector
and permission logic, report rendering from fixture data, the skill installer. Prefer this tier —
it is where a failure points straight at a cause.

**Integration tests** launch a real browser against `fixtures/`. Reserve them for behaviour that
only exists in a browser: extension loading, context switching, service-worker instrumentation,
downloads.

### Fixtures

| Fixture | Covers |
| --- | --- |
| `sample-extension` | The working case: popup, options, content script, storage, downloads, worker messaging |
| `broken-extension` | Fails on purpose, so the failure paths stay tested |
| `no-worker-extension` | Content-script only — exercises the path-hash extension-id fallback |
| `surfaces-extension` | Side panel, devtools page, context menus |

If a change alters what a fixture does, check whether an existing test depended on the old
behaviour before adjusting the fixture.

## Adding a step

The step vocabulary has one source of truth: `STEP_SPECS` in `src/dsl/schema.ts`. Adding an entry
there feeds the JSON Schema, the parser's validation, the "did you mean" suggestions, and the
generated documentation.

1. Add the spec to `STEP_SPECS`.
2. Implement the handler in the matching module under `src/dsl/steps/`.
3. Run `npm run docs` to regenerate `schema/suite.schema.json` and `docs/steps.md`. Commit both.
4. Add a test. If the step touches the browser, add it to `tests/suites/sample.yaml` too, so it is
   exercised end to end.

A step that is declared but never wired into `STEP_HANDLERS` fails at runtime rather than at
parse time, so check both.

## Conventions worth knowing

**Write escapes, never control characters.** ANSI sequences use `\u001b`, never a literal ESC
byte. A raw control character is invisible in an editor and is silently dropped by anything that
rewrites the file — which once shipped a build that printed `[1m` at users. A unit test scans
`src/` for raw ESC bytes and fails the build if one appears.

**Tests must not touch the developer's machine.** Anything resolving to `$HOME` takes an
injectable path, so a test writes to a temporary directory instead of your real
`~/.claude/skills`. There is a test asserting this.

**Failure messages are a feature.** When an assertion fails, say what was actually there — a
missing selector reports the ids present on the page rather than only that it timed out. Assume
the reader is debugging at speed.

**Comment the non-obvious, not the obvious.** Explain why a workaround exists, what breaks
without it, or which constraint forced a shape. Skip comments that restate the code.

**Never claim more than was observed.** The permission audit says "not observed" rather than
"unused" because a run only sees the paths its tests take. Keep that honesty in any feature that
infers something about the extension under test.

## Pull requests

- Keep `npm run test:all` and `npm run typecheck` green.
- Regenerate docs when the schema changes.
- One concern per PR. A bug fix and a refactor in the same diff take twice as long to review.
- Describe what breaks without the change; that is usually the most useful sentence in the
  description.

CI runs unit tests and integration tests on Linux, macOS and Windows, against Playwright's
Chromium. A change that only works on one platform will show up there — Windows especially, since
path separators and line endings differ. Stable Chrome is not tested because it no longer loads
unpacked extensions at all; see the Limitations section of the README.

## Reporting bugs

Include the output of `pikabo doctor --ext .`, your `manifest.json` version (MV2/MV3), and the
suite that reproduces it. `pikabo-results/results.json` from a failing run is usually enough to
diagnose the rest.
