use clap::{Parser, Subcommand};
use flint_core::{
    bootstrap_workspace, build_workspace_tree, resolve_workspace_root, WorkspaceError,
};
use std::env;
use std::fs;
use std::path::PathBuf;
use std::process::ExitCode;

/// Exit codes per SPEC §4.2:
/// 0 success
/// 1 generic failure
/// 2 bad usage
/// 3 workspace not found or not a directory
/// 4 permission denied
/// 5 note not found
pub mod exit_codes {
    pub const SUCCESS: u8 = 0;
    pub const GENERIC_FAILURE: u8 = 1;
    #[allow(dead_code)]
    pub const BAD_USAGE: u8 = 2;
    pub const WORKSPACE_NOT_FOUND: u8 = 3;
    pub const PERMISSION_DENIED: u8 = 4;
    pub const NOTE_NOT_FOUND: u8 = 5;
}

#[derive(Parser, Debug)]
#[command(
    name = "flint",
    version,
    about = "Flint — local-first Markdown knowledge workspace"
)]
pub struct Cli {
    /// Workspace directory to open (default: ".")
    #[arg(value_name = "PATH")]
    pub path: Option<PathBuf>,

    /// Override workspace path resolution
    #[arg(long, value_name = "PATH", global = true)]
    pub workspace: Option<PathBuf>,

    /// Do not open the GUI window
    #[arg(long, global = true)]
    pub no_open: bool,

    /// Machine-readable JSON output
    #[arg(long, global = true)]
    pub json: bool,

    /// Log level filter (error, warn, info, debug, trace)
    #[arg(long, default_value = "info", global = true)]
    pub log: String,

    #[command(subcommand)]
    pub command: Option<Commands>,
}

#[derive(Subcommand, Debug)]
pub enum Commands {
    /// Create .flint/ and a starter note, do not open the GUI
    Init {
        #[arg(value_name = "PATH")]
        path: Option<PathBuf>,
    },
    /// Create a note relative to the workspace
    New {
        #[arg(value_name = "NOTE")]
        note: String,
        #[arg(long)]
        open: bool,
    },
    /// Print matching notes to stdout
    Search {
        #[arg(value_name = "QUERY")]
        query: String,
    },
    /// Print note paths, one per line
    List {
        #[arg(long, value_name = "DIR")]
        folder: Option<String>,
    },
    /// Report workspace health: broken links, orphans, unreadable files
    Doctor,
    /// Print workspace path, note count, link count, config location
    Info,
}

