mod mcp;

use flint_core::{
    bootstrap_workspace, build_workspace_tree, create_folder, create_note, delete_folder,
    delete_path, duplicate_note, get_last_workspace, get_recent_workspaces, is_default_ignored,
    is_note_path, read_note, rename_path, resolve_workspace_root, resolve_workspace_target,
    rewrite_tags_workspace, rewrite_workspace_links_for_rename, save_last_workspace,
    set_front_matter_fields, to_posix_path, write_note_atomic, BacklinkGroup, Fingerprint, Index,
    Link, NoteContent, NoteMeta, RenderResult, ResolvedWorkspaceTarget, SafePath, TreeNodeItem,
    WorkspaceInfo, WorkspaceStats,
};
pub use mcp::{McpHandle, McpStatus};
use notify::{Config, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::env;
use std::path::{Component, Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{channel, Receiver, Sender};
use std::sync::{Arc, Mutex, RwLock};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, State};

/// Suppressed write item to avoid double-processing Flint's own writes (SPEC §10.4).
#[derive(Debug, Clone)]
pub struct SuppressedWrite {
    pub content_hash: Option<String>,
    pub timestamp: Instant,
}

pub struct AppState {
    pub active_workspace: Mutex<Option<PathBuf>>,
    /// The note to focus on the very first `workspace_open` call when Flint was launched in
    /// file-open mode (M10.06). Consumed (taken) on first use so it never reapplies to a later
    /// workspace switch.
    pub pending_initial_note: Mutex<Option<String>>,
    pub index: Arc<RwLock<Index>>,
    pub suppressed_writes: Arc<Mutex<HashMap<String, SuppressedWrite>>>,
    pub watcher_stop: Arc<AtomicBool>,
    /// The local MCP server (M10.21) — off until `--mcp`/`mcp.enabled` is set at launch.
    pub mcp: Arc<McpHandle>,
    /// Set from the CLI's `--mcp` flag; ORed with the workspace's `mcp.enabled` config so
    /// either can turn the server on for this launch.
    pub mcp_cli_override: bool,
    /// Set from the CLI's `--mcp-auth` flag; ORed with the workspace's `mcp.requireAuth` config,
    /// same pattern as `mcp_cli_override` (M10.21 change: auth is opt-in, off by default).
    pub mcp_auth_cli_override: bool,
}

impl Default for AppState {
    fn default() -> Self {
        Self {
            active_workspace: Mutex::new(None),
            pending_initial_note: Mutex::new(None),
            index: Arc::new(RwLock::new(Index::new())),
            suppressed_writes: Arc::new(Mutex::new(HashMap::new())),
            watcher_stop: Arc::new(AtomicBool::new(false)),
            mcp: Arc::new(McpHandle::default()),
            mcp_cli_override: false,
            mcp_auth_cli_override: false,
        }
    }
}

/// Record a path being written by Flint to suppress subsequent watcher event.
pub(crate) fn record_suppressed_write(
    suppressed_map: &Arc<Mutex<HashMap<String, SuppressedWrite>>>,
    posix_path: &str,
    content_hash: Option<String>,
) {
    if let Ok(mut lock) = suppressed_map.lock() {
        // Clean up expired entries (> 2 seconds old)
        let now = Instant::now();
        lock.retain(|_, v| now.duration_since(v.timestamp) < Duration::from_secs(2));

        lock.insert(
            posix_path.to_string(),
            SuppressedWrite {
                content_hash,
                timestamp: now,
            },
        );
    }
}

/// Check if a path change was initiated by Flint itself.
fn is_suppressed_write(
    suppressed_map: &Arc<Mutex<HashMap<String, SuppressedWrite>>>,
    posix_path: &str,
    actual_hash: Option<&str>,
) -> bool {
    if let Ok(mut lock) = suppressed_map.lock() {
        let now = Instant::now();
        lock.retain(|_, v| now.duration_since(v.timestamp) < Duration::from_secs(2));

        if let Some(entry) = lock.get(posix_path) {
            let matches = match (&entry.content_hash, actual_hash) {
                (Some(expected), Some(actual)) => expected == actual,
                _ => true,
            };
            if matches {
                lock.remove(posix_path);
                return true;
            }
        }
    }
    false
}

/// Read the workspace's effective `mcp` config (workspace override over global default),
/// falling back to `McpConfig::default()` (off) on any load failure.
fn read_mcp_config(root: &Path) -> flint_core::config::McpConfig {
    flint_core::config_get(root, None)
        .ok()
        .and_then(|r| serde_json::from_value::<flint_core::config::FlintConfig>(r.config).ok())
        .map(|c| c.mcp)
        .unwrap_or_default()
}

/// Read `markdown.wikilinks` (M10.23), same fallback-to-default pattern as [`read_mcp_config`].
fn read_wikilinks_enabled(root: &Path) -> bool {
    flint_core::config_get(root, None)
        .ok()
        .and_then(|r| serde_json::from_value::<flint_core::config::FlintConfig>(r.config).ok())
        .map(|c| c.markdown.wikilinks)
        .unwrap_or(false)
}

/// Read `behaviour.rewriteTagsOnRename` (M10.25), same fallback-to-default pattern as
/// [`read_wikilinks_enabled`] — defaults to `true` when config can't be loaded, matching
/// `BehaviourConfig::default()`.
fn read_rewrite_tags_on_rename(root: &Path) -> bool {
    flint_core::config_get(root, None)
        .ok()
        .and_then(|r| serde_json::from_value::<flint_core::config::FlintConfig>(r.config).ok())
        .map(|c| c.behaviour.rewrite_tags_on_rename)
        .unwrap_or(true)
}

/// Read `newNote.*` config (M10.26), same fallback-to-default pattern as [`read_wikilinks_enabled`].
pub(crate) fn read_new_note_config(root: &Path) -> flint_core::config::NewNoteConfig {
    flint_core::config_get(root, None)
        .ok()
        .and_then(|r| serde_json::from_value::<flint_core::config::FlintConfig>(r.config).ok())
        .map(|c| c.new_note)
        .unwrap_or_default()
}

/// Read `dailyNotes.*` config (M10.26), same fallback-to-default pattern as [`read_new_note_config`].
pub(crate) fn read_daily_notes_config(root: &Path) -> flint_core::config::DailyNotesConfig {
    flint_core::config_get(root, None)
        .ok()
        .and_then(|r| serde_json::from_value::<flint_core::config::FlintConfig>(r.config).ok())
        .map(|c| c.daily_notes)
        .unwrap_or_default()
}

/// Render a template file into note content. The template's own front-matter fields carry over
/// to the note (with `{{...}}` placeholders resolved), except the `templateVariables` schema
/// field, which describes the template itself and never belongs on a note.
fn render_template_file(raw: &str, ctx: &flint_core::TemplateContext) -> String {
    let (_, template_body, _, fields) = flint_core::parse_front_matter(raw);
    let body = flint_core::render_template(template_body, ctx);
    let note_fields: Vec<(String, String)> = fields
        .into_iter()
        .filter(|(k, _)| k != flint_core::TEMPLATE_VARIABLES_FIELD)
        .map(|(k, v)| (k, flint_core::render_template(&v, ctx)))
        .collect();
    if note_fields.is_empty() {
        body
    } else {
        set_front_matter_fields(&body, &note_fields)
    }
}

/// Resolve a `template` argument (a path relative to `.flint/templates/`, per M10.26) to its
/// rendered content, or fall back to `NewNoteConfig.insert_heading` when no template was picked.
/// `posix_path`/`title` seed the `{{path}}`/`{{title}}` placeholders. Every path here — including
/// the template file itself — still crosses [`SafePath::resolve`], the same guard every other
/// filesystem-touching command uses; `.flint/templates/` is not a special case.
#[allow(dead_code)]
pub(crate) fn resolve_new_note_content(
    root: &Path,
    posix_path: &str,
    title: &str,
    template: Option<&str>,
) -> Result<String, String> {
    resolve_new_note_content_with_variables(root, posix_path, title, template, &HashMap::new())
}

/// Same as [`resolve_new_note_content`], plus (M10.27) resolved `{{var:name}}` values. Variable
/// values are only substituted into the template text — they are never recorded on the note as
/// front matter.
pub(crate) fn resolve_new_note_content_with_variables(
    root: &Path,
    posix_path: &str,
    title: &str,
    template: Option<&str>,
    variables: &HashMap<String, String>,
) -> Result<String, String> {
    let ctx = flint_core::TemplateContext {
        title: title.to_string(),
        path: posix_path.to_string(),
        now: chrono::Local::now(),
        variables: variables.clone(),
    };
    let content = match template {
        Some(name) => {
            let template_rel = format!("{}/{}", flint_core::TEMPLATES_DIR, name);
            let safe = SafePath::resolve(root, &template_rel).map_err(|e| e.to_string())?;
            let raw = std::fs::read_to_string(safe.as_path()).map_err(|e| e.to_string())?;
            render_template_file(&raw, &ctx)
        }
        None => {
            let cfg = read_new_note_config(root);
            if cfg.insert_heading {
                flint_core::render_template("# {{title}}\n", &ctx)
            } else {
                String::new()
            }
        }
    };

    Ok(content)
}

/// Helper to obtain the active workspace root or fallback to current dir.
fn get_workspace_root(state: &State<AppState>) -> Result<PathBuf, String> {
    let lock = state
        .active_workspace
        .lock()
        .map_err(|e| format!("Lock error: {}", e))?;
    match lock.as_ref() {
        Some(p) => Ok(p.clone()),
        None => {
            let current_dir = env::current_dir().map_err(|e| e.to_string())?;
            resolve_workspace_root(None, None, None, &current_dir).map_err(|e| e.to_string())
        }
    }
}

/// Progress payload emitted during indexing (SPEC §6.2, §11).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IndexProgressPayload {
    pub indexed: usize,
    pub total: usize,
}

