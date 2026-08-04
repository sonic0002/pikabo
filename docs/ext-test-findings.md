# pikabo findings from writing the PageSaver normal-PDF suite

Found while writing `tests/normal-pdf.yaml` against pikabo `0.1.0` (commit `3d3333c`),
extension PageSaver v2.5.0 (MV3, capture-based PDF export). Ordered by how much time each cost.

Line numbers are from the pikabo working tree at that commit.

## Resolution (2026-08-01)

All four findings were confirmed and addressed:

- Download restoration now preserves Chrome download IDs until recording, so repeated flattened
  paths do not collide and duplicate requested filenames remain distinct records.
- Download waits and file assertions select the newest matching record.
- `eval` compiles valid expressions first, preserving values returned by synchronous and async
  IIFEs; statement bodies continue to support a top-level `return`.
- Navigating an ordinary page now brings that tab to the foreground, so active-tab APIs such as
  `captureVisibleTab` target the page under test even when the extension opened an install tab.

Regression tests cover IIFE return values and, in real Chromium, consecutive downloads, repeated
filenames, latest-match selection, and foreground navigation.

---

## 1. Only the first download per suite is recorded under its intended name

**Severity: high.** Affects any extension that exports more than one file in a run — which is
any suite that tests a matrix (page mode × quality, in our case).

### Symptom

A suite captures three PDFs. The first is recorded correctly. Every later
`waitForDownload` times out at 90s with `Downloads seen: <first file only>`, even though the
extension completed each capture and `chrome.downloads.download()` resolved every time.

### Evidence

Asking Chrome directly, after two successful captures:

```json
[{"id": 2, "file": "download.pdf", "state": "complete", "bytes": 22995},
 {"id": 1, "file": "download.pdf", "state": "complete", "bytes": 22995}]
```

Both downloads completed. Both live at the **same on-disk path**, because the runner renames
each finished file to the extension's intended name, which frees `download.pdf` for the next one.

### Cause

`intendedNames()` (`src/browser/session.ts:250`) correlates requests to files by download id, but
then returns `Map<item.filename, requested>` — keyed by the on-disk path:

```ts
if (request?.requested && item.filename) out.push([item.filename, request.requested]);
return new Map(pairs);
```

With every download flattened to the same `download.pdf` path, all entries collide on one key and
the last write wins. `restoreIntendedName()` (`:279`) then looks up that path and gets whichever
name survived the collision — in practice the *first* download's name. `settleDownload()` (`:299`)
renames the second file to that same name, finds the existing record at `:323`, and returns
without recording anything.

So the id-based correlation the docstring promises is discarded at the map key.

### Suggested fix

Keep the correlation on the id. Track which ids have already been restored on the session, and
when several search results share a path, take the newest unhandled one:

```ts
private readonly restoredDownloadIds = new Set<number>();
// in the worker evaluate: return {id, filename, requested} triples, not [path, name] pairs
// in restoreIntendedName: candidates = triples.filter(t => t.filename === path
//                                                    && !this.restoredDownloadIds.has(t.id))
//                         pick max id, then this.restoredDownloadIds.add(id)
```

A regression test would be an extension that downloads twice in one test with distinct filenames.

### Workaround used here

Drive the capture through `chrome.tabs.sendMessage` from the worker and assert on the returned
data URL instead of the download, keeping exactly one download-based test per suite.

---

## 2. `waitForDownload` / `assertDownload` match the oldest file, not the newest

**Severity: medium.** Silent wrong-answer rather than a failure, which makes it worse than a crash.

`waitForFile()` (`src/dsl/steps/files.ts:88`) and `assertDownload` (`src/dsl/steps/assertions.ts:156`)
both use `.find()` over `session.downloads`, which is push-ordered oldest-first:

```ts
const hit = ctx.session.downloads.find((d) => d.path && matchesPattern(d.filename, pattern));
```

A suite that exports `report.pdf` in three consecutive tests asserts on the **first** one every
time. Later tests pass while asserting on a stale artefact — the assertion looks green and proves
nothing.

**Suggested fix:** match newest-first by default (`findLast`, or sort by timestamp), or add an
explicit `latest: true` option. Newest-first seems like the least surprising default: a step that
runs after an action almost always means the file that action just produced.

Worked around here by giving every test a unique download filename (per-test `document.title`,
since the extension derives the filename from the page title).

---

## 3. `compileScript` silently discards the value of an IIFE

**Severity: medium.** Cost the first debugging round; the error message points away from the cause.

`compileScript()` (`src/browser/session.ts:643`) decides between expression and statement body:

```ts
const isBody = /\breturn\b/.test(trimmed) || /;\s*\S/.test(trimmed);
```

An IIFE — the natural way to write a multi-statement script that yields a value, and what an LLM
or anyone coming from `page.evaluate()` will reach for first — contains `return`, so it is treated
as a body:

