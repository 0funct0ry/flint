# Flint

Flint is a local-first Markdown knowledge workspace: a Tauri 2.x desktop app, launched from a CLI, that opens a directory on disk and treats every `.md`/`.markdown` file in it as a note, with an editor, reader, link navigation, search, and backlinks.

Flint owns no data — every note stays a plain, portable Markdown file that remains readable, editable, and movable with any other tool (`vim`, Finder, `git`, `rsync`, Obsidian). It makes no network requests, ever.

**Governing principle:** the filesystem is the workspace, Markdown files are the knowledge base, Flint is the interface for working with them.

---

## Repository Structure

```
flint/
├── Cargo.toml                  # Workspace definition
├── crates/
│   ├── flint-core/             # Pure domain logic: index, link parsing, search, path guard
│   ├── flint-cli/              # clap CLI + Tauri host, produces the single `flint` binary
│   └── flint-app/              # lib-only: Tauri commands, events, watcher wiring
├── src/                        # React 18 + TypeScript + Tailwind + CodeMirror 6 frontend
├── src-tauri/ -> crates/flint-cli
├── bin/flint                   # macOS PATH shim — routes `flint` through LaunchServices
└── internal-docs/              # Specification & milestone build prompts
```

---

## Quick Start & Development

### Prerequisites
- [Rust](https://rustup.rs/) (edition 2021+)
- [Node.js](https://nodejs.org/) (v20+)
- [pnpm](https://pnpm.io/)

### Installation & Run

1. **Install frontend dependencies:**
   ```bash
   pnpm install
   pnpm approve-builds --all
   ```

2. **Run frontend dev server:**
   ```bash
   pnpm dev
   ```

3. **Run Tauri application (dev mode):**
   ```bash
   cargo tauri dev
   ```

4. **CLI invocation:**
   ```bash
   cargo run -p flint-cli -- --help
   ```

---

## Building the App Bundle (macOS)

To produce a fully launchable `Flint.app` (required for Finder double-click, Dock icon, and menu-bar registration — M10.04):

```bash
cargo tauri build --bundles app
```

The bundle is written to `target/release/bundle/macos/Flint.app`.

> **Note:** `cargo run -p flint-cli` and `cargo tauri dev` produce a raw binary only.
> The `.app` bundle is required for proper macOS GUI activation via LaunchServices.

### macOS PATH Shim (`bin/flint`)

The file [`bin/flint`](./bin/flint) is a thin shell script that must be installed to `PATH` (e.g. `/usr/local/bin/flint`).  It routes terminal invocations through `open -a Flint.app --args "$@"` so the GUI process is always registered with LaunchServices:

```bash
# Install (after building Flint.app and copying to /Applications):
sudo install -m 0755 bin/flint /usr/local/bin/flint
```

The shim searches `/Applications/Flint.app`, `~/Applications/Flint.app`, and a recorded install path before falling back to the dev binary with a warning.

---

## Verification & Testing

- **Rust Checks:**
  ```bash
  cargo fmt --check
  cargo clippy --workspace -- -D warnings
  cargo test --workspace
  ```

- **Frontend Checks:**
  ```bash
  pnpm lint
  pnpm test
  pnpm typecheck
  pnpm build
  ```