fn run() -> Result<u8, (u8, String)> {
    let cli = Cli::parse();
    let current_dir = env::current_dir().map_err(|e| {
        (
            exit_codes::GENERIC_FAILURE,
            format!("Failed to determine current directory: {}", e),
        )
    })?;
    let env_var = env::var("FLINT_WORKSPACE").ok();

    match cli.command {
        Some(Commands::Init { path }) => {
            let default_path = std::path::Path::new(".");
            let target = path
                .as_deref()
                .or(cli.workspace.as_deref())
                .unwrap_or(default_path);

            let target_abs = if target.is_relative() {
                current_dir.join(target)
            } else {
                target.to_path_buf()
            };

            if !target_abs.exists() {
                fs::create_dir_all(&target_abs).map_err(|e| {
                    (
                        exit_codes::PERMISSION_DENIED,
                        format!("Failed to create workspace directory: {}", e),
                    )
                })?;
            }

            let canonical = target_abs.canonicalize().map_err(|e| {
                (
                    exit_codes::GENERIC_FAILURE,
                    format!("Failed to canonicalize path: {}", e),
                )
            })?;

            if !canonical.is_dir() {
                return Err((
                    exit_codes::WORKSPACE_NOT_FOUND,
                    format!("Target is not a directory: {}", canonical.display()),
                ));
            }

            let config_path = bootstrap_workspace(&canonical).map_err(|e| {
                (
                    exit_codes::PERMISSION_DENIED,
                    format!("Failed to bootstrap workspace: {}", e),
                )
            })?;

            // Create starter note if workspace has no notes
            let starter_note = canonical.join("welcome.md");
            if !starter_note.exists() {
                let starter_content = format!(
                    "# Welcome to {}\n\nThis is your starter note. All your notes remain plain Markdown files on disk.\n",
                    canonical.file_name().and_then(|s| s.to_str()).unwrap_or("Flint")
                );
                let _ = fs::write(&starter_note, starter_content);
            }

            if cli.json {
                println!(
                    "{}",
                    serde_json::json!({
                        "status": "initialized",
                        "workspace": canonical.display().to_string(),
                        "config": config_path.display().to_string()
                    })
                );
            } else {
                println!("Initialized Flint workspace at: {}", canonical.display());
            }
            Ok(exit_codes::SUCCESS)
        }
        Some(Commands::Info) => {
            let ws_root = resolve_workspace_root(
                cli.path.as_deref(),
                cli.workspace.as_deref(),
                env_var.as_deref(),
                &current_dir,
            )
            .map_err(map_ws_error)?;

            let config_path = ws_root.join(".flint/config.json");
            let tree = build_workspace_tree(&ws_root, false).map_err(map_ws_error)?;

            let mut note_count = 0;
            fn count_notes(items: &[flint_core::TreeNodeItem]) -> usize {
                let mut count = 0;
                for item in items {
                    if item.is_note == Some(true) {
                        count += 1;
                    }
                    if let Some(children) = &item.children {
                        count += count_notes(children);
                    }
                }
                count
            }
            note_count += count_notes(&tree);

            if cli.json {
                println!(
                    "{}",
                    serde_json::json!({
                        "workspace": ws_root.display().to_string(),
                        "note_count": note_count,
                        "link_count": 0,
                        "config": config_path.display().to_string()
                    })
                );
            } else {
                println!("Workspace: {}", ws_root.display());
                println!("Notes:     {}", note_count);
                println!("Links:     0");
                println!("Config:    {}", config_path.display());
            }
            Ok(exit_codes::SUCCESS)
        }
        Some(Commands::New { note, open }) => {
            let ws_root = resolve_workspace_root(
                cli.path.as_deref(),
                cli.workspace.as_deref(),
                env_var.as_deref(),
                &current_dir,
            )
            .map_err(map_ws_error)?;

            let safe_target = flint_core::resolve_in_workspace(&ws_root, &note).map_err(|e| {
                (
                    exit_codes::GENERIC_FAILURE,
                    format!("Invalid note path: {}", e),
                )
            })?;

            if let Some(parent) = safe_target.parent() {
                let _ = fs::create_dir_all(parent);
            }

            let initial_content = format!(
                "# {}\n\n",
                safe_target
                    .file_stem()
                    .and_then(|s| s.to_str())
                    .unwrap_or("Untitled")
            );
            fs::write(&safe_target, initial_content).map_err(|e| {
                (
                    exit_codes::PERMISSION_DENIED,
                    format!("Failed to create note: {}", e),
                )
            })?;

            if cli.json {
                println!(
                    "{}",
                    serde_json::json!({
                        "status": "created",
                        "note": safe_target.display().to_string(),
                        "open": open
                    })
                );
            } else {
                println!("Created note: {}", safe_target.display());
            }
            Ok(exit_codes::SUCCESS)
        }
        Some(Commands::Search { query }) => {
            let ws_root = resolve_workspace_root(
                cli.path.as_deref(),
                cli.workspace.as_deref(),
                env_var.as_deref(),
                &current_dir,
            )
            .map_err(map_ws_error)?;

            let opts = flint_core::ContentSearchOptions::default();
            let results = flint_core::search_content(&ws_root, &query, &opts)
                .map_err(|e| (exit_codes::GENERIC_FAILURE, format!("Search failed: {}", e)))?;

            if cli.json {
                println!(
                    "{}",
                    serde_json::to_string(&results).map_err(|e| {
                        (
                            exit_codes::GENERIC_FAILURE,
                            format!("JSON serialization error: {}", e),
                        )
                    })?
                );
            } else {
                for group in &results {
                    for hit in &group.matches {
                        println!("{}:{}:{}", group.path, hit.line, hit.line_text);
                    }
                }
            }
            Ok(exit_codes::SUCCESS)
        }
        Some(Commands::List { folder }) => {
            let ws_root = resolve_workspace_root(
                cli.path.as_deref(),
                cli.workspace.as_deref(),
                env_var.as_deref(),
                &current_dir,
            )
            .map_err(map_ws_error)?;

            let tree = build_workspace_tree(&ws_root, false).map_err(map_ws_error)?;

            fn list_notes(
                items: &[flint_core::TreeNodeItem],
                filter_folder: Option<&str>,
                acc: &mut Vec<String>,
            ) {
                for item in items {
                    if item.is_note == Some(true) {
                        if let Some(folder_prefix) = filter_folder {
                            let clean_prefix = folder_prefix.trim().trim_matches('/');
                            if item.path.starts_with(clean_prefix) {
                                acc.push(item.path.clone());
                            }
                        } else {
                            acc.push(item.path.clone());
                        }
                    }
                    if let Some(children) = &item.children {
                        list_notes(children, filter_folder, acc);
                    }
                }
            }

            let mut notes = Vec::new();
            list_notes(&tree, folder.as_deref(), &mut notes);

            if cli.json {
                println!("{}", serde_json::to_string(&notes).unwrap_or_default());
            } else {
                for n in notes {
                    println!("{}", n);
                }
            }
            Ok(exit_codes::SUCCESS)
        }
        Some(Commands::Doctor) => {
            let ws_root = resolve_workspace_root(
                cli.path.as_deref(),
                cli.workspace.as_deref(),
                env_var.as_deref(),
                &current_dir,
            )
            .map_err(map_ws_error)?;

            let report = flint_core::check_workspace_health(&ws_root)
                .map_err(|e| (exit_codes::GENERIC_FAILURE, format!("Doctor failed: {}", e)))?;

            if cli.json {
                println!(
                    "{}",
                    serde_json::to_string(&report).map_err(|e| {
                        (
                            exit_codes::GENERIC_FAILURE,
                            format!("JSON serialization error: {}", e),
                        )
                    })?
                );
            } else {
                println!("Workspace health report for {}", report.workspace);
                if report.broken_links.is_empty() {
                    println!("✓ 0 broken links");
                } else {
                    println!("✗ {} broken link(s):", report.broken_links.len());
                    for bl in &report.broken_links {
                        println!("  - in {}:{} -> {}", bl.source, bl.line, bl.raw_target);
                    }
                }

                if report.orphan_notes.is_empty() {
                    println!("✓ 0 orphan notes");
                } else {
                    println!("! {} orphan note(s):", report.orphan_notes.len());
                    for o in &report.orphan_notes {
                        println!("  - {}", o);
                    }
                }

                if report.unreadable_files.is_empty() {
                    println!("✓ 0 unreadable files");
                } else {
                    println!("✗ {} unreadable file(s):", report.unreadable_files.len());
                    for u in &report.unreadable_files {
                        println!("  - {}", u);
                    }
                }
            }
            Ok(exit_codes::SUCCESS)
        }
        None => {
            // Default: open GUI or resolve workspace
            let ws_root = resolve_workspace_root(
                cli.path.as_deref(),
                cli.workspace.as_deref(),
                env_var.as_deref(),
                &current_dir,
            )
            .map_err(map_ws_error)?;

            let _ = bootstrap_workspace(&ws_root);

            if cli.no_open {
                if cli.json {
                    println!(
                        "{}",
                        serde_json::json!({
                            "status": "ready",
                            "workspace": ws_root.display().to_string()
                        })
                    );
                } else {
                    println!("Workspace ready at: {}", ws_root.display());
                }
            } else {
                if cli.json {
                    println!(
                        "{}",
                        serde_json::json!({
                            "status": "launching_gui",
                            "workspace": ws_root.display().to_string()
                        })
                    );
                } else {
                    println!("Opening workspace at: {}", ws_root.display());
                }
                flint_app_lib::run_with_workspace(Some(ws_root));
            }
            Ok(exit_codes::SUCCESS)
        }
    }
}