/// Result returned from note_rename (SPEC §11).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RenameResult {
    pub moved: bool,
    pub links_updated: usize,
}

/// Result returned from tag_rename (M10.25).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TagRenameResult {
    pub renamed: bool,
    pub notes_updated: usize,
}

/// Event payload emitted when a note is changed, created, or removed.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NoteEventPayload {
    pub path: String,
}

/// Event payload emitted when a note or folder is renamed.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NoteRenamedPayload {
    pub from: String,
    pub to: String,
}

/// Event payload emitted when filesystem watcher status changes.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WatcherDegradedPayload {
    pub degraded: bool,
    pub reason: Option<String>,
}

/// Helper to safely strip root prefix handling canonicalization differences (e.g. /private on macOS).
fn get_relative_to_root(root: &Path, path: &Path) -> Option<PathBuf> {
    if let Ok(rel) = path.strip_prefix(root) {
        return Some(rel.to_path_buf());
    }
    if let (Ok(c_root), Ok(c_path)) = (std::fs::canonicalize(root), std::fs::canonicalize(path)) {
        if let Ok(rel) = c_path.strip_prefix(&c_root) {
            return Some(rel.to_path_buf());
        }
    }
    None
}

/// Check if a workspace path should be ignored by the watcher.
fn is_path_ignored(root: &Path, abs_path: &Path) -> bool {
    let file_name = abs_path
        .file_name()
        .map(|s| s.to_string_lossy())
        .unwrap_or_default();
    if file_name.ends_with(".flint-tmp") || file_name.ends_with('~') {
        return true;
    }

    let rel = match get_relative_to_root(root, abs_path) {
        Some(r) => r,
        None => return true,
    };

    for comp in rel.components() {
        if let Component::Normal(s) = comp {
            let name = s.to_string_lossy();
            if is_default_ignored(&name) {
                return true;
            }
        }
    }

    false
}

/// Spawn the debounced filesystem watcher thread with event coalescing (SPEC §10.4).
fn spawn_filesystem_watcher(
    root: PathBuf,
    app_handle: AppHandle,
    index_arc: Arc<RwLock<Index>>,
    suppressed_writes: Arc<Mutex<HashMap<String, SuppressedWrite>>>,
    stop_flag: Arc<AtomicBool>,
) {
    std::thread::spawn(move || {
        let (tx, rx): (
            Sender<notify::Result<notify::Event>>,
            Receiver<notify::Result<notify::Event>>,
        ) = channel();

        // Create watcher with notify
        let watcher_res = RecommendedWatcher::new(
            move |res| {
                let _ = tx.send(res);
            },
            Config::default(),
        );

        let mut watcher = match watcher_res {
            Ok(mut w) => {
                if let Err(e) = w.watch(&root, RecursiveMode::Recursive) {
                    let _ = app_handle.emit(
                        "watcher:degraded",
                        WatcherDegradedPayload {
                            degraded: true,
                            reason: Some(format!("Watch error: {}", e)),
                        },
                    );
                    None
                } else {
                    Some(w)
                }
            }
            Err(e) => {
                let _ = app_handle.emit(
                    "watcher:degraded",
                    WatcherDegradedPayload {
                        degraded: true,
                        reason: Some(format!("Watcher init error: {}", e)),
                    },
                );
                None
            }
        };

        if watcher.is_none() {
            // Polling fallback loop: 5 seconds interval per SPEC §10.4
            let mut last_scan_map: HashMap<String, u64> = HashMap::new();

            // Initial scan
            if let Ok(tree) = build_workspace_tree(&root, true, &[]) {
                fn populate_map(items: &[TreeNodeItem], map: &mut HashMap<String, u64>) {
                    for item in items {
                        map.insert(item.path.clone(), 0);
                        if let Some(ref children) = item.children {
                            populate_map(children, map);
                        }
                    }
                }
                populate_map(&tree, &mut last_scan_map);
            }

            while !stop_flag.load(Ordering::Relaxed) {
                std::thread::sleep(Duration::from_secs(5));
                if stop_flag.load(Ordering::Relaxed) {
                    break;
                }

                // Rescan and detect changes
                if let Ok(mut new_index) = Index::build_from_workspace(&root, |_, _| {}) {
                    new_index.set_wikilinks_enabled(read_wikilinks_enabled(&root), &root);
                    let stats = new_index.get_stats();
                    if let Ok(mut lock) = index_arc.write() {
                        *lock = new_index;
                    }
                    let _ = app_handle.emit("index:ready", stats);
                }
            }
            return;
        }

        // Debounce map: posix_path -> (EventKind, Vec<PathBuf>, Instant)
        let mut debounce_events: HashMap<String, (EventKind, Vec<PathBuf>, Instant)> =
            HashMap::new();

        while !stop_flag.load(Ordering::Relaxed) {
            // Check for incoming notify events with 50ms timeout
            match rx.recv_timeout(Duration::from_millis(50)) {
                Ok(Ok(event)) => {
                    let kind = event.kind;
                    for path in event.paths {
                        if is_path_ignored(&root, &path) {
                            continue;
                        }
                        let rel_opt = get_relative_to_root(&root, &path);
                        let rel = match rel_opt.as_ref() {
                            Some(r) => r.as_path(),
                            None => path.strip_prefix(&root).unwrap_or(&path),
                        };
                        let posix = to_posix_path(rel);
                        if posix.is_empty() {
                            continue;
                        }

                        debounce_events.insert(posix, (kind, vec![path], Instant::now()));
                    }
                }
                Ok(Err(err)) => {
                    eprintln!("Notify watcher error: {:?}", err);
                    let _ = app_handle.emit(
                        "watcher:degraded",
                        WatcherDegradedPayload {
                            degraded: true,
                            reason: Some(format!("{:?}", err)),
                        },
                    );
                }
                Err(_) => {
                    // Timeout - process ready debounced events (>= 150ms old)
                }
            }

            if debounce_events.is_empty() {
                continue;
            }

            let now = Instant::now();
            let debounce_threshold = Duration::from_millis(150);

            let mut ready_keys = Vec::new();
            for (posix, (_, _, timestamp)) in debounce_events.iter() {
                if now.duration_since(*timestamp) >= debounce_threshold {
                    ready_keys.push(posix.clone());
                }
            }

            for posix in ready_keys {
                if let Some((_kind, paths, _)) = debounce_events.remove(&posix) {
                    let abs_path = paths.first().cloned().unwrap_or_else(|| root.join(&posix));
                    let is_note = is_note_path(&abs_path);

                    if abs_path.exists() {
                        if abs_path.is_file() && is_note {
                            if let Ok(safe_path) = SafePath::resolve(&root, &posix) {
                                if let Ok(bytes) = std::fs::read(safe_path.as_path()) {
                                    let hash = flint_core::hash_bytes(&bytes);

                                    // Check if self-written by Flint with matching content hash
                                    if is_suppressed_write(&suppressed_writes, &posix, Some(&hash))
                                    {
                                        continue;
                                    }

                                    if let Ok(content) = String::from_utf8(bytes) {
                                        let was_existing = if let Ok(mut lock) = index_arc.write() {
                                            let exists = lock.notes.contains_key(&posix);
                                            lock.insert_or_update_note(&root, &safe_path, &content);
                                            exists
                                        } else {
                                            false
                                        };

                                        if was_existing {
                                            let _ = app_handle.emit(
                                                "note:changed",
                                                NoteEventPayload {
                                                    path: posix.clone(),
                                                },
                                            );
                                        } else {
                                            let _ = app_handle.emit(
                                                "note:created",
                                                NoteEventPayload {
                                                    path: posix.clone(),
                                                },
                                            );
                                        }
                                    }
                                }
                            }
                        }
                    } else {
                        // File or folder removed on disk
                        if is_suppressed_write(&suppressed_writes, &posix, None) {
                            continue;
                        }

                        if let Ok(mut lock) = index_arc.write() {
                            lock.remove_note(Some(&root), &posix);
                        }

                        let _ = app_handle.emit(
                            "note:removed",
                            NoteEventPayload {
                                path: posix.clone(),
                            },
                        );
                    }

                    // Emit updated stats
                    if let Ok(lock) = index_arc.read() {
                        let stats = lock.get_stats();
                        let _ = app_handle.emit("index:ready", stats);
                    }
                }
            }
        }

        // Clean up watcher
        if let Some(mut w) = watcher.take() {
            let _ = w.unwatch(&root);
        }
    });
}

