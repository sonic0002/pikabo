# pikabo documentation

Start with the [README](../README.md) for install and a first run. These pages hold the detail it
deliberately leaves out.

## Writing tests

- [Step reference](steps.md) — every step and its options. Generated from the schema.
- [Extension surfaces](surfaces.md) — what `in:` can address, the lifecycle and trigger steps,
  `eval`, and the extension event timeline.
- [Recording a test](recording.md) — the `record` command, how selectors are chosen, and why a
  recording is a first draft.
- [Testing exported files](testing-downloads.md) — downloads, `assertPdf` / `assertFile`, and the
  habits that keep tests against live sites from being flaky.

## Running and reading results

- [Reports and artefacts](reports.md) — what lands in `pikabo-results/`, how the directory is
  cleaned, screenshot numbering, and the capture flags.
- [Permission audit](permission-audit.md) — what it catches, and why it says *not observed*
  rather than *unused*.
- [Troubleshooting](troubleshooting.md) — colour codes, selector timeouts, worker errors, ffmpeg.

## Agents

- [Using pikabo from an AI agent](agents.md) — the bundled skill, its install targets, keeping
  copies current, and the MCP server.

## Contributing

- [CONTRIBUTING.md](../CONTRIBUTING.md) — test tiers, fixtures, adding a step, running from a
  local checkout.
- [SECURITY.md](../SECURITY.md) — worth reading before running pikabo anywhere sensitive.

## Design notes

Working documents rather than user documentation. Kept for the reasoning behind decisions already
shipped.

- [design.md](design.md) — the design, reconciled with the shipped code and annotated where the
  implementation diverged from the plan.
- [enhancement-plan.md](enhancement-plan.md) — prioritised work, with status.
- [ext-test-findings.md](ext-test-findings.md) — findings from writing a suite against a real
  extension, and how each was resolved.
