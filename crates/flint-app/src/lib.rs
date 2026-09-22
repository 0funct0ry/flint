use flint_core::{
    bootstrap_workspace, build_workspace_tree, resolve_workspace_root, TreeNodeItem, WorkspaceInfo,
};
use std::env;
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::State;

pub struct AppState {
    pub active_workspace: Mutex<Option<PathBuf>>,
}

impl Default for AppState {
    fn default() -> Self {
        Self {
            active_workspace: Mutex::new(None),
        }
    }
}

/// Open and initialize a workspace directory.
#[tauri::command]
fn workspace_open(path: Option<String>, state: State<AppState>) -> Result<WorkspaceInfo, String> {
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
        *lock = Some(root);
    }

    Ok(info)
}

/// Retrieve the live workspace file tree.
#[tauri::command]
fn workspace_tree(
    show_non_note_files: Option<bool>,
    state: State<AppState>,
) -> Result<Vec<TreeNodeItem>, String> {
    let root = {
        let lock = state
            .active_workspace
            .lock()
            .map_err(|e| format!("Lock error: {}", e))?;
        match lock.as_ref() {
            Some(p) => p.clone(),
            None => {
                let current_dir = env::current_dir().map_err(|e| e.to_string())?;
                resolve_workspace_root(None, None, None, &current_dir).map_err(|e| e.to_string())?
            }
        }
    };

    let show_non_notes = show_non_note_files.unwrap_or(false);
    build_workspace_tree(&root, show_non_notes).map_err(|e| e.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    run_with_workspace(None);
}

pub fn run_with_workspace(initial_path: Option<PathBuf>) {
    let state = AppState {
        active_workspace: Mutex::new(initial_path),
    };
    tauri::Builder::default()
        .manage(state)
        .invoke_handler(tauri::generate_handler![workspace_open, workspace_tree])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
