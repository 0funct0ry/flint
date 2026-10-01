# Changelog

All notable changes to Flint are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.1.0]

First release. Flint is a local-first Markdown knowledge workspace; every note stays a plain
Markdown file, and Flint makes no network requests.

### Added
- **M1** The whole interface (light/dark themes, command registry, keymap), built against fixtures.
- **M2** Open a real workspace: `flint [PATH]` CLI, the path guard, a live file tree.
- **M3** Open and edit a real note with atomic writes and conflict detection.
- **M4** Create, rename, move, and delete notes and folders (deletes go to the OS trash).
- **M5** Rendered reader and split view.
- **M6** Links and navigation.
- **M7** The in-memory index and the backlinks panel.
- **M8** Filesystem watching and link rewriting on rename.
- **M9** Name and content search, plus `flint search`, `list`, and `doctor`.
- **M10.01–M10.04** A single `flint` binary, detached GUI launch, Finder launch, workspace memory.
- **M10.05–M10.10** Editor context menu, status bar, Markdown table builder, outline panel,
  frontmatter panel, opening a single note file directly.
- **M10.1** Settings screen.
- **M10.2** Documentation site (Astro Starlight) with a marketing landing page.
- **M10.21** Opt-in local MCP server for coding agents (loopback only, optional bearer token).
- **M10.23–M10.25** Wikilinks, Mermaid diagrams and note embeds, tags and tag navigation.
- **M10.26–M10.29** Templates, new-note rules, daily notes, template generators, Tera template engine.
- **M10.28** Tabs and split panes.
- **M10.3** Release pipeline: CI release job (`.dmg`, `.AppImage`, `.deb`, `.msi`), `install.sh`
  with checksum verification, Homebrew cask, first-run consent to install `/usr/local/bin/flint` on
  macOS, `cargo deny` and a workspace-wide no-network-crate test.

### Notes
- No updater artifacts are shipped, by design: Flint never phones home.

[Unreleased]: https://github.com/0funct0ry/flint/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/0funct0ry/flint/releases/tag/v0.1.0
