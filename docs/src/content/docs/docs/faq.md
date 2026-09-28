---
title: FAQ
description: The no-network guarantee, where files are stored, and how conflicts are handled.
---

### Does Flint ever make a network request?

No. Flint makes no network requests, ever — there is no telemetry, no account, no update check,
and no sync service. This is enforced by an automated test that asserts no network crate is
present in the Rust dependency tree, so it can't regress silently. Installing new versions happens
through your package manager or by downloading a new release; Flint never checks for one itself.

### Where are my files stored?

Exactly where you put them. A workspace is a directory you chose, and every note is a plain
`.md`/`.markdown` file inside it, at the workspace-relative path you gave it. Flint's own state is
limited to `<workspace-root>/.flint.db` — a small embedded database (via `redb`, a pure-Rust
engine; not SQLite) holding Flint's own per-workspace settings and, if you've turned on the local
MCP server's optional authentication, its access token — and a small OS config directory for
app-wide defaults. The in-memory index of notes, titles, and links is rebuilt on every startup and
is never persisted to a database either — nothing in `.flint.db` is a copy of your notes'
content, and nothing else touches your files without you asking.

### What happens if a note changes on disk while I have it open?

Flint never silently overwrites a note whose on-disk content changed under an unsaved buffer. If
that happens, a conflict banner appears with three choices: **keep your version**, **load the
version on disk**, or **show differences** — never a silent loss either way.

Writes themselves are atomic: Flint writes to a temporary file in the same directory, `fsync`s it,
then renames it into place, so a crash or power loss mid-save can't corrupt a note.

### Does Flint ever delete a note without me asking?

No — deletes always go to the OS trash by default, never a permanent delete, unless you configure
otherwise. See [`behaviour.deleteToTrash`](/flint/docs/configuration/) in Configuration.

### Does renaming a note ever touch other files without asking?

Renaming or moving a note is the one case where Flint writes to files you didn't open directly: it
rewrites links across the workspace that pointed at the old path, and it always reports what it
changed (a toast with a count of notes/links updated). This behavior is togglable in Settings — see
[`behaviour.rewriteLinksOnRename`](/flint/docs/configuration/).
