use flint_core::{
    bootstrap_workspace, build_workspace_tree, create_folder, create_note, delete_folder,
    delete_path, duplicate_note, is_default_ignored, is_note_path, read_note, rename_path,
    render_note_markdown, resolve_workspace_root, rewrite_workspace_links_for_rename,
    to_posix_path, write_note_atomic, BacklinkGroup, Fingerprint, Index, Link, NoteContent,
    NoteMeta, RenderResult, SafePath, TreeNodeItem, WorkspaceInfo, WorkspaceStats,
};
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
    pub index: Arc<RwLock<Index>>,
    pub suppressed_writes: Arc<Mutex<HashMap<String, SuppressedWrite>>>,
    pub watcher_stop: Arc<AtomicBool>,
}

impl Default for AppState {
    fn default() -> Self {
        Self {
            active_workspace: Mutex::new(None),
            index: Arc::new(RwLock::new(Index::new())),
            suppressed_writes: Arc::new(Mutex::new(HashMap::new())),
            watcher_stop: Arc::new(AtomicBool::new(false)),
        }
    }
}

/// Record a path being written by Flint to suppress subsequent watcher event.
fn record_suppressed_write(
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

/// Check if a workspace path should be ignored by the watcher.
fn is_path_ignored(root: &Path, abs_path: &Path) -> bool {
    let file_name = abs_path
        .file_name()
        .map(|s| s.to_string_lossy())
        .unwrap_or_default();
    if file_name.ends_with(".flint-tmp") || file_name.ends_with('~') {
        return true;
    }

    let rel = match abs_path.strip_prefix(root) {
        Ok(r) => r,
        Err(_) => return true,
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
            if let Ok(tree) = build_workspace_tree(&root, true) {
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
                if let Ok(new_index) = Index::build_from_workspace(&root, |_, _| {}) {
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
                        let rel = path.strip_prefix(&root).unwrap_or(&path);
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

    let root = match path_buf {
        Some(explicit) => resolve_workspace_root(Some(&explicit), None, None, &current_dir)
            .map_err(|e| e.to_string())?,
        None => {
            let active_opt = state
                .active_workspace
                .lock()
                .map_err(|e| format!("Lock error: {}", e))?
                .clone();
            match active_opt {
                Some(active) => active,
                None => resolve_workspace_root(None, None, None, &current_dir)
                    .map_err(|e| e.to_string())?,
            }
        }
    };

    // Bootstrap .flint/config.json idempotently
    bootstrap_workspace(&root).map_err(|e| e.to_string())?;

    let name = root
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("workspace")
        .to_string();

    let tree = build_workspace_tree(&root, true).unwrap_or_default();
    let is_empty = tree.is_empty();

    let info = WorkspaceInfo {
        name,
        path: root.display().to_string(),
        is_empty,
    };

    // Stop existing watcher if any
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

        if let Ok(new_index) = build_result {
            let stats = new_index.get_stats();
            if let Ok(mut lock) = index_arc.write() {
                *lock = new_index;
            }
            let _ = app_handle_clone.emit("index:ready", stats);
        }
    });

    // Start new filesystem watcher per SPEC §10.4
    let new_stop = Arc::new(AtomicBool::new(false));
    spawn_filesystem_watcher(
        root,
        app_handle,
        Arc::clone(&state.index),
        Arc::clone(&state.suppressed_writes),
        Arc::clone(&new_stop),
    );

    Ok(info)
}

/// Retrieve the live workspace file tree.
#[tauri::command]
fn workspace_tree(
    show_non_note_files: Option<bool>,
    state: State<AppState>,
) -> Result<Vec<TreeNodeItem>, String> {
    let root = get_workspace_root(&state)?;
    let show_non_notes = show_non_note_files.unwrap_or(false);
    build_workspace_tree(&root, show_non_notes).map_err(|e| e.to_string())
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

/// Create a new note at path and update index (SPEC §11, M4).
#[tauri::command]
fn note_create(
    path: String,
    template: Option<String>,
    state: State<AppState>,
) -> Result<NoteMeta, String> {
    let root = get_workspace_root(&state)?;
    let safe_path = SafePath::resolve(&root, &path).map_err(|e| e.to_string())?;
    let posix = safe_path.to_posix_string();

    let meta = create_note(&root, &safe_path, template.as_deref()).map_err(|e| e.to_string())?;

    let content = template.as_deref().unwrap_or("");
    let hash = flint_core::hash_bytes(content.as_bytes());
    record_suppressed_write(&state.suppressed_writes, &posix, Some(hash));

    // Incremental index update per SPEC §6.2
    if let Ok(mut lock) = state.index.write() {
        lock.insert_or_update_note(&root, &safe_path, content);
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
        if let Ok(summary) = rewrite_workspace_links_for_rename(&root, &moved_notes_map) {
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

    let result = render_note_markdown(&raw_content, &theme_str, Some(&root), Some(&path));
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

pub fn build_app(
    builder: tauri::Builder<tauri::Wry>,
    initial_path: Option<PathBuf>,
) -> tauri::Builder<tauri::Wry> {
    let state = AppState {
        active_workspace: Mutex::new(initial_path),
        index: Arc::new(RwLock::new(Index::new())),
        suppressed_writes: Arc::new(Mutex::new(HashMap::new())),
        watcher_stop: Arc::new(AtomicBool::new(false)),
    };
    builder
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
            note_create,
            note_rename,
            note_duplicate,
            note_delete,
            folder_create,
            folder_delete,
            reveal_in_file_manager,
            note_render,
            links_outgoing,
            open_external
        ])
}

pub fn run_with_context(context: tauri::Context<tauri::Wry>, initial_path: Option<PathBuf>) {
    build_app(tauri::Builder::default(), initial_path)
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
}
