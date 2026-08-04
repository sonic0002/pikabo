# Testing exported files

Extensions that export something — a PDF, an image, a Markdown file — are the awkward case,
because "did it work" means looking at the artefact, not the DOM. Two things make that work.

## Downloads are captured wherever they come from

Most extensions save from their service worker with `chrome.downloads.download()`, which involves
no page at all and is invisible to page-level automation.

Every download first gets a collision-free browser filename, is mapped back to the
extension-requested name by Chrome download ID, and is recorded in `<out>/downloads/`, under the
filename the extension asked for.

That mapping is why repeated exports of the same name stay distinguishable instead of collapsing
into one file.

## `assertPdf` reads the file

Page count, page geometry, byte size, producer, and text where the document has any:

```yaml
- name: normal PDF export of pixelstech.net produces a full-page document
  steps:
    - navigate: https://www.pixelstech.net
    - openPopup
    - click: "#pdfBtn"
    - waitForDownload:
        pattern: "PixelsTech*.pdf"
        timeout: 90000
    - assertPdf:
        pattern: "PixelsTech*.pdf"
        pages: 1
        width: 595.28        # A4 width in points; 72pt = 1 inch
        minHeight: 1000      # a short page means only the viewport was captured
        minBytes: 50000      # a blank capture collapses to a few KB
        producer: /jsPDF/
```

The step reports what it found, so a passing run still tells you something:

```
✓ assertPdf — PixelsTech_…_2026-08-01T06-18-27.pdf: 1 page(s),
  A4 width × 809.3mm tall, 576KB, jsPDF 2.5.1, rasterised
```

`rasterised` is the useful word there. Extensions that capture a page usually draw it as an
image, so the PDF has no text in it at all — `containsText` will never match, and says so rather
than just failing. Assert on geometry and size instead.

`assertFile` covers the simpler cases (`minBytes`, `contains`) for text formats like Markdown.

## Testing against a real website

Three habits keep these tests from being flaky.

**Scope console assertions to your own surfaces.** A live site logs its own errors, which have
nothing to do with your extension and change without warning:

```yaml
- assertNoConsoleErrors:
    contexts: [popup, worker]     # not the page
```

**Give generation steps their own timeout.** Rasterising a long page takes tens of seconds, well
past the default:

```yaml
- waitForDownload:
    pattern: "*.pdf"
    timeout: 90000
```

**Handle welcome tabs opened on install.** `navigate` brings the page under test to the
foreground, so active-tab APIs such as `captureVisibleTab` and `tabs.query({ active: true })`
target it. The welcome tab remains open and its console is still captured. If it is noisy or the
test must start with exactly one tab, close install tabs in `before`:

```yaml
before:
  - eval:
      in: worker
      script: |
        const tabs = await chrome.tabs.query({});
        const keep = tabs.filter((tab) => (tab.url || '').startsWith('chrome-extension://'));
        const close = tabs.filter((tab) => !keep.includes(tab) && tab.url !== 'about:blank');
        await Promise.all(close.map((tab) => chrome.tabs.remove(tab.id).catch(() => {})));
        return close.length;
```

Use a URL rule specific to the extension when the page under test has already been opened.

A complete worked example against a real extension is in
[`examples/pagesaver-pdf.yaml`](../examples/pagesaver-pdf.yaml).
