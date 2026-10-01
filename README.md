# Flint

Flint is a desktop app for writing and connecting Markdown notes. Point it at any folder on your computer. Every `.md` file becomes a note you can edit, read, link, and search. It is for people who want a fast note workspace without giving up their files.

[![CI](https://github.com/0funct0ry/flint/actions/workflows/ci.yml/badge.svg)](https://github.com/0funct0ry/flint/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/0funct0ry/flint?include_prereleases)](https://github.com/0funct0ry/flint/releases)
[![License](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
![Rust](https://img.shields.io/badge/rust-2021-orange)
![Tauri](https://img.shields.io/badge/tauri-2.x-24C8DB)

**Documentation:** [0funct0ry.github.io/flint](https://0funct0ry.github.io/flint/)

## Key Features

- **Your files stay yours.** Notes are plain Markdown. Edit them with `vim`, `git`, or Finder at any time.
- **Edit, read, or split.** Write with a CodeMirror editor. Preview in the reader beside it.
- **Links and backlinks.** Jump between notes. See which notes point at the one you have open.
- **Fast search.** Find notes by name or search the text of every note.
- **Safe saving.** Writes are atomic. Flint warns you if a file changed on disk while you edited.
- **Rename without breaking links.** Flint updates links in other notes and reports how many.
- **Wikilinks, tags, embeds, Mermaid diagrams.** Use them as you write.
- **Templates and daily notes.** Create notes from reusable templates.
- **Tabs and split panes.** Work on several notes at once.
- **A real command line.** Search, list, and check a workspace without opening a window.
- **Local only.** Flint never makes outbound network requests. A test enforces this.
- **Optional agent access.** An opt-in local MCP server lets coding agents read your notes.
- **Light and dark themes.** Everything works with the keyboard.

## Install

Pick the route that fits. Full details are in the [install guide](https://0funct0ry.github.io/flint/docs/install/).

```bash
# macOS and Linux
curl -fsSL https://0funct0ry.github.io/flint/install.sh | sh
```

You can also download a `.dmg`, `.AppImage`, `.deb`, or `.msi` from the [releases page](https://github.com/0funct0ry/flint/releases). Every route ends with a `flint` command on your `PATH`.

## Prerequisites (building from source)

| Tool | Version |
| --- | --- |
| [Rust](https://rustup.rs/) | stable, 2021 edition |
| [Node.js](https://nodejs.org/) | 20 or later |
| [pnpm](https://pnpm.io/) | 11 |
| Linux only | `libwebkit2gtk-4.1-dev`, `libgtk-3-dev`, `librsvg2-dev`, `patchelf` |

## Getting Started

1. Clone the repository.

   ```bash
   git clone https://github.com/0funct0ry/flint.git
   cd flint
   ```

2. Install frontend dependencies.

   ```bash
   pnpm install
   pnpm approve-builds --all
   ```

3. Configure settings. Flint needs no environment variables. It keeps per-workspace settings in `.flint.db` inside the workspace.

4. Run the app in development mode.

   ```bash
   cargo tauri dev
   ```

## Usage

Open a folder as a workspace:

```bash
flint ~/notes
flint .
```

Work from the terminal without opening a window:

```bash
flint init ~/notes            # create settings and a starter note
flint new ideas/launch.md     # create a note
flint search "retro"          # print matches as path:line:match
flint list --folder ideas     # list note paths
flint doctor                  # report broken links and orphan notes
flint info --json             # workspace details as JSON
```

| Flag | Effect |
| --- | --- |
| `--workspace <PATH>` | Choose the workspace explicitly |
| `--no-open` | Skip the GUI |
| `--json` | Print machine-readable output |
| `--foreground` | Keep the GUI attached to the terminal |
| `--mcp` / `--mcp-auth` | Start the local MCP server, optionally with a bearer token |

Exit codes: `0` success, `1` failure, `2` bad usage, `3` workspace not found, `4` permission denied, `5` note not found.

Common shortcuts: `⌘N` new note, `⌘P` find a note, `⌘⇧P` command list, `⌘⇧F` search all notes, `⌘E` switch edit/read/split.

### Project layout

```text
flint/
├── crates/
│   ├── flint-core/   # index, link parsing, search, path guard (no Tauri)
│   ├── flint-cli/    # clap CLI and Tauri host; builds the single `flint` binary
│   └── flint-app/    # Tauri commands, events, watcher, MCP server
├── src/              # React + TypeScript + Tailwind + CodeMirror frontend
├── docs/             # Astro Starlight documentation site
├── packaging/        # Homebrew cask
└── install.sh        # macOS/Linux installer
```

## Testing and Quality

```bash
cargo fmt --check
cargo clippy --workspace --locked -- -D warnings
cargo test --workspace --locked   # includes the no-network-crate guard
cargo deny check

pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

CI runs all of these on every push and pull request.

## Deployment

Pushing a `v*` tag runs the release workflow. It builds a universal `.dmg`, an `.AppImage` and `.deb`, and an `.msi`. It publishes them with a `SHA256SUMS` file to a GitHub Release. Builds ship without an updater, because Flint never checks the network.

Build a macOS app bundle locally:

```bash
cargo tauri build --bundles app
```

The bundle lands in `target/release/bundle/macos/Flint.app`. Use the bundle, not `cargo run`, to test Finder launch and the Dock icon.

## Contributing

Open an issue before large changes. Then:

1. Fork the repository and create a branch.
2. Keep to the checks in [Testing and Quality](#testing-and-quality).
3. Open a pull request that describes what changed and why.

Flint's data-safety rules are fixed. Never delete a note without being asked. Never overwrite unsaved work silently. Never add outbound network calls.

## License

Flint is released under the [MIT License](LICENSE).
