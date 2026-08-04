# Recording a test

Writing the first suite by hand is the slowest part. `record` opens a real browser, watches what
you do, and writes it out:

```bash
pikabo record --ext . --url https://example.com --out tests/save-flow.yaml
```

Click through the extension, close the browser, and you get a suite that runs:

```yaml
name: PageSaver recorded
tests:
  - name: saves settings and counts a click
    steps:
      - openPopup
      - click:
          selector: "#bump"
          description: click Count a click
      - openOptions
      - fill:
          selector: "#label"
          value: Weekly report
      - click:
          selector: "#save-options"
          description: click Save
      - screenshot: final-state
      - assertNoConsoleErrors:
          contexts: [popup, options, worker]
```

Typing is collapsed into one `fill` with the final value rather than one step per keystroke, and
switching surfaces emits `openPopup` / `openOptions` instead of leaving it implied.

## How selectors are chosen

Selectors prefer whatever you named deliberately — `id`, `data-testid`, `name`, `aria-label`, then
button text — and fall back to a structural path only when there is nothing better.

Ids that look generated (long, hex-ish, framework `:r1:` style) are skipped, because a recording
built on those stops working on the next build. If a recording comes out full of structural paths,
that is a signal the surface needs test hooks more than it needs a different recorder.

## A recording captures what you did, not what should be true

It ends with a screenshot and a console check. The assertions that matter — `assertText`,
`assertStorage`, `assertPdf` — are yours to add. Treat the output as a first draft.

## Why the popup opens as a tab

The popup opens as a tab rather than through the toolbar icon. A toolbar popup is browser chrome
that automation cannot click, and a suite replays it as a tab anyway, so recording it any other
way would capture selectors against a surface the run never reproduces.