fn map_ws_error(err: WorkspaceError) -> (u8, String) {
    match err {
        WorkspaceError::NotFound(p) => (
            exit_codes::WORKSPACE_NOT_FOUND,
            format!("Workspace not found: {}", p.display()),
        ),
        WorkspaceError::NotADirectory(p) => (
            exit_codes::WORKSPACE_NOT_FOUND,
            format!("Workspace is not a directory: {}", p.display()),
        ),
        WorkspaceError::PermissionDenied(s) => (
            exit_codes::PERMISSION_DENIED,
            format!("Permission denied: {}", s),
        ),
        WorkspaceError::Io(s) => (exit_codes::GENERIC_FAILURE, format!("I/O error: {}", s)),
    }
}

fn main() -> ExitCode {
    match run() {
        Ok(code) => ExitCode::from(code),
        Err((code, msg)) => {
            eprintln!("Error: {}", msg);
            ExitCode::from(code)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn test_resolve_workspace_root_fallbacks() {
        let dir = tempdir().unwrap();
        let root = dir.path();
        let sub = root.join("my-vault");
        fs::create_dir_all(&sub).unwrap();

        // 1. Explicit path
        let res = resolve_workspace_root(Some(&sub), None, None, root);
        assert!(res.is_ok());
        assert_eq!(res.unwrap(), sub.canonicalize().unwrap());

        // 2. Missing path returns NotFound
        let missing = root.join("does-not-exist");
        let res_missing = resolve_workspace_root(Some(&missing), None, None, root);
        assert!(matches!(res_missing, Err(WorkspaceError::NotFound(_))));

        // 3. File as dir returns NotADirectory
        let a_file = root.join("note.md");
        fs::write(&a_file, "# Test").unwrap();
        let res_file = resolve_workspace_root(Some(&a_file), None, None, root);
        assert!(matches!(res_file, Err(WorkspaceError::NotADirectory(_))));
    }
}
