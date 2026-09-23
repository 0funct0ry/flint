use flint_core::{
    bootstrap_workspace, build_workspace_tree, create_folder, create_note, delete_folder,
    delete_path, duplicate_note, read_note, rename_path, render_note_markdown,
    resolve_workspace_root, write_note_atomic, BacklinkGroup, Fingerprint, Index, Link,
    NoteContent, NoteMeta, RenderResult, SafePath, TreeNodeItem, WorkspaceInfo, WorkspaceStats,
};
use serde::{Deserialize, Serialize};
use std::env;
use std::path::PathBuf;
use std::process::Command;
use std::sync::{Arc, Mutex, RwLock};
use tauri::{AppHandle, Emitter, State};

pub struct AppState {
    pub active_workspace: Mutex<Option<PathBuf>>,
    pub index: Arc<RwLock<Index>>,
}

impl Default for AppState {
    fn default() -> Self {
        Self {
            active_workspace: Mutex::new(None),
            index: Arc::new(RwLock::new(Index::new())),
        }
    }
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

/// Open and initialize a workspace directory with background indexing (SPEC §6.2, §11).
#[tauri::command]
fn workspace_open(
    path: Option<String>,
    app_handle: AppHandle,
    state: State<AppState>,
) -> Result<WorkspaceInfo, String> {
    let current_dir = env::current_dir().map_err(|e| e.to_string())?;
    let path_buf = path.map(PathBuf::from);

    let root = resolve_workspace_root(path_buf.as_deref(), None, None, &current_dir)
        .map_err(|e| e.to_string())?;

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
    let fp = write_note_atomic(&root, &safe_path, &content, fingerprint.as_ref())
        .map_err(|e| e.to_string())?;

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
    let meta = create_note(&root, &safe_path, template.as_deref()).map_err(|e| e.to_string())?;

    // Incremental index update per SPEC §6.2
    if let Ok(mut lock) = state.index.write() {
        let content = template.as_deref().unwrap_or("");
        lock.insert_or_update_note(&root, &safe_path, content);
    }

    Ok(meta)
}

/// Rename/move a note or folder (SPEC §11, M4).
#[tauri::command]
fn note_rename(
    from: String,
    to: String,
    _rewrite_links: Option<bool>,
    state: State<AppState>,
) -> Result<RenameResult, String> {
    let root = get_workspace_root(&state)?;
    let from_safe = SafePath::resolve(&root, &from).map_err(|e| e.to_string())?;
    let to_safe = SafePath::resolve(&root, &to).map_err(|e| e.to_string())?;

    rename_path(&root, &from_safe, &to_safe).map_err(|e| e.to_string())?;

    // Update index on rename
    if let Ok(mut lock) = state.index.write() {
        lock.remove_note(Some(&root), &from_safe.to_posix_string());
        if to_safe.as_path().is_file() {
            if let Ok(content) = std::fs::read_to_string(to_safe.as_path()) {
                lock.insert_or_update_note(&root, &to_safe, &content);
            }
        }
    }

    // Link rewriting is deferred to M8 per PROMPTS.md
    Ok(RenameResult {
        moved: true,
        links_updated: 0,
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    run_with_workspace(None);
}

pub fn run_with_workspace(initial_path: Option<PathBuf>) {
    let state = AppState {
        active_workspace: Mutex::new(initial_path),
        index: Arc::new(RwLock::new(Index::new())),
    };
    tauri::Builder::default()
        .manage(state)
        .invoke_handler(tauri::generate_handler![
            workspace_open,
            workspace_tree,
            workspace_stats,
            links_backlinks,
            index_unresolved,
            index_notes,
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
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