/// Open and initialize a workspace directory with background indexing and watcher (SPEC §6.2, §10.4, §11).
#[tauri::command]
fn workspace_open(
    path: Option<String>,
    app_handle: AppHandle,
    state: State<AppState>,
) -> Result<WorkspaceInfo, String> {
    let current_dir = env::current_dir().map_err(|e| e.to_string())?;
    let path_buf = path.map(PathBuf::from);

    let mut initial_note_opt = None;
    let mut is_file_open_mode = false;

    let root = match path_buf {
        Some(explicit) => match resolve_workspace_target(Some(&explicit), None, None, &current_dir)
            .map_err(|e| e.to_string())?
        {
            ResolvedWorkspaceTarget::Directory(dir) => dir,
            ResolvedWorkspaceTarget::File {
                ws_root,
                initial_note,
            } => {
                initial_note_opt = Some(initial_note);
                is_file_open_mode = true;
                ws_root
            }
        },
        None => {
            let active_opt = state
                .active_workspace
                .lock()
                .map_err(|e| format!("Lock error: {}", e))?
                .clone();
            match active_opt {
                // `active_workspace` is always an already-resolved, canonical workspace
                // *directory* by this point — it is seeded from `run_with_context`'s resolved
                // `ws_root` (never a raw file path) and every prior successful call to this
                // command overwrites it with `root` below, which is itself always a directory.
                Some(active) => active,
                None => {
                    // Try lastWorkspace from global config (SPEC §3.1, M10.04)
                    if let Some(last_ws) = get_last_workspace() {
                        last_ws
                    } else {
                        // No remembered workspace and no path signal -> return error so onboarding state is shown
                        return Err("No workspace open".to_string());
                    }
                }
            }
        }
    };

    // Consume the pending file-open-mode note (if any) on this, the first `workspace_open` call
    // after launch — it must not reapply to a later manual workspace switch.
    if !is_file_open_mode {
        if let Ok(mut lock) = state.pending_initial_note.lock() {
            if let Some(note) = lock.take() {
                initial_note_opt = Some(note);
                is_file_open_mode = true;
            }
        }
    }

    // Bootstrap .flint/config.json idempotently
    bootstrap_workspace(&root).map_err(|e| e.to_string())?;

    // Persist as lastWorkspace in global config unless launching in file-open mode (SPEC M10.06 rule 3)
    if !is_file_open_mode {
        let _ = save_last_workspace(&root);
    }

    let name = root
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("workspace")
        .to_string();

    let tree = build_workspace_tree(&root, true, &[]).unwrap_or_default();
    let is_empty = tree.is_empty();

    let info = WorkspaceInfo {
        name,
        path: root.display().to_string(),
        is_empty,
        initial_note: initial_note_opt,
        start_collapsed: if is_file_open_mode { Some(true) } else { None },
    };

    // Stop existing watcher if any, then start a new one
    state.watcher_stop.store(true, Ordering::Relaxed);

    if let Ok(mut lock) = state.active_workspace.lock() {
        *lock = Some(root.clone());
    }

    // Spawn background indexing task per SPEC §6.2
    let root_clone = root.clone();
    let index_arc = Arc::clone(&state.index);
    let app_handle_clone = app_handle.clone();

    std::thread::spawn(move || {
        let handle_for_progress = app_handle_clone.clone();
        let build_result = Index::build_from_workspace(&root_clone, move |indexed, total| {
            let _ =
                handle_for_progress.emit("index:progress", IndexProgressPayload { indexed, total });
        });

        if let Ok(mut new_index) = build_result {
            new_index.set_wikilinks_enabled(read_wikilinks_enabled(&root_clone), &root_clone);
            let stats = new_index.get_stats();
            if let Ok(mut lock) = index_arc.write() {
                *lock = new_index;
            }
            let _ = app_handle_clone.emit("index:ready", stats);
        }
    });

    // Start new filesystem watcher per SPEC §10.4
    state.watcher_stop.store(false, Ordering::Relaxed);
    spawn_filesystem_watcher(
        root.clone(),
        app_handle.clone(),
        Arc::clone(&state.index),
        Arc::clone(&state.suppressed_writes),
        Arc::clone(&state.watcher_stop),
    );

    // Start (or restart, if switching workspaces) the local MCP server per M10.21.
    let mcp_cfg = read_mcp_config(&root);
    if state.mcp_cli_override || mcp_cfg.enabled {
        state.mcp.start(
            root,
            app_handle,
            Arc::clone(&state.index),
            Arc::clone(&state.suppressed_writes),
            mcp_cfg.port,
            state.mcp_auth_cli_override || mcp_cfg.require_auth,
        );
    } else {
        state.mcp.stop();
    }

    Ok(info)
}

/// Native folder picker dialog (SPEC §9.4, M10.04), via Tauri's own dialog plugin
/// rather than shelling out to platform-specific scripts.
///
/// `blocking_pick_folder` blocks the calling thread until the dialog closes, while the
/// dialog itself needs the main thread free to pump its own event loop. Tauri's sync
/// command dispatch can land on that same thread, which deadlocks (app hangs, no dialog
/// ever shown). Running it inside `spawn_blocking` moves the wait onto a dedicated
/// worker thread so the main thread stays free.
#[tauri::command]
async fn choose_folder(app_handle: AppHandle) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;

    tauri::async_runtime::spawn_blocking(move || {
        let folder = app_handle
            .dialog()
            .file()
            .set_title("Select a Flint workspace folder")
            .blocking_pick_folder();

        folder.map(|f| f.to_string())
    })
    .await
    .map_err(|e| e.to_string())
}

/// List recently opened workspaces (most-recent-first), for the onboarding screen (M10.04).
/// Entries whose directory no longer exists on disk are already filtered out by
/// `get_recent_workspaces`.
#[tauri::command]
fn recent_workspaces() -> Vec<String> {
    get_recent_workspaces()
        .into_iter()
        .map(|p| p.display().to_string())
        .collect()
}

/// Retrieve the live workspace file tree.
#[tauri::command]
fn workspace_tree(
    show_non_note_files: Option<bool>,
    state: State<AppState>,
) -> Result<Vec<TreeNodeItem>, String> {
    let root = get_workspace_root(&state)?;
    let show_non_notes = show_non_note_files.unwrap_or(false);
    let ignore = flint_core::config_get(&root, None)
        .ok()
        .map(|r| r.config)
        .and_then(|v| v.get("ignore").cloned())
        .and_then(|v| serde_json::from_value::<Vec<String>>(v).ok())
        .unwrap_or_default();
    build_workspace_tree(&root, show_non_notes, &ignore).map_err(|e| e.to_string())
}

/// Read a note's content, metadata, and fingerprint safely (SPEC §8.3, §11).
#[tauri::command]
fn note_read(path: String, state: State<AppState>) -> Result<NoteContent, String> {
    let root = get_workspace_root(&state)?;
    let safe_path = SafePath::resolve(&root, &path).map_err(|e| e.to_string())?;
    read_note(&root, &safe_path).map_err(|e| e.to_string())
}

/// Atomically write a note with fingerprint conflict detection and incremental index update (SPEC §8.3, §10.3, §11).
#[tauri::command]
fn note_write(
    path: String,
    content: String,
    fingerprint: Option<Fingerprint>,
    state: State<AppState>,
) -> Result<Fingerprint, String> {
    let root = get_workspace_root(&state)?;
    let safe_path = SafePath::resolve(&root, &path).map_err(|e| e.to_string())?;
    let posix = safe_path.to_posix_string();

    let fp = write_note_atomic(&root, &safe_path, &content, fingerprint.as_ref())
        .map_err(|e| e.to_string())?;

    // Record self-write suppression with actual written content hash
    record_suppressed_write(
        &state.suppressed_writes,
        &posix,
        Some(fp.content_hash.clone()),
    );

    // Incremental index update per SPEC §6.2
    if let Ok(mut lock) = state.index.write() {
        lock.insert_or_update_note(&root, &safe_path, &content);
    }

    Ok(fp)
}

/// Set a note's front-matter fields (ordered key/value pairs), rebuilding only
/// the front-matter block while leaving the body untouched, and persisting
/// through the same atomic write + fingerprint conflict check + incremental
/// index update path as `note_write` (SPEC §5.3, §8.3, §10.3, §11, M10.10).
#[tauri::command]
fn frontmatter_set(
    path: String,
    fields: Vec<(String, String)>,
    fingerprint: Option<Fingerprint>,
    state: State<AppState>,
) -> Result<Fingerprint, String> {
    let root = get_workspace_root(&state)?;
    let safe_path = SafePath::resolve(&root, &path).map_err(|e| e.to_string())?;
    let posix = safe_path.to_posix_string();

    let current = read_note(&root, &safe_path).map_err(|e| e.to_string())?;
    let new_content = set_front_matter_fields(&current.content, &fields);

    let fp = write_note_atomic(&root, &safe_path, &new_content, fingerprint.as_ref())
        .map_err(|e| e.to_string())?;

    record_suppressed_write(
        &state.suppressed_writes,
        &posix,
        Some(fp.content_hash.clone()),
    );

    if let Ok(mut lock) = state.index.write() {
        lock.insert_or_update_note(&root, &safe_path, &new_content);
    }

    Ok(fp)
}

/// Create a new note at path and update index (SPEC §11, M4).
///
/// `template` is a path relative to `.flint/templates/` (M10.26), not literal content: when set,
/// the named template file is rendered (`{{date}}`/`{{time}}`/`{{title}}`/`{{path}}`) into the
/// new note's initial body. When `None`, `NewNoteConfig.insert_heading` decides whether a bare
/// `# <title>` heading is inserted instead of an empty file.
#[tauri::command]
fn note_create(
    path: String,
    template: Option<String>,
    variables: Option<HashMap<String, String>>,
    state: State<AppState>,
) -> Result<NoteMeta, String> {
    let root = get_workspace_root(&state)?;
    let safe_path = SafePath::resolve(&root, &path).map_err(|e| e.to_string())?;
    let posix = safe_path.to_posix_string();
    let title = flint_core::resolve_note_title("", safe_path.as_relative_path());

    let content = resolve_new_note_content_with_variables(
        &root,
        &posix,
        &title,
        template.as_deref(),
        &variables.unwrap_or_default(),
    )?;
    let meta = create_note(&root, &safe_path, Some(&content)).map_err(|e| e.to_string())?;

    let hash = flint_core::hash_bytes(content.as_bytes());
    record_suppressed_write(&state.suppressed_writes, &posix, Some(hash));

    // Incremental index update per SPEC §6.2
    if let Ok(mut lock) = state.index.write() {
        lock.insert_or_update_note(&root, &safe_path, &content);
    }

    Ok(meta)
}

