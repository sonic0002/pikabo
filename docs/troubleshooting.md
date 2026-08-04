# Troubleshooting

Start with `pikabo doctor --ext .`. It confirms Node, the Chromium binary, ffmpeg, and that your
`manifest.json` parses — before anything tries to launch a browser.

## Output shows `[1m` and `[2m` instead of colours

Those are ANSI styling codes — `1m` bold, `2m` dim, `32m` green, `0m` reset — that a terminal is
supposed to consume rather than print. Seeing them literally means whatever is displaying the
output does not interpret them. Turn styling off with any of:

```bash
pikabo run tests --ext . --no-color
NO_COLOR=1 pikabo run tests --ext .
```

Colour is disabled automatically when output is piped or redirected, and when `TERM` is `dumb`
or unset. `FORCE_COLOR=1` turns it on regardless; `--no-color` and `NO_COLOR` beat it.

## A selector times out and the extension looks fine

When a selector matches nothing, the failure reports what *is* on the page:

```
Expected "#save-pdf" to be visible in popup, but it was not within 15000ms.
Elements present: #save, #cancel, #status.
```

If the listed elements are the ones you expected, the surface rendered and the selector is stale.
If the list is empty or unfamiliar, the step is acting on the wrong context — check `in:`.

## The service worker reports errors you never see in DevTools

That is the intended behaviour, not a false positive. The console of an MV3 service worker is
invisible unless you have its inspector open at the moment it starts. pikabo attaches over the
DevTools protocol before assertions run and picks up the buffered output, so a background script
that throws on its first line is reported with the file and line.

## A live site's console errors fail my test

Scope the assertion to your own surfaces:

```yaml
- assertNoConsoleErrors:
    contexts: [popup, worker]     # not the page
```

More real-site habits: [testing-downloads.md](testing-downloads.md#testing-against-a-real-website).

## An install or welcome tab interferes

Use `closeOtherTabs` inside a test, or close install tabs in `before` — see
[testing-downloads.md](testing-downloads.md#testing-against-a-real-website).

## Video or GIF output is missing

Composition and `--gif` conversion require ffmpeg. Without it the raw Playwright recordings remain
under `videos/raw/` and the result contains a warning. `pikabo doctor` reports whether ffmpeg was
found.

## Something else

Include the output of `pikabo doctor --ext .`, your `manifest.json` version (MV2/MV3), and the
suite that reproduces it. `pikabo-results/results.json` from a failing run is usually enough to
diagnose the rest.
