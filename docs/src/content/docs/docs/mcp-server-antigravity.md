---
title: MCP Server — Antigravity
description: Give Antigravity read/write access to a workspace over Flint's local MCP server.
---

Flint can run a local [MCP](https://modelcontextprotocol.io) (Model Context Protocol) server
alongside the GUI, so an external coding-agent client can read and write the open workspace
through the exact same path guard, atomic writes, and fingerprint conflict detection the app's
own editor uses. It is off by default — this is new surface area, not the "no network requests"
outbound invariant, which only ever governed requests Flint itself initiates.

This page covers connecting **Antigravity**. See [MCP Server — Claude Code](/flint/docs/mcp-server-claude/)
for Claude Code.

> Antigravity's exact MCP configuration surface (field names, whether it's a settings UI or a
> config file) may differ from what's shown here — check Antigravity's current MCP
> documentation/settings screen for where to paste a `url` and, if needed, a custom
> `Authorization` header. The steps below describe the general HTTP-transport ("Streamable
> HTTP") shape every MCP client needs, which is what Flint's server speaks.

## Turning it on

Either:

- Pass `--mcp` on the command line for one launch: `flint --mcp ~/notes`
- Or set `"mcp": { "enabled": true }` in your workspace config (or toggle it in Settings → MCP
  Server) so it starts automatically every time that workspace opens

The server binds `127.0.0.1` only — never `0.0.0.0`, never a configurable address — on port
`4870` by default (falling back to an OS-assigned port if that's taken; either way, the chosen
URL is printed to the log and shown in the status bar).

## Authenticating (optional, off by default)

Loopback-only binding still lets any other local process or user on a shared machine connect. By
default the server does **not** require a token at all — anyone who can reach `127.0.0.1` on the
chosen port can call every tool. If that's not an acceptable trade-off for your machine (a shared
dev box, for instance), turn on bearer-token enforcement:

- Pass `--mcp-auth` alongside `--mcp` for one launch: `flint --mcp --mcp-auth ~/notes`
- Or set `"mcp": { "requireAuth": true }` in your workspace config (or toggle "Require bearer
  token" in Settings → MCP Server)

With auth on, there's no token yet until you create one — every request gets rejected (`401`)
until you do. Open Settings → MCP Server and click **Generate token**; the token is shown right
there (with a copy button) and persisted in `.flint.db` so it survives restarts. Click **Rotate
token** at any time to kick out whoever has the old one — the previous token stops working
immediately, no restart needed. There is no CLI command for this; token generation and rotation
are Settings-only, since that's the only place a live token value can be shown to you at all.

Pick the matching section below depending on whether you've turned auth on.

## Adding Flint's MCP server to Antigravity — without a token (auth off)

This is the default. Use it when you launched Flint with plain `--mcp` (no `--mcp-auth`) or with
`mcp.requireAuth` left at its default `false`.

In Antigravity's MCP server settings, add an HTTP-transport server entry pointing at the URL
Flint printed at startup (or shown in the status bar), with no headers/auth configured:

```json
{
  "mcpServers": {
    "flint": {
      "type": "http",
      "url": "http://127.0.0.1:4870/mcp"
    }
  }
}
```

(the exact place to paste this — a raw config file vs. a settings form — depends on your
Antigravity version). No `Authorization` header at all — the server isn't checking for one.

Confirm the connection in Antigravity's MCP status view, then verify the `flint` tools
(`note_read`, `note_patch_section`, `note_insert_link`, ...) are available in a session.

## Adding Flint's MCP server to Antigravity — with a token (auth on)

Use this when you launched Flint with `--mcp --mcp-auth` (or `mcp.requireAuth: true`) **and**
generated a token from Settings → MCP Server (see "Authenticating" above — a fresh `--mcp-auth`
launch rejects every request until you do this).

Copy the token shown in Settings, then add the same URL plus a custom
`Authorization: Bearer <token>` header in Antigravity's MCP server settings:

```json
{
  "mcpServers": {
    "flint": {
      "type": "http",
      "url": "http://127.0.0.1:4870/mcp",
      "headers": {
        "Authorization": "Bearer <token-from-settings>"
      }
    }
  }
}
```

Confirm the connection in Antigravity's MCP status view. If you later click **Rotate token** in
Flint's Settings, update the header with the new value — the old one stops working immediately.

## Tool surface

Read-only: `workspace_tree`, `workspace_stats`, `note_read`, `note_render`, `links_outgoing`,
`links_backlinks`, `search_names`, `search_content`, `config_get`.

Write: `note_create`, `frontmatter_set`, `note_rename`, `folder_create`, `folder_delete`,
`note_patch_section` (replace one section's body by heading path, leaving the heading and every
other section untouched), `note_insert_link` (insert a Markdown link at a location, or append to
a "Related" section, creating one if absent).

Every write tool takes an optional `fingerprint` (from a prior `note_read`). A stale fingerprint
never causes a silent overwrite — it comes back as a structured tool error:

```json
{
  "error": "conflict",
  "expected_fingerprint": { "...": "..." },
  "actual_fingerprint": { "...": "..." },
  "options": ["keep_your_version", "load_disk_version", "show_differences"]
}
```

Re-read the note and retry, the same way the editor's own conflict banner works.