/// List the templates available under `.flint/templates/` (M10.26), for the new-note template
/// picker and the daily-notes settings dropdown. Never errors: an absent directory is a designed
/// empty state, not a failure (see [`flint_core::list_templates`]).
#[tauri::command]
fn templates_list(state: State<AppState>) -> Result<Vec<flint_core::TemplateMeta>, String> {
    let root = get_workspace_root(&state)?;
    Ok(flint_core::list_templates(&root))
}

/// Read the effective `FlintConfig`, same fallback-to-default pattern as [`read_new_note_config`].
fn read_full_config(root: &Path) -> flint_core::config::FlintConfig {
    flint_core::config_get(root, None)
        .ok()
        .and_then(|r| serde_json::from_value::<flint_core::config::FlintConfig>(r.config).ok())
        .unwrap_or_default()
}

/// Author a new template file under `.flint/templates/` from Journey A's `TemplateEditorModal`
/// (M10.27): writes the declared variable schema as the `templateVariables` front-matter field,
/// plus a starter body with a `{{title}}` heading and one `{{var:name}}` placeholder per declared
/// variable, then returns its [`flint_core::TemplateMeta`] so the caller can open it directly in
/// the editor ("template authoring *is* note editing").
pub(crate) fn create_template_file(
    root: &Path,
    name: &str,
    variables: &[flint_core::TemplateVariableDef],
    body: &str,
) -> Result<(SafePath, String, flint_core::TemplateMeta), String> {
    let slug = flint_core::slugify(name);
    if slug.is_empty() {
        return Err("Template name must contain at least one letter or digit".to_string());
    }
    let rel_path = format!("{}.md", slug);
    let template_rel = format!("{}/{}", flint_core::TEMPLATES_DIR, rel_path);
    let safe_path = SafePath::resolve(root, &template_rel).map_err(|e| e.to_string())?;

    let content = set_front_matter_fields(
        body,
        &[(
            flint_core::TEMPLATE_VARIABLES_FIELD.to_string(),
            flint_core::serialize_template_variables(variables),
        )],
    );

    let meta = flint_core::TemplateMeta {
        name: name.to_string(),
        path: rel_path,
    };
    Ok((safe_path, content, meta))
}

/// Author a new template file under `.flint/templates/` from the Templates screen's create form
/// (M10.27): writes the declared variable schema as the `templateVariables` front-matter field,
/// plus the body exactly as authored in the screen's CodeMirror editor, then returns its
/// [`flint_core::TemplateMeta`] so the caller can select it directly.
#[tauri::command]
fn template_create(
    name: String,
    variables: Vec<flint_core::TemplateVariableDef>,
    body: String,
    state: State<AppState>,
) -> Result<flint_core::TemplateMeta, String> {
    let root = get_workspace_root(&state)?;
    let (safe_path, content, meta) = create_template_file(&root, &name, &variables, &body)?;

    let _note_meta = create_note(&root, &safe_path, Some(&content)).map_err(|e| e.to_string())?;
    record_suppressed_write(
        &state.suppressed_writes,
        &safe_path.to_posix_string(),
        Some(flint_core::hash_bytes(content.as_bytes())),
    );
    if let Ok(mut lock) = state.index.write() {
        lock.insert_or_update_note(&root, &safe_path, &content);
    }

    Ok(meta)
}

/// Load one template file's raw `templateVariables` front-matter value (root-only, no `State`, so
/// it can be exercised directly from integration tests).
pub(crate) fn load_template_variables(
    root: &Path,
    template_path: &str,
) -> Result<Vec<flint_core::TemplateVariableDef>, String> {
    let template_rel = format!("{}/{}", flint_core::TEMPLATES_DIR, template_path);
    let safe_path = SafePath::resolve(root, &template_rel).map_err(|e| e.to_string())?;
    let raw = std::fs::read_to_string(safe_path.as_path()).map_err(|e| e.to_string())?;
    let (_, _, _, fields) = flint_core::parse_front_matter(&raw);
    let raw_vars = fields
        .into_iter()
        .find(|(k, _)| k == flint_core::TEMPLATE_VARIABLES_FIELD)
        .map(|(_, v)| v)
        .unwrap_or_default();
    Ok(flint_core::parse_template_variables(&raw_vars))
}

/// Read one template file's declared variable schema (Journey A, "Edit template variables…").
#[tauri::command]
fn template_variables_get(
    template_path: String,
    state: State<AppState>,
) -> Result<Vec<flint_core::TemplateVariableDef>, String> {
    let root = get_workspace_root(&state)?;
    load_template_variables(&root, &template_path)
}

/// Rewrite only a template file's `templateVariables` front-matter field, leaving its body
/// untouched (Journey A, "Edit template variables…" — no hand-editing the JSON required).
#[tauri::command]
fn template_variables_set(
    template_path: String,
    variables: Vec<flint_core::TemplateVariableDef>,
    state: State<AppState>,
) -> Result<(), String> {
    let root = get_workspace_root(&state)?;
    let template_rel = format!("{}/{}", flint_core::TEMPLATES_DIR, template_path);
    let safe_path = SafePath::resolve(&root, &template_rel).map_err(|e| e.to_string())?;
    let current = std::fs::read_to_string(safe_path.as_path()).map_err(|e| e.to_string())?;
    let new_content = set_front_matter_fields(
        &current,
        &[(
            flint_core::TEMPLATE_VARIABLES_FIELD.to_string(),
            flint_core::serialize_template_variables(&variables),
        )],
    );
    let fp = write_note_atomic(&root, &safe_path, &new_content, None).map_err(|e| e.to_string())?;
    record_suppressed_write(
        &state.suppressed_writes,
        &safe_path.to_posix_string(),
        Some(fp.content_hash),
    );
    if let Ok(mut lock) = state.index.write() {
        lock.insert_or_update_note(&root, &safe_path, &new_content);
    }
    Ok(())
}

/// Root-only implementation of `template_body_get` (no `State`), directly unit-testable.
pub(crate) fn load_template_body(root: &Path, template_path: &str) -> Result<String, String> {
    let template_rel = format!("{}/{}", flint_core::TEMPLATES_DIR, template_path);
    let safe_path = SafePath::resolve(root, &template_rel).map_err(|e| e.to_string())?;
    let raw = std::fs::read_to_string(safe_path.as_path()).map_err(|e| e.to_string())?;
    let (_, body, _, _) = flint_core::parse_front_matter(&raw);
    Ok(body.to_string())
}

/// Read one template file's body (everything after its front-matter block, if any) for the
/// Templates screen's CodeMirror body editor.
#[tauri::command]
fn template_body_get(template_path: String, state: State<AppState>) -> Result<String, String> {
    let root = get_workspace_root(&state)?;
    load_template_body(&root, &template_path)
}

/// Rewrite only a template file's body, leaving its `templateVariables` front-matter field (and
/// any other front matter) untouched — the counterpart to `template_variables_set`.
#[tauri::command]
fn template_body_set(
    template_path: String,
    body: String,
    state: State<AppState>,
) -> Result<(), String> {
    let root = get_workspace_root(&state)?;
    let template_rel = format!("{}/{}", flint_core::TEMPLATES_DIR, template_path);
    let safe_path = SafePath::resolve(&root, &template_rel).map_err(|e| e.to_string())?;
    let current = std::fs::read_to_string(safe_path.as_path()).map_err(|e| e.to_string())?;
    let new_content = flint_core::set_note_body(&current, &body);
    let fp = write_note_atomic(&root, &safe_path, &new_content, None).map_err(|e| e.to_string())?;
    record_suppressed_write(
        &state.suppressed_writes,
        &safe_path.to_posix_string(),
        Some(fp.content_hash),
    );
    if let Ok(mut lock) = state.index.write() {
        lock.insert_or_update_note(&root, &safe_path, &new_content);
    }
    Ok(())
}

/// One variable's declared schema plus its precedence-resolved effective value (M10.27 Journey B
/// / Journey C) — the frontend renders this verbatim rather than reimplementing the scope chain.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedTemplateVariable {
    pub def: flint_core::TemplateVariableDef,
    pub resolved_default: String,
}

/// Root-only implementation of `resolve_new_note_variables` (no `State`), directly integration-
/// testable against a real `.flint.db` + `.flint/templates/` fixture.
pub(crate) fn resolve_new_note_variables_impl(
    root: &Path,
    template_path: Option<&str>,
    target_folder: Option<&str>,
) -> Result<Vec<ResolvedTemplateVariable>, String> {
    let Some(template_path) = template_path else {
        return Ok(Vec::new());
    };

    let vars = load_template_variables(root, template_path)?;

    let config = flint_core::config_get(root, None)
        .map_err(|e| e.to_string())?
        .config;
    let folder_scope =
        flint_core::config::nearest_ancestor_folder_variables(&config, target_folder.unwrap_or(""));
    let global_scope = read_full_config(root).templates.global_variables;

    let resolved =
        flint_core::resolve_variables(&vars, &HashMap::new(), &folder_scope, &global_scope);
    Ok(vars
        .into_iter()
        .map(|def| {
            let resolved_default = resolved.get(&def.name).cloned().unwrap_or_default();
            ResolvedTemplateVariable {
                def,
                resolved_default,
            }
        })
        .collect())
}

