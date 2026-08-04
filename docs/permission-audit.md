# Permission audit

Every run records which `chrome.*` namespaces the extension actually reaches and compares that
against `manifest.json`:

```
  1 permission(s) declared but never used: tabs
```

No flag turns it on; it is a by-product of instrumenting the extension for everything else.

## Two things this catches that nothing else can

**Declared but unused.** Unjustified permissions are a common cause of Chrome Web Store review
delays, and they are invisible to a linter — the manifest is valid either way. A permission added
during a spike outlives the feature.

**Used but not declared.** The reverse is a production bug: the namespace is simply `undefined` in
a real install, so the code throws for users and not for you.

## It is evidence, not a verdict

A permission used only on a path your tests never take is indistinguishable from a dead one. So
findings read *not observed* rather than *unused*, and a run that barely interacted with the
extension is labelled as such:

```
4 permission(s) not exercised (contextMenus, downloads, scripting, tabs)
  — few interactions, so this reflects coverage
```

That distinction is the whole point: a smoke suite that only opens the popup proves nothing about
permissions. Write tests that exercise real features first, then read the audit.

## Two limits worth knowing

**Content scripts are not counted.** They run in an isolated world that cannot be instrumented, so
API use inside them is invisible to the audit. An extension whose `tabs` use lives entirely in a
content script will report `tabs` as not observed.

**Permissions with no API surface are not observable.** `activeTab`, `unlimitedStorage`, and
`clipboardWrite` are reported as *not observable* and never suggested for removal, because their
absence from a run proves nothing.
