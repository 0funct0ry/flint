---
title: Concepts
description: The five vocabulary terms used everywhere in Flint.
---

These five terms are stable across the CLI, the app, and this documentation — Flint never uses a
synonym for them.

| Term | Meaning |
| --- | --- |
| **Workspace** | A directory opened by Flint. |
| **Note** | A single Markdown file inside the workspace, identified by its workspace-relative path. |
| **Folder** | A directory inside the workspace. |
| **Link** | A Markdown inline link from one note to another note in the same workspace. |
| **Backlink** | A link pointing *at* the currently open note. |

## Secondary terms

- **Index** — the in-memory map of notes, titles, and links, rebuilt on startup and never
  persisted to disk.
- **Watcher** — the filesystem change listener that keeps the index (and the window) in sync with
  edits made outside Flint.
- **Pane** — an editor surface in the window (for example, the edit pane and the read pane).

## Why this matters

Flint owns no data. A workspace is just a directory; a note is just a file in it. Nothing about
these terms implies a database, an account, or a proprietary format — see the
[FAQ](/flint/docs/faq/) for what that guarantees in practice.