/// Server-side precedence resolution for the New Note modal's variable fields (Journey B/C):
/// explicit (typed into the modal, not known yet at this point) > nearest-ancestor folder scope >
/// global scope > the variable's own schema default. Returns an empty list when `template_path`
/// is `None` (a plain/blank note has no variables to prompt for).
#[tauri::command]
fn resolve_new_note_variables(
    template_path: Option<String>,
    target_folder: Option<String>,
    state: State<AppState>,
) -> Result<Vec<ResolvedTemplateVariable>, String> {
    let root = get_workspace_root(&state)?;
    resolve_new_note_variables_impl(&root, template_path.as_deref(), target_folder.as_deref())
}

/// Read one folder's variable scope (Journey C) — `folder_path` is workspace-relative POSIX,
/// empty string for the workspace root.
#[tauri::command]
fn folder_variables_get(
    folder_path: String,
    state: State<AppState>,
) -> Result<HashMap<String, String>, String> {
    let root = get_workspace_root(&state)?;
    let key = flint_core::config::folder_variables_key(&folder_path);
    let result = flint_core::config_get(&root, Some(&key)).map_err(|e| e.to_string())?;
    Ok(serde_json::from_value(result.config).unwrap_or_default())
}

/// Write one folder's variable scope (Journey C, "Folder variables…" modal).
#[tauri::command]
fn folder_variables_set(
    folder_path: String,
    variables: HashMap<String, String>,
    state: State<AppState>,
) -> Result<(), String> {
    let root = get_workspace_root(&state)?;
    let key = flint_core::config::folder_variables_key(&folder_path);
    let value = serde_json::to_value(&variables).map_err(|e| e.to_string())?;
    flint_core::config_set(&root, &key, value).map_err(|e| e.to_string())
}

/// Pure date arithmetic for `daily_note_open`/the MCP `daily_note_open` tool (M10.26), split out
/// from the command itself so month/year-boundary behavior is unit-testable without a `State`.
/// `date` (when given) wins over `offset_days`, matching the command's documented precedence.
pub(crate) fn resolve_daily_note_target_date(
    today: chrono::NaiveDate,
    offset_days: Option<i64>,
    date: Option<&str>,
) -> Result<chrono::NaiveDate, String> {
    match date {
        Some(d) => chrono::NaiveDate::parse_from_str(d, "%Y-%m-%d")
            .map_err(|_| format!("Invalid date: {}", d)),
        None => Ok(today + chrono::Duration::days(offset_days.unwrap_or(0))),
    }
}

/// Open (creating on first use only) the daily note for a given day (M10.26).
///
/// `offset_days` is relative to today (`-1` = yesterday, `0`/`None` = today, `1` = tomorrow);
/// `date` (`YYYY-MM-DD`) picks an explicit day instead and takes precedence when both are given.
/// The path is computed by rendering `dailyNotes.pathPattern`; if that note already exists it is
/// simply opened (its `NoteMeta` returned) rather than recreated. This command is the *only* way
/// a daily note is ever created — nothing at startup or in the watcher calls it, so
/// `dailyNotes.enabled` merely gates whether the UI offers these commands, never auto-creation.
#[tauri::command]
fn daily_note_open(
    offset_days: Option<i64>,
    date: Option<String>,
    variables: Option<HashMap<String, String>>,
    state: State<AppState>,
) -> Result<NoteMeta, String> {
    let root = get_workspace_root(&state)?;
    let cfg = read_daily_notes_config(&root);

    let now_local = chrono::Local::now();
    let target_date =
        resolve_daily_note_target_date(now_local.date_naive(), offset_days, date.as_deref())?;
    let target_dt = chrono::NaiveDateTime::new(target_date, now_local.time())
        .and_local_timezone(chrono::Local)
        .single()
        .ok_or_else(|| "Ambiguous local time for that date".to_string())?;

    let path_ctx = flint_core::TemplateContext {
        title: target_date.format("%Y-%m-%d").to_string(),
        path: String::new(),
        now: target_dt,
        variables: HashMap::new(),
    };
    let rendered_path = flint_core::render_template(&cfg.path_pattern, &path_ctx);
    let safe_path = SafePath::resolve(&root, &rendered_path).map_err(|e| e.to_string())?;

    if safe_path.as_path().exists() {
        return read_note(&root, &safe_path)
            .map(|note| note.meta)
            .map_err(|e| e.to_string());
    }

    let posix = safe_path.to_posix_string();
    let title = flint_core::resolve_note_title("", safe_path.as_relative_path());
    let variables = variables.unwrap_or_default();
    let note_ctx = flint_core::TemplateContext {
        title: title.clone(),
        path: posix.clone(),
        now: target_dt,
        variables: variables.clone(),
    };
    let content = match cfg.template.as_deref() {
        Some(name) => {
            let template_rel = format!("{}/{}", flint_core::TEMPLATES_DIR, name);
            let tpl_safe = SafePath::resolve(&root, &template_rel).map_err(|e| e.to_string())?;
            let raw = std::fs::read_to_string(tpl_safe.as_path()).map_err(|e| e.to_string())?;
            render_template_file(&raw, &note_ctx)
        }
        None => String::new(),
    };

    let meta = create_note(&root, &safe_path, Some(&content)).map_err(|e| e.to_string())?;
    let hash = flint_core::hash_bytes(content.as_bytes());
    record_suppressed_write(&state.suppressed_writes, &posix, Some(hash));
    if let Ok(mut lock) = state.index.write() {
        lock.insert_or_update_note(&root, &safe_path, &content);
    }

    Ok(meta)
}

/// Rename/move a note or folder and optionally rewrite all relative markdown links (SPEC §5.4, §11, M8).
#[tauri::command]
fn note_rename(
    from: String,
    to: String,
    rewrite_links: Option<bool>,
    state: State<AppState>,
) -> Result<RenameResult, String> {
    let root = get_workspace_root(&state)?;
    let from_safe = SafePath::resolve(&root, &from).map_err(|e| e.to_string())?;
    let to_safe = SafePath::resolve(&root, &to).map_err(|e| e.to_string())?;

    let from_posix = from_safe.to_posix_string();
    let to_posix = to_safe.to_posix_string();

    // Build map of moved notes for link rewriting
    let mut moved_notes_map = HashMap::new();
    let from_abs = from_safe.as_path();

    if from_abs.is_file() {
        moved_notes_map.insert(from_posix.clone(), to_posix.clone());
    } else if from_abs.is_dir() {
        // Collect all child notes within the renamed folder
        let walker = ignore::WalkBuilder::new(from_abs)
            .hidden(false)
            .parents(true)
            .git_ignore(true)
            .build();
        for entry in walker.flatten() {
            let path = entry.path();
            if path.is_file() && is_note_path(path) {
                if let Ok(rel) = path.strip_prefix(&root) {
                    let old_posix = to_posix_path(rel);
                    let sub = old_posix.strip_prefix(&from_posix).unwrap_or("");
                    let new_posix = format!("{}{}", to_posix, sub);
                    moved_notes_map.insert(old_posix, new_posix);
                }
            }
        }
    }

    rename_path(&root, &from_safe, &to_safe).map_err(|e| e.to_string())?;

    // Record suppression for moved items
    record_suppressed_write(&state.suppressed_writes, &from_posix, None);
    if to_safe.as_path().is_file() {
        if let Ok(bytes) = std::fs::read(to_safe.as_path()) {
            record_suppressed_write(
                &state.suppressed_writes,
                &to_posix,
                Some(flint_core::hash_bytes(&bytes)),
            );
        } else {
            record_suppressed_write(&state.suppressed_writes, &to_posix, None);
        }
    } else {
        record_suppressed_write(&state.suppressed_writes, &to_posix, None);
    }

    // Check if rewriteLinksOnRename is enabled (default: true per SPEC §5.4, §12)
    let do_rewrite = rewrite_links.unwrap_or(true);
    let mut links_updated = 0;

    if do_rewrite && !moved_notes_map.is_empty() {
        let filename_stems = state
            .index
            .read()
            .map(|lock| lock.filename_stems.clone())
            .unwrap_or_default();
        if let Ok(summary) =
            rewrite_workspace_links_for_rename(&root, &moved_notes_map, &filename_stems)
        {
            links_updated = summary.links_updated;
            for (rewritten_path, new_content) in summary.rewritten_notes {
                let hash = flint_core::hash_bytes(new_content.as_bytes());
                record_suppressed_write(&state.suppressed_writes, &rewritten_path, Some(hash));
            }
        }
    }

    // Update index on rename
    if let Ok(mut lock) = state.index.write() {
        for (old_p, new_p) in &moved_notes_map {
            lock.remove_note(Some(&root), old_p);
            if let Ok(safe) = SafePath::resolve(&root, new_p) {
                if safe.as_path().is_file() {
                    if let Ok(content) = std::fs::read_to_string(safe.as_path()) {
                        lock.insert_or_update_note(&root, &safe, &content);
                    }
                }
            }
        }
    }

    Ok(RenameResult {
        moved: true,
        links_updated,
    })
}

