---
title: Configuration
description: Every workspace config field, its default, and what it does.
---

Configuration is workspace-scoped, persisted in `<workspace-root>/.flint.db` — a small embedded
database (via `redb`, a pure-Rust engine; not SQLite), one row per dotted key below. Before
M10.21 this lived at `<workspace>/.flint/config.json` as a single JSON file; the shape below is
still the accurate mental model of the full resolved config, it just isn't a literal file
anymore. Unknown keys are preserved; an invalid config falls back to defaults with a dismissible
notice, and never blocks startup.

```json
{
  "version": 1,
  "theme": "system",
  "editor": {
    "fontSize": 14,
    "fontFamily": "IBM Plex Mono",
    "softWrap": true,
    "tabSize": 2,
    "showLineNumbers": false,
    "vimMode": false
  },
  "markdown": {
    "math": true,
    "tables": true,
    "footnotes": true,
    "smartPunctuation": true
  },
  "behaviour": {
    "autosaveMs": 400,
    "rewriteLinksOnRename": true,
    "deleteToTrash": true,
    "newNoteFolder": "",
    "defaultMode": "edit"
  },
  "ui": {
    "leftSidebar": "tree",
    "rightSidebarVisible": true,
    "showNonNoteFiles": false
  },
  "mcp": {
    "enabled": false,
    "port": null,
    "requireAuth": false
  },
  "ignore": ["node_modules/**", ".obsidian/**"]
}
```

## Top level

| Field | Default | Effect |
| --- | --- | --- |
| `version` | `1` | Config schema version, used to migrate older files |
| `theme` | `"system"` | `"system"`, `"light"`, or `"dark"` — the app's color theme |
| `ignore` | `["node_modules/**", ".obsidian/**"]` | Glob patterns excluded from the index, search, and the file tree |

## `editor`

| Field | Default | Effect |
| --- | --- | --- |
| `fontSize` | `14` | Editor font size in pixels |
| `fontFamily` | `"IBM Plex Mono"` | Editor/code typeface |
| `softWrap` | `true` | Wrap long lines instead of scrolling horizontally |
| `tabSize` | `2` | Spaces per indent level |
| `showLineNumbers` | `false` | Show line numbers in the gutter |
| `vimMode` | `false` | Enable Vim keybindings in the editor |

## `markdown`

| Field | Default | Effect |
| --- | --- | --- |
| `math` | `true` | Render LaTeX math (inline and block) |
| `tables` | `true` | Render GitHub-flavoured Markdown tables |
| `footnotes` | `true` | Render footnote references and definitions |
| `smartPunctuation` | `true` | Convert straight quotes/dashes to typographic equivalents when rendering |

## `behaviour`

| Field | Default | Effect |
| --- | --- | --- |
| `autosaveMs` | `400` | Debounce, in milliseconds, before an edited note is saved automatically |
| `rewriteLinksOnRename` | `true` | Rewrite links across the workspace when a note is renamed or moved |
| `deleteToTrash` | `true` | Send deleted notes to the OS trash instead of deleting permanently |
| `newNoteFolder` | `""` | Default folder (relative to the workspace root) for notes created via the command palette |
| `defaultMode` | `"edit"` | `"edit"`, `"read"`, or `"split"` — the view mode a note opens in |

## `ui`

| Field | Default | Effect |
| --- | --- | --- |
| `leftSidebar` | `"tree"` | `"tree"` or `"search"` — which tab the left sidebar opens on |
| `rightSidebarVisible` | `true` | Whether the backlinks/outline sidebar starts open |
| `showNonNoteFiles` | `false` | Show non-Markdown files in the workspace tree |

## `mcp`

| Field | Default | Effect |
| --- | --- | --- |
| `enabled` | `false` | Start the local MCP server (M10.21) on next launch. Also settable per-launch with `--mcp`, which overrides this for that run only |
| `port` | `null` | Preferred port for the MCP server. `null` uses the default (`4870`); either way, an already-taken port falls back to an OS-assigned ephemeral one |
| `requireAuth` | `false` | Require a bearer token on every MCP request. Also settable per-launch with `--mcp-auth`. The token itself is never a config field — it's generated/rotated from Settings → MCP Server and persisted separately in `.flint.db` |

See [MCP Server — Claude Code](/flint/docs/mcp-server-claude/) or
[MCP Server — Antigravity](/flint/docs/mcp-server-antigravity/) for how to connect a coding agent
to it.

See the in-app Settings screen for a friendlier editor over the same fields — it writes to the
same `.flint.db`.
