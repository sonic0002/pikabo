# Reports and artefacts

Everything a run produces is written to `pikabo-results/` (change with `--out`).

| File | What it is |
| --- | --- |
| `report.html` | One self-contained file. Screenshots inlined, per-step timeline, expandable console log, failure detail. |
| `results.json` | The full result tree, for CI gates and tooling. |
| `summary.md` | A short pass/fail table plus failure detail. |
| `videos/<test>.webm` | One composed testcase replay with context/step labels when `--video on` is enabled. |
| `dom/**/*.html` | Page HTML captured at each failed step. |
| `traces/*.zip` | Playwright trace retained on failure by default; open with `npx playwright show-trace <file>`. |

`report.html` is the one to attach to an issue — it opens anywhere with no server and no
sidecar files.

Video composition and optional `--gif` conversion require ffmpeg. Without it the raw Playwright
page recordings remain under `videos/raw/` and the result contains a warning.

## The output directory is cleared each run

**The directory is cleared at the start of every run**, so what you see always belongs to the run
that just finished — a renamed or deleted test never leaves a stale folder behind pretending to be
current. Pass `--no-clean` to keep the previous run's artefacts.

Only directories pikabo recognises are cleared: ones holding nothing but its own output
(`screenshots/`, `dom/`, `downloads/`, `videos/`, `traces/`, `results.json`, `report.html`,
`summary.md`) or carrying the `.pikabo-results` marker it writes.

A single unrecognised file protects the whole directory and produces a warning naming it, so
`--out .` cannot delete your project.

## Screenshot naming

Each test gets its own directory, so step numbering never collides between tests:

```
pikabo-results/screenshots/
  my-suite/
    popup-counts-clicks/       00-openPopup.png  02-click.png  06-after-save.png
    options-page-saves/        00-openOptions.png  01-select.png
```

The number is the **step index**, zero-padded so the files sort into execution order, and it is
the same index shown in the report and `results.json` — so a failure at step 7 is `07-*.png`.

Gaps are expected: under the default `--shots step-end` only steps that change what is on screen
are captured, so assertions and `eval` leave holes in the numbering. Use `--shots all` to capture
after every step and close the gaps.

## Controlling what is captured

| Flag | Effect |
| --- | --- |
| `--shots step-end` | Default. A screenshot after every interactive step. |
| `--shots all` | A screenshot after literally every step, assertions included. |
| `--shots failures` | Failures only. |
| `--shots none` | No screenshots at all. The report still has the step timeline and console. |
| `--trace on\|off\|retain-on-failure` | Trace retention. Defaults to retain-on-failure. |
| `--video on` | Record and compose per-testcase replays. Needs ffmpeg. |
| `--gif` | Also convert the composed video to GIF. Needs ffmpeg. |

Reports include the actual browser channel and version, which makes a browser-specific failure
diagnosable from the artefact alone.