/// Rename a tag across the whole workspace: every front-matter `tags:` entry carrying it is
/// always rewritten, and every inline `#tag` occurrence is too unless `behaviour.rewriteTagsOnRename`
/// is off (SPEC/M10.25).
#[tauri::command]
fn tag_rename(old: String, new: String, state: State<AppState>) -> Result<TagRenameResult, String> {
    let root = get_workspace_root(&state)?;
    let rewrite_inline = read_rewrite_tags_on_rename(&root);

    let tag_index = state
        .index
        .read()
        .map(|lock| lock.tags.clone())
        .unwrap_or_default();

    let summary = rewrite_tags_workspace(&root, &old, &new, &tag_index, rewrite_inline)
        .map_err(|e| e.to_string())?;

    for (rewritten_path, new_content) in &summary.rewritten_notes {
        let hash = flint_core::hash_bytes(new_content.as_bytes());
        record_suppressed_write(&state.suppressed_writes, rewritten_path, Some(hash));
    }

    if let Ok(mut lock) = state.index.write() {
        for (rewritten_path, _) in &summary.rewritten_notes {
            if let Ok(safe) = SafePath::resolve(&root, rewritten_path) {
                if let Ok(content) = std::fs::read_to_string(safe.as_path()) {
                    lock.insert_or_update_note(&root, &safe, &content);
                }
            }
        }
    }

    Ok(TagRenameResult {
        renamed: true,
        notes_updated: summary.notes_updated,
    })
}

/// Duplicate a note (SPEC §11, M4).
#[tauri::command]
fn note_duplicate(path: String, state: State<AppState>) -> Result<NoteMeta, String> {
    let root = get_workspace_root(&state)?;
    let safe_path = SafePath::resolve(&root, &path).map_err(|e| e.to_string())?;
    let meta = duplicate_note(&root, &safe_path).map_err(|e| e.to_string())?;

    if let Ok(safe_dup) = SafePath::resolve(&root, &meta.path) {
        if let Ok(content) = std::fs::read_to_string(safe_dup.as_path()) {
            let hash = flint_core::hash_bytes(content.as_bytes());
            record_suppressed_write(&state.suppressed_writes, &meta.path, Some(hash));
            if let Ok(mut lock) = state.index.write() {
                lock.insert_or_update_note(&root, &safe_dup, &content);
            }
        }
    }

    Ok(meta)
}

/// Delete a note (to OS trash by default, or permanently if permanent: true) (SPEC §10.3, §11, M4).
#[tauri::command]
fn note_delete(
    path: String,
    permanent: Option<bool>,
    state: State<AppState>,
) -> Result<(), String> {
    let root = get_workspace_root(&state)?;
    let safe_path = SafePath::resolve(&root, &path).map_err(|e| e.to_string())?;
    delete_path(&root, &safe_path, permanent.unwrap_or(false)).map_err(|e| e.to_string())?;

    if let Ok(mut lock) = state.index.write() {
        lock.remove_note(Some(&root), &safe_path.to_posix_string());
    }

    Ok(())
}

/// Create a new folder at path (SPEC §11, M4).
#[tauri::command]
fn folder_create(path: String, state: State<AppState>) -> Result<(), String> {
    let root = get_workspace_root(&state)?;
    let safe_path = SafePath::resolve(&root, &path).map_err(|e| e.to_string())?;
    create_folder(&root, &safe_path).map_err(|e| e.to_string())
}

/// Delete a folder (to OS trash by default, or permanently if permanent: true) (SPEC §11, M4).
#[tauri::command]
fn folder_delete(
    path: String,
    permanent: Option<bool>,
    state: State<AppState>,
) -> Result<(), String> {
    let root = get_workspace_root(&state)?;
    let safe_path = SafePath::resolve(&root, &path).map_err(|e| e.to_string())?;
    delete_folder(&root, &safe_path, permanent.unwrap_or(false)).map_err(|e| e.to_string())
}

/// Reveal a file or folder in the OS file manager (macOS Finder, Linux file manager, Windows Explorer) (SPEC §11, M4).
#[tauri::command]
fn reveal_in_file_manager(path: String, state: State<AppState>) -> Result<(), String> {
    let root = get_workspace_root(&state)?;
    let safe_path = SafePath::resolve(&root, &path).map_err(|e| e.to_string())?;
    let abs_path = safe_path.as_path();

    #[cfg(target_os = "macos")]
    {
        Command::new("open")
            .arg("-R")
            .arg(abs_path)
            .spawn()
            .map_err(|e| e.to_string())?;
    }

    #[cfg(target_os = "windows")]
    {
        Command::new("explorer")
            .arg(format!("/select,\"{}\"", abs_path.display()))
            .spawn()
            .map_err(|e| e.to_string())?;
    }

    #[cfg(target_os = "linux")]
    {
        let parent = abs_path.parent().unwrap_or(abs_path);
        Command::new("xdg-open")
            .arg(parent)
            .spawn()
            .map_err(|e| e.to_string())?;
    }

    Ok(())
}

/// Render a note's Markdown content to sanitized HTML and outline (SPEC §8.4, §11, M5).
#[tauri::command]
fn note_render(
    path: String,
    content: Option<String>,
    theme: Option<String>,
    state: State<AppState>,
) -> Result<RenderResult, String> {
    let root = get_workspace_root(&state)?;
    let theme_str = theme.unwrap_or_else(|| "dark".to_string());

    let raw_content = match content {
        Some(c) => c,
        None => {
            let safe_path = SafePath::resolve(&root, &path).map_err(|e| e.to_string())?;
            let note = read_note(&root, &safe_path).map_err(|e| e.to_string())?;
            note.content
        }
    };

    let markdown_cfg = flint_core::config_get(&root, None)
        .ok()
        .and_then(|r| serde_json::from_value::<flint_core::config::FlintConfig>(r.config).ok())
        .map(|c| c.markdown);
    let wikilinks_enabled = markdown_cfg.as_ref().map(|m| m.wikilinks).unwrap_or(false);
    let features = markdown_cfg
        .map(|m| flint_core::render::MarkdownFeatures {
            math: m.math,
            tables: m.tables,
            footnotes: m.footnotes,
            smart_punctuation: m.smart_punctuation,
        })
        .unwrap_or_default();
    let filename_stems = state
        .index
        .read()
        .map(|lock| lock.filename_stems.clone())
        .unwrap_or_default();

    let result = flint_core::render::render_note_markdown_with_features(
        &raw_content,
        &theme_str,
        Some(&root),
        Some(&path),
        wikilinks_enabled,
        features,
        Some(&filename_stems),
    );
    Ok(result)
}

/// Retrieve all outgoing links from a note (SPEC §11, M6).
#[tauri::command]
fn links_outgoing(
    path: String,
    content: Option<String>,
    state: State<AppState>,
) -> Result<Vec<flint_core::Link>, String> {
    let root = get_workspace_root(&state)?;
    let safe_path = SafePath::resolve(&root, &path).map_err(|e| e.to_string())?;
    flint_core::links_outgoing(&root, &safe_path, content.as_deref()).map_err(|e| e.to_string())
}

/// Retrieve backlinks for a note from the in-memory index (SPEC §6.4, §11, M7).
#[tauri::command]
fn links_backlinks(path: String, state: State<AppState>) -> Result<Vec<BacklinkGroup>, String> {
    let lock = state
        .index
        .read()
        .map_err(|e| format!("Index read error: {}", e))?;
    Ok(lock.get_backlinks(&path))
}

/// Retrieve live workspace statistics from the in-memory index (SPEC §6.1, §11, M7).
#[tauri::command]
fn workspace_stats(state: State<AppState>) -> Result<WorkspaceStats, String> {
    let lock = state
        .index
        .read()
        .map_err(|e| format!("Index read error: {}", e))?;
    Ok(lock.get_stats())
}

/// Retrieve all unresolved links across the workspace (M7).
#[tauri::command]
fn index_unresolved(state: State<AppState>) -> Result<Vec<Link>, String> {
    let lock = state
        .index
        .read()
        .map_err(|e| format!("Index read error: {}", e))?;
    Ok(lock.get_unresolved_links())
}

/// Retrieve all indexed notes metadata (M7).
#[tauri::command]
fn index_notes(state: State<AppState>) -> Result<Vec<NoteMeta>, String> {
    let lock = state
        .index
        .read()
        .map_err(|e| format!("Index read error: {}", e))?;
    Ok(lock.get_note_list())
}

/// Search note names and paths fuzzily across the index (SPEC §7, M9).
#[tauri::command]
fn search_names(
    query: String,
    limit: Option<usize>,
    state: State<AppState>,
) -> Result<Vec<flint_core::NameHit>, String> {
    let lock = state
        .index
        .read()
        .map_err(|e| format!("Index read error: {}", e))?;
    Ok(lock.search_names(&query, limit))
}

/// Search note content in parallel with options (SPEC §7, M9).
#[tauri::command]
fn search_content(
    query: String,
    options: Option<flint_core::ContentSearchOptions>,
    state: State<AppState>,
) -> Result<Vec<flint_core::ContentHitGroup>, String> {
    let root = get_workspace_root(&state)?;
    let opts = options.unwrap_or_default();
    flint_core::search_content(&root, &query, &opts)
}

/// Run workspace doctor health diagnostics (SPEC §4, §13, M9).
#[tauri::command]
fn workspace_doctor(state: State<AppState>) -> Result<flint_core::DoctorReport, String> {
    let root = get_workspace_root(&state)?;
    flint_core::check_workspace_health(&root)
}

/// Read config (SPEC §11, §12, M10.1). With `key`: single dotted-path lookup against the merged
/// global+workspace config (`null` if unset). Without `key`: the full merged config, per-path
/// origins, and an optional notice if a config file failed to load and fell back to defaults.
#[tauri::command]
fn config_get(
    key: Option<String>,
    state: State<AppState>,
) -> Result<flint_core::config::ConfigGetResult, String> {
    let root = get_workspace_root(&state)?;
    flint_core::config_get(&root, key.as_deref()).map_err(|e| e.to_string())
}

