---
name: release-skill
description: Use when preparing or cutting a release of this package — bumping the version, dating the changelog, tagging, pushing, publishing to npm, or creating a GitHub release.
---

# Release

## Overview

**`npm publish` is a one-way door. Everything before it is reversible; it is not.** Unpublishing
is restricted after 72 hours and the name stays claimed regardless.

Two hard rules follow from that:

1. **Never publish from a commit CI has not gone green on.** Not "CI passed on the previous
   commit". The tag must point at the exact commit that was validated and published.
2. **Never advance past a STOP gate without the human saying so.** The gates exist because the
   agent cannot see the npm page, the rendered README, or the consequences of a bad publish.

## Phase 1 — Preflight

```bash
git status --short          # must be clean, or you don't know what you're shipping
git branch --show-current   # must be main
gh run list --limit 1       # last run on main must be success
npm whoami                  # must print a username, not 401
```

`npm whoami` failing with **401** is the single most common blocker. `npm publish` reports it as a
confusing **E404 Not Found** because the registry will not reveal whether a package exists to an
unauthenticated caller. Fix with `npm login` before doing anything else — it is interactive, so
the human runs it.

## Phase 2 — Update what goes stale at a release

Work through all of these. Each has burned a release before.

| File | What to check |
|---|---|
| `CHANGELOG.md` | Move `## [Unreleased]` entries under a dated version heading. Never ship `— unreleased`. |
| `README.md` | Pre-publish scaffolding ("not on npm yet"), version numbers, supported-platform claims, install instructions |
| `package.json` | `version`, and whether `files` still covers everything the package needs |
| `docs/` | Anything that contradicts the code. Regenerate what is generated: `npm run docs` |
| `CONTRIBUTING.md` | Instructions that assumed the package was unpublished |

Then confirm nothing generated has drifted:

```bash
npm run docs && git diff --stat docs/ schema/    # must be empty
```

## Phase 3 — Verify

Run all of it. A green subset is not evidence.

```bash
npm run typecheck
npm test
npm run test:integration
npm run build
```

Then prove the *artifact*, not the working tree — packing is not installing:

```bash
npm pack --pack-destination /tmp/relcheck
cd /tmp/relcheck && npm init -y && npm install ./<name>-<version>.tgz
npx <bin> --version          # the binary actually runs
npx <bin> <smoke command>    # a real end-to-end command
```

Check the tarball contents match intent — `npm pack --dry-run` lists every file. Assets referenced
by the README from absolute URLs should **not** be in it.

## STOP GATE A — human reviews the diff

Show the human `git status --short` and `git diff`. State plainly what changed, what you verified,
and anything you could not verify. **Wait for approval.** Do not commit.

## Phase 4 — Commit and push

```bash
git add -A && git commit    # message describing the release
git push
gh run list --limit 1       # then watch until it completes
```

## STOP GATE B — human confirms CI is green

CI must be green **on this commit**. Report the per-job status:

```bash
gh run view <id>
```

If anything failed, stop. Do not tag. Do not publish. Fix, push, re-verify.

## Phase 5 — Tag

Only after CI is green on the exact commit being tagged.

```bash
git tag -a v<version> -m "<name> <version>"
git push origin v<version>
git rev-list -n1 v<version>   # confirm it points where you think
```

## STOP GATE C — human authorises the publish

This is the irreversible step. State explicitly: the version, that it cannot be undone, and that
the name is claimed permanently either way. **Wait for an explicit yes.**

## Phase 6 — Publish

```bash
npm publish            # add --otp=<code> if 2FA is enabled on the account
```

`prepublishOnly` runs the build, so there is no separate build step.

## Phase 7 — GitHub release

```bash
gh release create v<version> --title "<name> <version>" --notes-from-tag
```

## Phase 8 — Post-publish verification

Do not assume it worked. Install what the registry actually serves:

```bash
npm view <name> version
cd /tmp && mkdir postcheck && cd postcheck && npm init -y
npm install --save-dev <name>
npx <bin> <smoke command>
```

Then confirm the published README is the corrected one:

```bash
npm pack <name>@<version> && tar -xzf <name>-<version>.tgz
grep -n "not on npm yet" package/README.md   # must find nothing
```

## Failure modes worth knowing

| Symptom | Cause |
|---|---|
| `E404 Not Found - PUT` on publish | Not authenticated. `npm whoami` returns 401. Run `npm login`. |
| README images missing on npm, fine on GitHub | npm strips SVG. Use PNG, referenced by absolute `raw.githubusercontent.com` URL. |
| README links broken in the tarball | npm rewrites relative links only when `repository` is set in `package.json`. |
| `EACCES` installing into a project | npm walked up to a `package.json` in `$HOME`. Install inside a real project directory. |

## Rationalizations

| Excuse | Reality |
|---|---|
| "It's docs-only, CI passing before is enough" | Docs-only changes are exactly what the npm page renders. Tag a validated commit. |
| "I'll publish now and fix the README right after" | A README fix costs a version number. The first impression is already made. |
| "`npm pack` looked right" | Packing is not installing. Install the tarball and run the binary. |
| "It's a patch bump, the gates are overkill" | The one-way door is identical at every version. |
| "The human is busy, I'll proceed and report" | Gates are the human's decision, not a formality to route around. |

## Red flags — stop

- About to `npm publish` without a green CI run on the tagged commit
- About to tag a commit that has not been pushed
- `CHANGELOG.md` still says `unreleased`
- Skipping the clean-install check because the working tree passed
- Committing or pushing without showing the human the diff first
- Proceeding past a STOP gate because the answer "seems obvious"
