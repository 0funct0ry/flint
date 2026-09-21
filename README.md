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
│   ├── flint-cli/              # clap CLI, produces the `flint` binary
│   └── flint-app/              # Tauri host: commands, events, watcher wiring
├── src/                        # React 18 + TypeScript + Tailwind + CodeMirror 6 frontend
├── src-tauri/ -> crates/flint-app
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

3. **Run Tauri application:**
   ```bash
   cargo tauri dev
   ```

4. **CLI invocation:**
   ```bash
   cargo run -p flint-cli -- --help
   ```

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