```yaml
- eval:
    script: |
      (() => {
        document.title = 'FIXTURE';
        return document.documentElement.scrollHeight;
      })()
- expect:
    truthy: true      # fails: "Expected a truthy value, got undefined"
```

The script *runs* — side effects happen — but its value is dropped, because the generated function
body is a bare expression statement with no outer `return`. The failure surfaces at the `expect`,
so the natural reading is "my assertion is wrong" rather than "my script's return value was
discarded". I initially misdiagnosed this as the fixture not rendering.

**Suggested fix**, cheapest first:

1. Document it in `docs/steps.md` under `eval`: scripts must use a top-level `return`; an IIFE's
   value is not captured.
2. Treat a script that is a single parenthesised expression (`trimmed.startsWith('(') &&
   trimmed.endsWith(')')`) as an expression regardless of an inner `return`.
3. Or detect the case and fail loudly: if `isBody` is true and the compiled body contains no
   top-level `return`, throw `"eval script has no top-level return, so it produces no value for
   expect"` instead of silently yielding `undefined`.

---

## 4. A tab opened on install stays active in front of the page under test

**Severity: medium**, and probably worth a documented pattern rather than only a code change —
onboarding/welcome tabs on install are very common.

PageSaver opens a welcome page from `chrome.runtime.onInstalled` (`background.js:517`,
`details.reason === 'install'`). Every pikabo run is a fresh install, so every session gets a
foreign tab that is **active**, in front of the page under test. Three consequences:

1. **Capture-based extensions capture the wrong tab.** `chrome.tabs.captureVisibleTab` grabs the
   active tab of the window. Until something activates the page under test, the extension
   screenshots the welcome page. A probe confirmed the failure mode:

   ```
   threw: Cannot access contents of url "". Extension manifest must request permission
     to access this host.  |  tabs=…:https://example.com/ | …:(none) ACTIVE
   ```

   The page under test is present but not active. This only self-corrects because `openPopup`
   calls `bringToFront()` on the page under test (`session.ts:463`, `:478`) — so a suite that
   captures **without** opening the popup (context-menu paths, `chrome.action.onClicked`,
   commands) captures the wrong tab with no diagnostic at all.

2. **`assertNoConsoleErrors` picks up third-party noise.** The welcome page here embeds a video
   player, so unrelated failures appear from `tab2`:

   ```
   [tab2] @bilibili/bili-user-fingerprint(report): report is not found
   [tab2] Access to XMLHttpRequest at 'https://bvc.bilivideo.com/…' blocked by CORS policy
   ```

   `contexts:` narrows this, but only if you already know the tab exists.

3. **`chrome.tabs.query({active: true, currentWindow: true})` from the worker returns it**, not the
   page under test — so worker-driven steps act on the wrong tab.

**Suggested fixes:**

- Have `navigate: … in: page` call `bringToFront()` on the target, matching what `openPopup`
  already does. A step that navigates the page under test almost certainly means it to be the
  foreground tab.
- Optionally record tabs the extension opens during install and close them before the first test,
  or expose `closeForeignTabs: true` as a run option.
- At minimum, add it to the gotchas list in the skill/README: extensions that open a tab on
  install need it closed in `before:`, and here is the snippet.

Workaround used here, in suite `before:` — note it must tolerate a tab whose URL is still empty
while it navigates, which is exactly when the first test starts:

```yaml
- eval:
    in: worker
    script: |
      const tabs = await chrome.tabs.query({});
      const strays = tabs.filter((t) => !(t.url || '').includes('example.com')
                                     && !(t.url || '').startsWith('chrome-extension://'));
      await Promise.all(strays.map((t) => chrome.tabs.remove(t.id).catch(() => {})));
      return 'closed ' + strays.length;
```

---

## Non-issues, recorded so they are not re-investigated

- **`captureVisibleTab` works fine in headless.** I wrongly concluded otherwise: a headless run
  produced an 8KB PDF and a headed run 24KB, which looked like "headless captures blank". The
  fixture was flat colour blocks, which compress to almost nothing, and my `minBytes` threshold
  was simply too high; the headed window was merely larger. A direct probe returned a 311KB
  PNG data URL from `captureVisibleTab` under headless. No pikabo change needed.
- **`assertPdf` is the right shape for this extension.** Page count, `minPages`, geometry and
  `minBytes` all behaved, and the `rasterised` note in the report is genuinely useful for a
  screenshot-based exporter — it says at a glance that `containsText` is not applicable.
- **Failure messages are good.** `No download matching "X" within 90000ms. Downloads seen: …`
  listing what *did* arrive is what made finding issue 1 possible at all.

---

Note: this repo's `.gitignore` excludes `*.md`, so this file is untracked as written.