/// Write a single per-workspace config key to `.flint/config.json` (SPEC §11, §12, M10.1).
#[tauri::command]
fn config_set(key: String, value: serde_json::Value, state: State<AppState>) -> Result<(), String> {
    let root = get_workspace_root(&state)?;
    flint_core::config_set(&root, &key, value).map_err(|e| e.to_string())?;

    // `markdown.wikilinks` (M10.23) gates whether `[[...]]` is parsed as a link at all — keep the
    // live in-memory index in sync immediately rather than waiting for the next periodic rescan.
    if key == "markdown.wikilinks" {
        let enabled = read_wikilinks_enabled(&root);
        if let Ok(mut lock) = state.index.write() {
            lock.set_wikilinks_enabled(enabled, &root);
        }
    }

    Ok(())
}

/// Delete a workspace override for `key`, falling back to the global default (SPEC §11, §12,
/// M10.1). A no-op if the key wasn't overridden.
#[tauri::command]
fn config_reset(key: String, state: State<AppState>) -> Result<(), String> {
    let root = get_workspace_root(&state)?;
    flint_core::config_reset(&root, &key).map_err(|e| e.to_string())
}

/// Validate a list of ignore-glob lines, one result per line: `None` if valid, `Some(message)`
/// if invalid (SPEC §11, §12, M10.1).
#[tauri::command]
fn config_validate_ignore(patterns: Vec<String>) -> Vec<Option<String>> {
    flint_core::validate_ignore_patterns(&patterns)
}

/// Open an external URL in the default system browser (SPEC §6.3, §11, M6).
#[tauri::command]
fn open_external(url: String) -> Result<(), String> {
    let trimmed = url.trim();
    if !trimmed.starts_with("http://")
        && !trimmed.starts_with("https://")
        && !trimmed.starts_with("mailto:")
    {
        return Err(
            "Only http, https, and mailto URLs are supported for external open".to_string(),
        );
    }

    #[cfg(target_os = "macos")]
    {
        Command::new("open")
            .arg(trimmed)
            .spawn()
            .map_err(|e| e.to_string())?;
    }

    #[cfg(target_os = "windows")]
    {
        Command::new("cmd")
            .args(["/c", "start", "", trimmed])
            .spawn()
            .map_err(|e| e.to_string())?;
    }

    #[cfg(target_os = "linux")]
    {
        Command::new("xdg-open")
            .arg(trimmed)
            .spawn()
            .map_err(|e| e.to_string())?;
    }

    Ok(())
}

/// Query the local MCP server's current lifecycle state (SPEC-adjacent M10.21 status-bar
/// indicator; also emitted proactively as the `mcp:status` event on every transition).
#[tauri::command]
fn mcp_status(state: State<AppState>) -> McpStatus {
    state.mcp.status()
}

/// Rotate (or, if none exists yet, generate) the MCP server's bearer token without restarting
/// Flint — the only way a token is ever created (M10.21: no auto-generated-at-launch token
/// anymore). This is the practical way to kick out a client. Persisted to `.flint.db`, so it
/// survives restarts.
#[tauri::command]
fn mcp_rotate_token(state: State<AppState>) -> Result<String, String> {
    state.mcp.rotate_token()
}

/// Read the local MCP server's currently-generated token, if any, without rotating it — lets
/// Settings redisplay an already-generated token (e.g. after reopening the panel or restarting
/// the app) without invalidating whatever client already has it configured.
#[tauri::command]
fn mcp_get_token(state: State<AppState>) -> Result<Option<String>, String> {
    let root = get_workspace_root(&state)?;
    flint_core::config::get_mcp_token(&root)
        .map(|record| record.map(|r| r.token))
        .map_err(|e| e.to_string())
}

pub fn build_app(
    builder: tauri::Builder<tauri::Wry>,
    initial_path: Option<PathBuf>,
    initial_note: Option<String>,
) -> tauri::Builder<tauri::Wry> {
    build_app_with_mcp_flags(builder, initial_path, initial_note, false, false)
}

/// Same as [`build_app`], but lets the CLI's `--mcp`/`--mcp-auth` flags force the local MCP
/// server on (and its auth enforcement on) for this launch regardless of the workspace's
/// `mcp.enabled`/`mcp.requireAuth` config (M10.21).
pub fn build_app_with_mcp_flags(
    builder: tauri::Builder<tauri::Wry>,
    initial_path: Option<PathBuf>,
    initial_note: Option<String>,
    mcp_flag: bool,
    mcp_auth_flag: bool,
) -> tauri::Builder<tauri::Wry> {
    let state = AppState {
        active_workspace: Mutex::new(initial_path),
        pending_initial_note: Mutex::new(initial_note),
        index: Arc::new(RwLock::new(Index::new())),
        suppressed_writes: Arc::new(Mutex::new(HashMap::new())),
        watcher_stop: Arc::new(AtomicBool::new(false)),
        mcp: Arc::new(McpHandle::default()),
        mcp_cli_override: mcp_flag,
        mcp_auth_cli_override: mcp_auth_flag,
    };
    builder
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .manage(state)
        .invoke_handler(tauri::generate_handler![
            workspace_open,
            workspace_tree,
            workspace_stats,
            links_backlinks,
            index_unresolved,
            index_notes,
            search_names,
            search_content,
            workspace_doctor,
            note_read,
            note_write,
            frontmatter_set,
            note_create,
            templates_list,
            daily_note_open,
            template_create,
            template_variables_get,
            template_variables_set,
            template_body_get,
            template_body_set,
            resolve_new_note_variables,
            folder_variables_get,
            folder_variables_set,
            note_rename,
            tag_rename,
            note_duplicate,
            note_delete,
            folder_create,
            folder_delete,
            reveal_in_file_manager,
            note_render,
            links_outgoing,
            open_external,
            choose_folder,
            recent_workspaces,
            config_get,
            config_set,
            config_reset,
            config_validate_ignore,
            mcp_status,
            mcp_rotate_token,
            mcp_get_token
        ])
}

pub fn run_with_context(
    context: tauri::Context<tauri::Wry>,
    initial_path: Option<PathBuf>,
    initial_note: Option<String>,
) {
    run_with_context_and_mcp_flags(context, initial_path, initial_note, false, false)
}

