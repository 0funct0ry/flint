---
title: Install
description: Every way to install Flint, and how the flint command gets onto your PATH.
---

Every route below ends with a `flint` command on your `PATH`. Check with `flint --version`.

## Install script (macOS and Linux)

```
$ curl -fsSL https://0funct0ry.github.io/flint/install.sh | sh
```

It detects your platform, downloads the matching asset from the GitHub Release, **verifies its
SHA-256 checksum**, and installs it. On an unsupported platform it stops with an error instead of
doing nothing. Options: `--dry-run` (show what would happen), `--version X.Y.Z`, `--prefix DIR`.

## Installers

Download from the [latest release](https://github.com/0funct0ry/flint/releases/latest).

| Platform | Asset | `flint` on PATH |
| --- | --- | --- |
| macOS (universal) | `.dmg` | On first launch Flint asks before adding `/usr/local/bin/flint`; it never does so silently. |
| Debian/Ubuntu | `.deb` | Installed at `/usr/bin/flint`. |
| Other Linux | `.AppImage` | AppImages don't install themselves: put it on your `PATH` as `flint` (`chmod +x`, then move to `~/.local/bin/flint`), or use `--appimage-extract`. |
| Windows x86_64 | `.msi` | The installer adds its directory to `PATH`; open a new terminal. |

## Homebrew (macOS)

```
$ brew install --cask 0funct0ry/flint/flint
```

## From source

```
$ cargo install --git https://github.com/0funct0ry/flint flint-cli
```

Needs a recent stable Rust, Node.js 20+ and pnpm (the frontend is built first: `pnpm install &&
pnpm build`).

## Updates

Flint makes no network requests, so it never checks for updates. Update through Homebrew or your
package manager, re-run the install script, or download a new release.
