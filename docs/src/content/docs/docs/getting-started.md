---
title: Getting Started
description: Install Flint and open your first workspace.
---

Flint is a single binary that serves as both the desktop application and the `flint` command.
Installing it once gives you both.

## Install

See the [Install guide](/flint/docs/install/) for the install script, installers, Homebrew, and
building from source.

Confirm the install:

```
$ flint --version
flint 0.1.0
```

## `flint init`

Use `flint init` when you want a workspace's settings created without opening a window — useful in
a setup script:

```
$ flint init ~/notes
created ~/notes/.flint.db
created ~/notes/index.md
```

## `flint <path>`

Run `flint` with a path to open a window with that directory as the workspace:

```
$ flint ~/notes
opening ~/notes · 412 notes · 1 203 links
```

Passing `.` opens the directory you are currently in, which is the usual way to work:

```
$ cd ~/notes
$ flint .
```

If the path does not exist yet, Flint asks before creating it (pass `--yes` to skip the prompt in
a script), then opens with one starter note and the file tree focused.

## Opening your first workspace

The first time a directory is opened, Flint adds one file inside it:

```
~/notes/
├── .flint.db             Flint's settings for this workspace (an embedded database, not a note)
└── index.md
```

Nothing else is added, moved, or rewritten. Delete `.flint.db` and you lose only Flint's settings
for that workspace — the rest of your files are untouched.

From here, see [Concepts](/flint/docs/concepts/) for the vocabulary Flint uses everywhere, or the
[CLI Reference](/flint/docs/cli-reference/) for every subcommand and flag.