/// Same as [`run_with_context`], but forwards the CLI's `--mcp`/`--mcp-auth` flags (M10.21).
pub fn run_with_context_and_mcp_flags(
    context: tauri::Context<tauri::Wry>,
    initial_path: Option<PathBuf>,
    initial_note: Option<String>,
    mcp_flag: bool,
    mcp_auth_flag: bool,
) {
    build_app_with_mcp_flags(
        tauri::Builder::default(),
        initial_path,
        initial_note,
        mcp_flag,
        mcp_auth_flag,
    )
    .run(context)
    .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_suppression_with_content_hash() {
        let suppressed = Arc::new(Mutex::new(HashMap::new()));
        let path = "test/note.md";
        let hash = "hash123";

        record_suppressed_write(&suppressed, path, Some(hash.to_string()));

        // External write with different hash should NOT be suppressed
        assert!(!is_suppressed_write(
            &suppressed,
            path,
            Some("external_hash")
        ));

        // Write with matching hash should be suppressed
        assert!(is_suppressed_write(&suppressed, path, Some("hash123")));

        // After suppression consumed, subsequent write is not suppressed
        assert!(!is_suppressed_write(&suppressed, path, Some("hash123")));
    }

    #[test]
    fn test_failed_write_does_not_suppress_follow_up() {
        let suppressed = Arc::new(Mutex::new(HashMap::new()));
        let path = "test/note.md";

        // If write fails before recording, suppressed map is empty
        assert!(!is_suppressed_write(&suppressed, path, Some("any_hash")));
    }

    // M10.26: template resolution + daily-note date math.

    #[test]
    fn new_note_content_renders_named_template() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        std::fs::create_dir_all(root.join(".flint/templates")).unwrap();
        std::fs::write(
            root.join(".flint/templates/daily.md"),
            "# {{title}}\nAt {{path}}",
        )
        .unwrap();

        let content =
            resolve_new_note_content(root, "notes/hello.md", "hello", Some("daily.md")).unwrap();
        assert_eq!(content, "# hello\nAt notes/hello.md");
    }

    #[test]
    fn new_note_content_strips_the_templates_own_front_matter() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let vars = sample_vars();
        let (safe_path, content, _) =
            create_template_file(root, "Daily", &vars, "# {{title}}\nAt {{path}}").unwrap();
        create_note(root, &safe_path, Some(&content)).unwrap();
        assert!(content.contains(flint_core::TEMPLATE_VARIABLES_FIELD));

        let note_content =
            resolve_new_note_content(root, "notes/hello.md", "hello", Some("daily.md")).unwrap();
        assert_eq!(note_content, "# hello\nAt notes/hello.md");
        assert!(!note_content.contains(flint_core::TEMPLATE_VARIABLES_FIELD));
        assert!(!note_content.contains("---"));
    }

    #[test]
    fn new_note_content_rejects_template_escaping_workspace() {
        let dir = tempfile::tempdir().unwrap();
        let err = resolve_new_note_content(dir.path(), "n.md", "n", Some("../../etc/passwd"))
            .unwrap_err();
        assert!(!err.is_empty());
    }

    #[test]
    fn new_note_content_defaults_to_empty_without_template_or_heading() {
        let dir = tempfile::tempdir().unwrap();
        let content = resolve_new_note_content(dir.path(), "n.md", "n", None).unwrap();
        assert_eq!(content, "");
    }

    #[test]
    fn new_note_content_inserts_heading_when_configured() {
        let dir = tempfile::tempdir().unwrap();
        flint_core::config_set(dir.path(), "newNote.insertHeading", serde_json::json!(true))
            .unwrap();
        let content = resolve_new_note_content(dir.path(), "n.md", "My Note", None).unwrap();
        assert_eq!(content, "# My Note\n");
    }

    #[test]
    fn daily_note_date_defaults_to_today() {
        let today = chrono::NaiveDate::from_ymd_opt(2026, 9, 28).unwrap();
        assert_eq!(
            resolve_daily_note_target_date(today, None, None).unwrap(),
            today
        );
    }

    #[test]
    fn daily_note_date_offset_crosses_month_boundary() {
        let today = chrono::NaiveDate::from_ymd_opt(2026, 3, 1).unwrap();
        assert_eq!(
            resolve_daily_note_target_date(today, Some(-1), None).unwrap(),
            chrono::NaiveDate::from_ymd_opt(2026, 2, 28).unwrap()
        );
    }

    #[test]
    fn daily_note_date_offset_crosses_year_boundary() {
        let today = chrono::NaiveDate::from_ymd_opt(2025, 12, 31).unwrap();
        assert_eq!(
            resolve_daily_note_target_date(today, Some(1), None).unwrap(),
            chrono::NaiveDate::from_ymd_opt(2026, 1, 1).unwrap()
        );
    }

    #[test]
    fn daily_note_explicit_date_wins_over_offset() {
        let today = chrono::NaiveDate::from_ymd_opt(2026, 1, 1).unwrap();
        assert_eq!(
            resolve_daily_note_target_date(today, Some(5), Some("2026-06-15")).unwrap(),
            chrono::NaiveDate::from_ymd_opt(2026, 6, 15).unwrap()
        );
    }

    #[test]
    fn daily_note_invalid_date_is_rejected() {
        let today = chrono::NaiveDate::from_ymd_opt(2026, 1, 1).unwrap();
        assert!(resolve_daily_note_target_date(today, None, Some("not-a-date")).is_err());
    }

    // -- M10.27: template authoring / variables IPC integration tests --------------------------

    fn sample_vars() -> Vec<flint_core::TemplateVariableDef> {
        vec![
            flint_core::TemplateVariableDef {
                name: "project".to_string(),
                kind: flint_core::TemplateVariableKind::Text,
                default: String::new(),
                required: true,
                options: Vec::new(),
            },
            flint_core::TemplateVariableDef {
                name: "priority".to_string(),
                kind: flint_core::TemplateVariableKind::Choice,
                default: "Low".to_string(),
                required: false,
                options: vec!["Low".to_string(), "High".to_string()],
            },
        ]
    }

    #[test]
    fn template_create_writes_schema_and_authored_body() {
        let dir = tempfile::tempdir().unwrap();
        let vars = sample_vars();
        let body = "# {{title}}\n\n## {{var:project}}\n\n## {{var:priority}}\n\n";
        let (safe_path, content, meta) =
            create_template_file(dir.path(), "Meeting Notes", &vars, body).unwrap();
        assert_eq!(meta.path, "meeting-notes.md");
        assert_eq!(meta.name, "Meeting Notes");
        assert!(content.contains("{{title}}"));
        assert!(content.contains("{{var:project}}"));
        assert!(content.contains("{{var:priority}}"));
        assert!(content.contains(flint_core::TEMPLATE_VARIABLES_FIELD));

        create_note(dir.path(), &safe_path, Some(&content)).unwrap();
        let round_tripped = load_template_variables(dir.path(), "meeting-notes.md").unwrap();
        assert_eq!(round_tripped, vars);
    }

    #[test]
    fn template_create_rejects_name_with_no_letters_or_digits() {
        let dir = tempfile::tempdir().unwrap();
        let err = create_template_file(dir.path(), "***", &[], "").unwrap_err();
        assert!(!err.is_empty());
    }

    #[test]
    fn template_variables_set_rewrites_only_the_schema_field() {
        let dir = tempfile::tempdir().unwrap();
        let (safe_path, content, _) =
            create_template_file(dir.path(), "Plain", &[], "# {{title}}\n\n").unwrap();
        create_note(dir.path(), &safe_path, Some(&content)).unwrap();

        let new_vars = sample_vars();
        let current = std::fs::read_to_string(safe_path.as_path()).unwrap();
        let new_content = set_front_matter_fields(
            &current,
            &[(
                flint_core::TEMPLATE_VARIABLES_FIELD.to_string(),
                flint_core::serialize_template_variables(&new_vars),
            )],
        );
        std::fs::write(safe_path.as_path(), &new_content).unwrap();

        let round_tripped = load_template_variables(dir.path(), "plain.md").unwrap();
        assert_eq!(round_tripped, new_vars);
        // Body (the `{{title}}` starter line) survives the field-only rewrite untouched.
        assert!(new_content.contains("{{title}}"));
    }

    #[test]
    fn load_template_body_returns_content_after_front_matter() {
        let dir = tempfile::tempdir().unwrap();
        let (safe_path, content, _) =
            create_template_file(dir.path(), "Plain", &[], "# {{title}}\n\nBody text.\n").unwrap();
        create_note(dir.path(), &safe_path, Some(&content)).unwrap();

        let body = load_template_body(dir.path(), "plain.md").unwrap();
        assert_eq!(body, "# {{title}}\n\nBody text.\n");
    }

    #[test]
    fn template_body_set_rewrites_only_the_body_field_untouched() {
        let dir = tempfile::tempdir().unwrap();
        let vars = sample_vars();
        let (safe_path, content, _) =
            create_template_file(dir.path(), "Plain", &vars, "# {{title}}\n\nOld body.\n").unwrap();
        create_note(dir.path(), &safe_path, Some(&content)).unwrap();

        let current = std::fs::read_to_string(safe_path.as_path()).unwrap();
        let new_content = flint_core::set_note_body(&current, "# {{title}}\n\nNew body.\n");
        std::fs::write(safe_path.as_path(), &new_content).unwrap();

        let body = load_template_body(dir.path(), "plain.md").unwrap();
        assert_eq!(body, "# {{title}}\n\nNew body.\n");
        // The schema field survives the body-only rewrite untouched.
        let round_tripped = load_template_variables(dir.path(), "plain.md").unwrap();
        assert_eq!(round_tripped, vars);
    }

    #[test]
    fn resolve_new_note_variables_returns_empty_for_no_template() {
        let dir = tempfile::tempdir().unwrap();
        let result = resolve_new_note_variables_impl(dir.path(), None, None).unwrap();
        assert!(result.is_empty());
    }

    #[test]
    fn resolve_new_note_variables_precedence_end_to_end() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let vars = sample_vars();
        let (safe_path, content, _) =
            create_template_file(root, "Client Note", &vars, "# {{title}}\n\n").unwrap();
        create_note(root, &safe_path, Some(&content)).unwrap();

        // Global scope sets "project"; folder scope (nearest ancestor) overrides it for notes
        // created under "clients/acme".
        flint_core::config_set(
            root,
            "templates.globalVariables",
            serde_json::json!({"project": "Global Co"}),
        )
        .unwrap();
        flint_core::config_set(
            root,
            &flint_core::config::folder_variables_key("clients/acme"),
            serde_json::json!({"project": "Acme Corp"}),
        )
        .unwrap();

        let resolved =
            resolve_new_note_variables_impl(root, Some("client-note.md"), Some("clients/acme"))
                .unwrap();
        let project = resolved.iter().find(|r| r.def.name == "project").unwrap();
        assert_eq!(project.resolved_default, "Acme Corp");

        // A folder with no scope of its own falls back to the global value.
        let resolved_elsewhere =
            resolve_new_note_variables_impl(root, Some("client-note.md"), Some("other/folder"))
                .unwrap();
        let project_elsewhere = resolved_elsewhere
            .iter()
            .find(|r| r.def.name == "project")
            .unwrap();
        assert_eq!(project_elsewhere.resolved_default, "Global Co");

        // The Choice variable with no override anywhere falls back to its own schema default.
        let priority = resolved.iter().find(|r| r.def.name == "priority").unwrap();
        assert_eq!(priority.resolved_default, "Low");
    }

    #[test]
    fn note_create_with_variables_renders_without_recording_them() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        std::fs::create_dir_all(root.join(".flint/templates")).unwrap();
        std::fs::write(
            root.join(".flint/templates/project.md"),
            "# {{title}}\n\nProject: {{var:project}}\n",
        )
        .unwrap();

        let mut variables = HashMap::new();
        variables.insert("project".to_string(), "Flint".to_string());
        let content = resolve_new_note_content_with_variables(
            root,
            "notes/n.md",
            "n",
            Some("project.md"),
            &variables,
        )
        .unwrap();

        assert!(content.contains("Project: Flint"));
        assert!(!content.contains("templateVars"));
        assert!(!content.starts_with("---"));
    }

    #[test]
    fn note_create_carries_template_front_matter_but_not_variable_schema() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        std::fs::create_dir_all(root.join(".flint/templates")).unwrap();
        std::fs::write(
            root.join(".flint/templates/task.md"),
            "---\ntemplateVariables: '[]'\nstatus: draft\ntags:\n- todo\n---\n# {{title}}\n",
        )
        .unwrap();

        let content = resolve_new_note_content_with_variables(
            root,
            "n.md",
            "n",
            Some("task.md"),
            &HashMap::new(),
        )
        .unwrap();

        assert!(content.contains("status: draft"));
        assert!(content.contains("- todo"));
        assert!(content.contains("# n"));
        assert!(!content.contains("templateVariables"));
    }
}
