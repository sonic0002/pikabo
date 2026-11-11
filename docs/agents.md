# Using pikabo from an AI agent

Two ways, and they are not equivalent. Prefer the skill for everyday use: it costs nothing until
it is needed, whereas MCP tool schemas sit in the context window of every session. Reach for MCP
when an agent needs to explore an unfamiliar extension interactively.

## The skill

Most of what an agent needs is not the command list — it is the workflow and the handful of things
that are not obvious (scope console assertions on live sites, give capture steps a long timeout, a
bare `{` breaks YAML in an `eval`).

That is written once in [`skills/pikabo-testing-extensions/SKILL.md`](../skills/pikabo-testing-extensions/SKILL.md),
with a body that names no particular tool, and installed into whichever convention your agent
reads:

```bash
pikabo skill install --global         # every project, no per-repo setup
pikabo skill install --dir .          # this repo only; detects what it already uses
pikabo skill install --target claude,codex,cursor
pikabo skill print                    # write it somewhere yourself
```

### Global installs

`--global` installs into the agent's own configuration directory rather than a repository, so the
skill is available everywhere:

| Target | Global location |
| --- | --- |
| `claude` | `~/.claude/skills/pikabo-testing-extensions/SKILL.md` |
| `codex` / `agents` | `~/.codex/AGENTS.md` (instructions inlined, since there is no repo to point at) |
| `cursor` | `~/.cursor/rules/pikabo-testing-extensions.mdc` |

Global installs default to `claude`, the only agent with a well-established global skill
directory; name others explicitly with `--target`. Restart the agent afterwards so it rescans.

### Repository installs

| Target | Writes |
| --- | --- |
| `claude` | `.claude/skills/pikabo-testing-extensions/SKILL.md` |
| `codex` / `agents` | `docs/pikabo-testing-extensions.md`, plus a delimited pointer in `AGENTS.md` |
| `cursor` | `.cursor/rules/pikabo-testing-extensions.mdc` |

An existing `AGENTS.md` is never overwritten. If it has no pikabo block the command prints the
section for you to paste, and only appends with `--force`; on later runs it replaces its own block
between the markers rather than adding another copy.

Install into a repository when the skill should be committed so teammates and CI get it too.

### Keeping installs current

An install is a **copy**, not a link — it cannot break when this package is upgraded or moved, but
it also cannot follow along. When the bundled instructions change, existing copies keep the old
text until they are reinstalled.

```bash
pikabo skill check --global        # is the global copy current?
pikabo skill check --dir .         # and this repo's?
```

```
  ✓ claude  up to date     ~/.claude/skills/pikabo-testing-extensions/SKILL.md
  ✗ codex   out of date    docs/pikabo-testing-extensions.md
  – cursor  not installed  .cursor/rules/pikabo-testing-extensions.mdc
```

`check` exits non-zero when anything is out of date, so it can gate CI. Re-running `skill install`
refreshes in place and reports `installed`, `updated` or `unchanged`.

Before the next release the skill was called `testing-extensions`. `check` reports a copy under
that name as out of date, and `install` writes the new one and removes the old copy, so an agent
does not load the instructions twice. Only files pikabo wrote are removed.

The simplest way to avoid drift is to install globally and skip per-repository copies entirely —
one copy, one command to refresh.

## The MCP server

`pikabo mcp` serves the same primitives over MCP (stdio), so an agent can launch the browser,
click through the extension, read the merged console, and then freeze what worked into a YAML
suite.

```json
{
  "mcpServers": {
    "pikabo": {
      "command": "npx",
      "args": ["pikabo", "mcp", "--ext", "/path/to/extension"]
    }
  }
}
```

Tools: `ext_launch`, `ext_step`, `ext_screenshot`, `ext_console`, `ext_generate_suite`,
`ext_run_suite`, `ext_close`.

`ext_step` takes any step name from the DSL, so nothing discovered interactively has to be
translated to be written down — the exploration and the committed suite speak the same vocabulary.
