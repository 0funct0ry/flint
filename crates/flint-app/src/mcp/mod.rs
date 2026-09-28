//! Local MCP (Model Context Protocol) server (M10.21, SPEC-adjacent — see
//! `internal-docs/PROMPTS.md` M10.21, `internal-docs/SPEC.md` §17): opt-in, loopback-only
//! read/write access to the open workspace for external coding-agent clients (Claude Code,
//! Antigravity, Codex, ...). Every tool call goes through the exact same `resolve_in_workspace`
//! guard and atomic-write/fingerprint-conflict path the IPC layer already enforces — an MCP
//! client gets no more access than the React frontend already has.
//!
//! Bearer-token authentication is optional, off by default (`--mcp-auth`/`mcp.requireAuth`).
//! When on, the token is generated/rotated exclusively from the app's Settings UI and persisted
//! in `.flint.db` (via `flint_core::config::{get_mcp_token, set_mcp_token}`) — never
//! auto-generated at launch, never available from a CLI command.
//!
//! This module owns *wiring* (lifecycle, transport, auth), not domain logic: every tool handler
//! in `tools` delegates straight to the same `flint-core` functions (and the same
//! suppressed-write bookkeeping) the Tauri commands in `lib.rs` use.

mod auth;
mod server;
mod tools;

use flint_core::Index;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, RwLock};
use tauri::{AppHandle, Emitter};

use crate::SuppressedWrite;

/// Current lifecycle state of the MCP server, mirrored to the frontend via the `mcp:status`
/// event and the `mcp_status` query command (same pattern as `watcher:degraded`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", tag = "state")]
pub enum McpPhase {
    Off,
    Starting,
    Listening { url: String },
    Error { message: String },
}

/// `McpPhase` plus enough auth info for Settings/the status bar to decide what to show
/// ("Generate token" vs. "Rotate token" vs. nothing) without a second round-trip.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpStatus {
    #[serde(flatten)]
    pub phase: McpPhase,
    pub requires_auth: bool,
    pub has_token: bool,
}

/// Handle to a running (or not-yet-started) MCP server, held in `AppState`.
pub struct McpHandle {
    phase: Arc<Mutex<McpPhase>>,
    /// `None` until a token is generated from Settings — auth (when required) is fail-closed
    /// while this is `None`, per M10.21's "reject everything until one is created" rule.
    token: Arc<RwLock<Option<String>>>,
    require_auth: Arc<AtomicBool>,
    stop_flag: Arc<AtomicBool>,
    server: Mutex<Option<Arc<tiny_http::Server>>>,
    root: Mutex<Option<PathBuf>>,
}

impl Default for McpHandle {
    fn default() -> Self {
        Self {
            phase: Arc::new(Mutex::new(McpPhase::Off)),
            token: Arc::new(RwLock::new(None)),
            require_auth: Arc::new(AtomicBool::new(false)),
            stop_flag: Arc::new(AtomicBool::new(false)),
            server: Mutex::new(None),
            root: Mutex::new(None),
        }
    }
}

impl McpHandle {
    pub fn status(&self) -> McpStatus {
        let phase = self
            .phase
            .lock()
            .map(|s| s.clone())
            .unwrap_or(McpPhase::Off);
        McpStatus {
            phase,
            requires_auth: self.require_auth.load(Ordering::Relaxed),
            has_token: self.token.read().map(|t| t.is_some()).unwrap_or(false),
        }
    }

    fn emit_status(&self, app_handle: &AppHandle) {
        let _ = app_handle.emit("mcp:status", self.status());
    }

    /// Stop any currently running server (a no-op if none is running), so a fresh
    /// `workspace_open` never leaves a stale listener bound to the previous workspace.
    pub fn stop(&self) {
        self.stop_flag.store(true, Ordering::Relaxed);
        if let Ok(mut lock) = self.server.lock() {
            if let Some(server) = lock.take() {
                server.unblock();
            }
        }
        if let Ok(mut s) = self.phase.lock() {
            *s = McpPhase::Off;
        }
    }

    /// Start the server for `root`, binding `127.0.0.1` only. `configured_port` is tried first
    /// (falling back to `flint_core::config::DEFAULT_MCP_PORT`, then an OS-assigned ephemeral
    /// port if that's taken too — never a configurable bind *address*, only the port varies).
    /// `require_auth` comes from the CLI-override-OR-config value, same pattern as `--mcp`; the
    /// token itself (if any) is read from `.flint.db`, never generated here.
    pub fn start(
        self: &Arc<Self>,
        root: PathBuf,
        app_handle: AppHandle,
        index: Arc<RwLock<Index>>,
        suppressed_writes: Arc<Mutex<HashMap<String, SuppressedWrite>>>,
        configured_port: Option<u16>,
        require_auth: bool,
    ) {
        self.stop();
        self.stop_flag.store(false, Ordering::Relaxed);
        self.require_auth.store(require_auth, Ordering::Relaxed);

        if let Ok(mut s) = self.phase.lock() {
            *s = McpPhase::Starting;
        }
        self.emit_status(&app_handle);

        let existing_token = flint_core::config::get_mcp_token(&root)
            .ok()
            .flatten()
            .map(|record| record.token);
        if let Ok(mut t) = self.token.write() {
            *t = existing_token;
        }
        if let Ok(mut r) = self.root.lock() {
            *r = Some(root.clone());
        }

        let bind_port = configured_port.unwrap_or(flint_core::config::DEFAULT_MCP_PORT);
        let bound = server::bind_loopback(bind_port);
        let (http_server, actual_port) = match bound {
            Ok(pair) => pair,
            Err(e) => {
                if let Ok(mut s) = self.phase.lock() {
                    *s = McpPhase::Error {
                        message: format!("failed to bind MCP server: {e}"),
                    };
                }
                self.emit_status(&app_handle);
                return;
            }
        };
        let http_server = Arc::new(http_server);
        if let Ok(mut lock) = self.server.lock() {
            *lock = Some(Arc::clone(&http_server));
        }

        let url = format!("http://127.0.0.1:{actual_port}/mcp");
        if let Ok(mut s) = self.phase.lock() {
            *s = McpPhase::Listening { url };
        }
        self.emit_status(&app_handle);

        let token_arc = Arc::clone(&self.token);
        let require_auth_arc = Arc::clone(&self.require_auth);
        let stop_flag = Arc::clone(&self.stop_flag);
        std::thread::spawn(move || {
            server::serve(
                http_server,
                stop_flag,
                token_arc,
                require_auth_arc,
                root,
                index,
                suppressed_writes,
                app_handle,
            );
        });
    }

    /// Generate (or rotate — same operation) the bearer token, persisting it to `.flint.db` and
    /// swapping it into the live server — no restart required. This is the *only* way a token is
    /// ever created; called exclusively from the `mcp_rotate_token` Tauri command, i.e. from
    /// Settings. Errors if no workspace has been opened yet (nowhere to persist it).
    pub fn rotate_token(&self) -> Result<String, String> {
        let root = self
            .root
            .lock()
            .map_err(|e| e.to_string())?
            .clone()
            .ok_or_else(|| "No workspace is open".to_string())?;
        let new_token = server::generate_token();
        flint_core::config::set_mcp_token(&root, &new_token).map_err(|e| e.to_string())?;
        if let Ok(mut t) = self.token.write() {
            *t = Some(new_token.clone());
        }
        Ok(new_token)
    }
}
