---
title: CLI Reference
description: Every flint subcommand, flag, and exit code.
---

Flint is one binary. Run it on a path to open the window; run a subcommand to get an answer
without opening anything.

## Subcommands

| Command | Description |
| --- | --- |
| `flint [PATH]` | Open `PATH` as a workspace (default: `.`) |
| `flint init [PATH]` | Create `.flint.db` and a starter note, do not open the GUI |
| `flint new <NOTE> [--open]` | Create a note (relative to the workspace), optionally open it |
| `flint search <QUERY>` | Print matching notes to stdout (`path:line:match`), no GUI |
| `flint list [--folder DIR]` | Print note paths, one per line |
| `flint doctor` | Report workspace health: broken links, orphans, unreadable files |
| `flint info` | Print workspace path, note count, link count, config location |
| `flint --version` / `-V` | Print the installed version |
| `flint --help` / `-h` | Print usage |

## Global flags

| Flag | Effect |
| --- | --- |
| `--workspace <PATH>` | Set the workspace explicitly, independent of the positional `PATH` |
| `--no-open` | Do not open the GUI window |
| `--json` | Emit machine-readable JSON instead of human-readable text |
| `--log <level>` | Set log verbosity (`error`, `warn`, `info`, `debug`, `trace`) |
| `--foreground` | Block the terminal / run the GUI in-process instead of detaching |
| `--mcp` | Start the local MCP server for this launch (see [MCP Server — Claude Code](/flint/docs/mcp-server-claude/) / [Antigravity](/flint/docs/mcp-server-antigravity/)), overriding `mcp.enabled` |
| `--mcp-auth` | Require a bearer token on every MCP request for this launch, overriding `mcp.requireAuth`. Off by default — see [MCP Server — Claude Code](/flint/docs/mcp-server-claude/) / [Antigravity](/flint/docs/mcp-server-antigravity/) |

## How Flint decides which directory to open

Flint checks these in order and uses the first one it finds:

| Order | Source | Example |
| --- | --- | --- |
| 1 | The path you pass on the command line | `flint ~/notes` |
| 2 | The `--workspace` flag | `flint --workspace ~/notes --no-open` |
| 3 | The `FLINT_WORKSPACE` environment variable | `export FLINT_WORKSPACE=~/notes` |
| 4 | The current directory | `flint` |

The resolved path is canonicalized. If it does not exist, Flint asks before creating it, unless
`--yes` is passed to skip the prompt in a script. If a directory exists but has no `.flint.db`,
Flint initializes it silently on open.

## Exit codes

| Code | Meaning |
| --- | --- |
| `0` | Success |
| `1` | Generic failure |
| `2` | Bad usage |
| `3` | Workspace not found / not a directory |
| `4` | Permission denied |
| `5` | Note not found |

## Example output

```
$ flint .
opening ~/notes · 412 notes · 1 203 links

$ flint search "deemed acceptance"
projects/payments/settlement.md:38: Document deemed acceptance at `T+3`
projects/payments/rails.md:71:      deemed acceptance applies per NPCI

$ flint new projects/payments/recon-2026.md --open

$ flint doctor
1 unresolved link  projects/payments/settlement.md:31 → ./recon-2026.md
3 orphan notes     reading/glossary.md, archive/2019.md, inbox.md

$ flint info
workspace: /Users/you/notes
notes: 412
links: 1203
config: /Users/you/notes/.flint.db
```
