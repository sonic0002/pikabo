# Extension surfaces

An extension is not one page. `in:` chooses which part of it a step acts on, and being able to
address them by name is most of the point of the tool.

| `in:` | What it is |
| --- | --- |
| `page` | the web page under test, where content scripts run |
| `popup` | the extension popup, as a real document |
| `options` | the options page |
| `worker` | the MV3 service worker — `chrome.storage`, `chrome.runtime`, alarms, messaging |
| `sidepanel` | the manifest-declared side-panel document |
| `devtools` | the DevTools extension page for document/console smoke tests |
| `background` | an MV2 persistent background page, when the browser still supports MV2 |
| `offscreen` | an MV3 offscreen document; `eval` only because it has no visible page |

## Opening them

The lifecycle steps `openSidePanel`, `openDevtoolsPage`, `openBackground`,
`createOffscreenDocument`, and `closeOffscreenDocument` expose those surfaces.

`triggerAction`, `triggerCommand`, and `triggerContextMenu` invoke the extension's registered
Chrome event listeners deterministically; `openContextMenu` separately opens the native menu for
visual smoke testing.

`openPopup` and `openOptions` also make that context active, so following steps do not need `in:`.

## What these are, and what they are not

These are functional-test handles, not browser-UI pixel emulation. `sidepanel` and `devtools`
open the extension documents as pages so their DOM, scripts, APIs, and console can be tested.
They do not reproduce the surrounding Chrome side-panel or DevTools shell.

Likewise `openContextMenu` checks the native menu-opening gesture, while `triggerContextMenu`
tests the extension listener and payload without trying to click Chrome's operating-system menu
UI.

The distinction matters when a test fails: a `sidepanel` assertion tells you the document is
broken, not that Chrome's panel chrome failed to render.

## The escape hatch

Anything the DSL does not cover, `eval` does:

```yaml
- eval:
    script: |
      const tabs = await chrome.tabs.query({ active: true });
      return tabs.length;
    in: worker
- expect:
    equals: 1
```

Expressions and IIFEs yield their value; statement bodies must use a top-level return.

## The extension event timeline

Chrome behavior that has no DOM representation is available as an ordered event timeline. Tests
can wait on the effect itself instead of sleeping or inspecting implementation state:

```yaml
- openPopup
- click: "#save"
- waitForExtensionEvent:
    type: runtime.message
    contains:
      message:
        type: save
- assertExtensionEvent:
    type: storage.changed
    contains:
      areaName: local
```

Observed events include runtime messages and ports, storage changes, tab activity, downloads,
alarms, permissions, commands, context menus, notifications, content-script execution, and
service-worker cold-start / stop / restart boundaries reported by Chrome.

`waitForExtensionEvent` blocks until a matching event arrives or the step times out;
`assertExtensionEvent` checks events already recorded and fails immediately if none match. Use
the first for something you expect to happen next, the second for something that should already
have happened.

---

Every step and its options: [steps.md](steps.md).
