//! `flint-core`: pure logic domain types, indexing, path resolution, and link handling.
//!
//! This crate has zero Tauri or GUI dependencies and can be tested in complete isolation.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::{Component, Path, PathBuf};

/// A workspace-relative POSIX-style note path (e.g. `projects/payments/bbps.md`).
pub type NotePath = String;

/// Metadata associated with a note in the workspace.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct NoteMeta {
    pub path: NotePath,
    pub title: String,
    pub size_bytes: u64,
    pub modified_ms: u64,
    pub headings: Vec<HeadingItem>,
    pub tags: Vec<String>,
}

/// A heading parsed from a note outline.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct HeadingItem {
    pub level: u8,
    pub text: String,
    pub anchor: String,
}

/// A link from a source note pointing to a target note or external URL.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Link {
    pub source: NotePath,
    pub raw_target: String,
    pub resolved: Option<NotePath>,
    pub line: u32,
    pub col: u32,
    pub context: String,
}

/// A group of backlinks originating from a single source note.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BacklinkGroup {
    pub source_path: NotePath,
    pub source_title: String,
    pub folder: String,
    pub occurrences: Vec<BacklinkOccurrence>,
}

/// An individual occurrence of a backlink within a source note.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BacklinkOccurrence {
    pub line: u32,
    pub context: String,
}

/// In-memory index of notes and bidirectional links.
#[derive(Debug, Default, Clone, Serialize, Deserialize)]
pub struct Index {
    pub notes: HashMap<NotePath, NoteMeta>,
    pub links_out: HashMap<NotePath, Vec<Link>>,
    pub links_in: HashMap<NotePath, Vec<Link>>,
}

/// Workspace statistics.
#[derive(Debug, Default, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WorkspaceStats {
    pub note_count: usize,
    pub link_count: usize,
    pub unresolved_count: usize,
}

/// Workspace summary information returned on workspace open.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WorkspaceInfo {
    pub name: String,
    pub path: String,
    pub is_empty: bool,
}

/// A node in the file tree returned across IPC.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TreeNodeItem {
    pub id: String,
    pub name: String,
    pub path: String,
    pub is_folder: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub children: Option<Vec<TreeNodeItem>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub is_note: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
}

/// Error type for path validation (SPEC §10.1).
#[derive(Debug, thiserror::Error, PartialEq, Eq, Clone, Serialize, Deserialize)]
pub enum PathError {
    #[error("Path escapes workspace root: {0}")]
    EscapesRoot(String),
    #[error("Absolute path is forbidden: {0}")]
    AbsolutePath(String),
    #[error("Null byte in path: {0}")]
    NullByte(String),
    #[error("Windows reserved device name in path: {0}")]
    ReservedName(String),
    #[error("Path component exceeds 255 bytes: {0}")]
    ComponentTooLong(String),
    #[error("Empty path component: {0}")]
    EmptyComponent(String),
    #[error("Symlink resolves outside workspace root: {0}")]
    SymlinkEscapesRoot(String),
    #[error("Invalid path: {0}")]
    Invalid(String),
}

/// A safe, validated path guaranteed to resolve within the workspace root.
///
/// This wrapper type ensures that no filesystem-touching command bypasses path validation.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SafePath {
    relative: PathBuf,
    absolute: PathBuf,
}

impl SafePath {
    pub fn resolve(root: &Path, candidate: &str) -> Result<Self, PathError> {
        let abs = resolve_in_workspace(root, candidate)?;
        let rel = abs
            .strip_prefix(root)
            .map_err(|_| PathError::EscapesRoot(candidate.to_string()))?
            .to_path_buf();
        Ok(Self {
            relative: rel,
            absolute: abs,
        })
    }

    pub fn as_path(&self) -> &Path {
        &self.absolute
    }

    pub fn as_relative_path(&self) -> &Path {
        &self.relative
    }

    pub fn to_posix_string(&self) -> String {
        to_posix_path(&self.relative)
    }
}

/// Windows reserved device names (SPEC §10.1).
const WINDOWS_RESERVED_NAMES: &[&str] = &[
    "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8",
    "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
];

/// Resolve and validate a candidate relative path against the workspace root (SPEC §10.1).
///
/// Rejects:
/// - Absolute OS paths (starts with `/`, `\`, or Windows drive letters like `C:`)
/// - `..` escapes that leave root
/// - NUL bytes
/// - Windows reserved device names (e.g. `CON`, `PRN`, `AUX`, `NUL`, `COM1`..`COM9`, `LPT1`..`LPT9`)
/// - Over-long components (> 255 bytes)
/// - Empty components
/// - Symlinks canonicalizing outside root
pub fn resolve_in_workspace(root: &Path, candidate: &str) -> Result<PathBuf, PathError> {
    if candidate.is_empty() {
        return Err(PathError::EmptyComponent(candidate.to_string()));
    }

    // Check for NUL byte
    if candidate.contains('\0') {
        return Err(PathError::NullByte(candidate.to_string()));
    }

    // Check for absolute path indicators
    if candidate.starts_with('/') || candidate.starts_with('\\') {
        return Err(PathError::AbsolutePath(candidate.to_string()));
    }

    // Check Windows drive prefix (e.g. C:)
    let candidate_path = Path::new(candidate);
    if candidate_path.is_absolute() {
        return Err(PathError::AbsolutePath(candidate.to_string()));
    }

    let mut depth: isize = 0;
    let mut normalized_components = Vec::new();

    // Split candidate on both forward and backward slashes
    for raw_part in candidate.split(['/', '\\']) {
        if raw_part.is_empty() {
            // Consecutive slashes or leading/trailing slash -> empty component
            return Err(PathError::EmptyComponent(candidate.to_string()));
        }

        if raw_part.len() > 255 {
            return Err(PathError::ComponentTooLong(raw_part.to_string()));
        }

        // Check Windows reserved names (case-insensitive, check stem before any dot)
        let stem = match raw_part.split_once('.') {
            Some((s, _)) => s,
            None => raw_part,
        };
        for res in WINDOWS_RESERVED_NAMES {
            if stem.eq_ignore_ascii_case(res) {
                return Err(PathError::ReservedName(raw_part.to_string()));
            }
        }

        match raw_part {
            "." => {
                // Current directory - no-op
            }
            ".." => {
                depth -= 1;
                if depth < 0 {
                    return Err(PathError::EscapesRoot(candidate.to_string()));
                }
                normalized_components.pop();
            }
            part => {
                depth += 1;
                normalized_components.push(part);
            }
        }
    }

    // Build the resolved path relative to root
    let mut resolved = root.to_path_buf();
    for comp in normalized_components {
        resolved.push(comp);
    }

    // If root exists on disk and target exists or has symlinks, verify symlink containment
    if root.exists() {
        let canonical_root = root.canonicalize().unwrap_or_else(|_| root.to_path_buf());
        if resolved.exists() {
            if let Ok(canonical_resolved) = resolved.canonicalize() {
                if !canonical_resolved.starts_with(&canonical_root) {
                    return Err(PathError::SymlinkEscapesRoot(candidate.to_string()));
                }
            }
        }
    }

    Ok(resolved)
}

/// Convert a relative Path to a POSIX-style string with forward slashes.
pub fn to_posix_path(path: &Path) -> String {
    path.components()
        .filter_map(|c| match c {
            Component::Normal(s) => s.to_str(),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("/")
}

/// Check if a path is considered a Markdown note (SPEC §5.1).
pub fn is_note_path(path: &Path) -> bool {
    if let Some(ext) = path.extension().and_then(|e| e.to_str()) {
        ext.eq_ignore_ascii_case("md") || ext.eq_ignore_ascii_case("markdown")
    } else {
        false
    }
}

/// Resolve note title following SPEC §5.3:
/// 1. YAML front-matter `title:`
/// 2. First level-1 heading `# ...`
/// 3. Filename stem
pub fn resolve_note_title(content: &str, file_path: &Path) -> String {
    // 1. Check YAML front-matter
    if let Some(rest) = content
        .strip_prefix("---\n")
        .or_else(|| content.strip_prefix("---\r\n"))
    {
        if let Some(end_idx) = rest.find("\n---").or_else(|| rest.find("\r\n---")) {
            let fm_block = &rest[..end_idx];
            for line in fm_block.lines() {
                let trimmed = line.trim();
                if let Some(val) = trimmed.strip_prefix("title:") {
                    let title = val.trim().trim_matches('"').trim_matches('\'').trim();
                    if !title.is_empty() {
                        return title.to_string();
                    }
                }
            }
        }
    }

    // 2. Check first level-1 heading
    for line in content.lines() {
        let trimmed = line.trim();
        if let Some(heading) = trimmed.strip_prefix("# ") {
            let title = heading.trim();
            if !title.is_empty() {
                return title.to_string();
            }
        }
    }

    // 3. Filename stem fallback
    if let Some(stem) = file_path.file_stem().and_then(|s| s.to_str()) {
        return stem.to_string();
    }

    "Untitled".to_string()
}

/// Error type for workspace resolution (SPEC §4.1).
#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum WorkspaceError {
    #[error("Workspace path does not exist: {0}")]
    NotFound(PathBuf),
    #[error("Workspace path is a file, not a directory: {0}")]
    NotADirectory(PathBuf),
    #[error("Permission denied: {0}")]
    PermissionDenied(String),
    #[error("I/O error: {0}")]
    Io(String),
}

/// Resolve workspace path according to SPEC §4.1:
/// 1. Explicit PATH argument, else `--workspace`, else `$FLINT_WORKSPACE`, else current directory.
/// 2. Canonicalize. Follow symlinks at the root only; reject a root that is not a directory.
pub fn resolve_workspace_root(
    explicit: Option<&Path>,
    workspace_flag: Option<&Path>,
    env_var: Option<&str>,
    current_dir: &Path,
) -> Result<PathBuf, WorkspaceError> {
    let target = if let Some(p) = explicit {
        p.to_path_buf()
    } else if let Some(p) = workspace_flag {
        p.to_path_buf()
    } else if let Some(env) = env_var {
        if !env.trim().is_empty() {
            PathBuf::from(env)
        } else {
            current_dir.to_path_buf()
        }
    } else {
        current_dir.to_path_buf()
    };

    let target_abs = if target.is_relative() {
        current_dir.join(target)
    } else {
        target
    };

    if !target_abs.exists() {
        return Err(WorkspaceError::NotFound(target_abs));
    }

    let canonical = target_abs
        .canonicalize()
        .map_err(|e| WorkspaceError::Io(e.to_string()))?;

    if !canonical.is_dir() {
        return Err(WorkspaceError::NotADirectory(canonical));
    }

    Ok(canonical)
}

/// Ensure `<workspace>/.flint/config.json` exists idempotently (SPEC §3.1, §12).
pub fn bootstrap_workspace(root: &Path) -> Result<PathBuf, std::io::Error> {
    let flint_dir = root.join(".flint");
    if !flint_dir.exists() {
        fs::create_dir_all(&flint_dir)?;
    }
    let config_path = flint_dir.join("config.json");
    if !config_path.exists() {
        let default_config = serde_json::json!({
            "version": 1,
            "theme": "system",
            "editor": {
                "fontSize": 14,
                "fontFamily": "IBM Plex Mono",
                "softWrap": true,
                "tabSize": 2,
                "showLineNumbers": false,
                "vimMode": false
            },
            "markdown": {
                "math": true,
                "tables": true,
                "footnotes": true,
                "smartPunctuation": true
            },
            "behaviour": {
                "autosaveMs": 400,
                "rewriteLinksOnRename": true,
                "deleteToTrash": true,
                "newNoteFolder": "",
                "defaultMode": "edit"
            },
            "ui": {
                "leftSidebar": "tree",
                "rightSidebarVisible": true,
                "showNonNoteFiles": false
            },
            "ignore": ["node_modules/**", ".obsidian/**"]
        });
        fs::write(&config_path, serde_json::to_string_pretty(&default_config)?)?;
    }
    Ok(config_path)
}

/// Check if a path component is ignored by Flint's standard ignore rules (SPEC §5.2).
pub fn is_default_ignored(name: &str) -> bool {
    name == ".flint"
        || name == ".git"
        || name == ".obsidian"
        || name == "node_modules"
        || name == ".DS_Store"
        || name == "Thumbs.db"
        || name.starts_with('.')
}

/// Recursively build the workspace file tree (SPEC §5.2).
///
/// Features:
/// - Respects hidden dotfiles/dotdirs and built-in ignored directories.
/// - Sorts folders first, case-insensitively.
/// - Resolves note titles.
pub fn build_workspace_tree(
    root: &Path,
    show_non_note_files: bool,
) -> Result<Vec<TreeNodeItem>, WorkspaceError> {
    if !root.exists() {
        return Err(WorkspaceError::NotFound(root.to_path_buf()));
    }
    if !root.is_dir() {
        return Err(WorkspaceError::NotADirectory(root.to_path_buf()));
    }

    fn scan_dir(
        root: &Path,
        current: &Path,
        show_non_notes: bool,
    ) -> Result<Vec<TreeNodeItem>, WorkspaceError> {
        let mut entries = match fs::read_dir(current) {
            Ok(rd) => rd,
            Err(e) => return Err(WorkspaceError::Io(e.to_string())),
        };

        let mut folders = Vec::new();
        let mut files = Vec::new();

        while let Some(Ok(entry)) = entries.next() {
            let path = entry.path();
            let file_name = entry.file_name();
            let name_str = file_name.to_string_lossy();

            if is_default_ignored(&name_str) {
                continue;
            }

            let rel_path = path.strip_prefix(root).unwrap_or(&path);
            let posix_rel = to_posix_path(rel_path);

            let is_dir = path.is_dir();
            if is_dir {
                let children = scan_dir(root, &path, show_non_notes)?;
                folders.push(TreeNodeItem {
                    id: posix_rel.clone(),
                    name: name_str.to_string(),
                    path: posix_rel,
                    is_folder: true,
                    children: Some(children),
                    is_note: None,
                    title: None,
                });
            } else {
                let is_note = is_note_path(&path);
                if !is_note && !show_non_notes {
                    continue;
                }

                let title = if is_note {
                    let content = fs::read_to_string(&path).unwrap_or_default();
                    Some(resolve_note_title(&content, &path))
                } else {
                    None
                };

                files.push(TreeNodeItem {
                    id: posix_rel.clone(),
                    name: name_str.to_string(),
                    path: posix_rel,
                    is_folder: false,
                    children: None,
                    is_note: Some(is_note),
                    title,
                });
            }
        }

        // Sort folders case-insensitively
        folders.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
        // Sort files case-insensitively
        files.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));

        let mut all = folders;
        all.extend(files);
        Ok(all)
    }

    scan_dir(root, root, show_non_note_files)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn test_resolve_in_workspace_rejects_absolute() {
        let root = Path::new("/workspace");
        assert_eq!(
            resolve_in_workspace(root, "/etc/passwd"),
            Err(PathError::AbsolutePath("/etc/passwd".into()))
        );
        assert_eq!(
            resolve_in_workspace(root, "\\Windows\\System32"),
            Err(PathError::AbsolutePath("\\Windows\\System32".into()))
        );
    }

    #[test]
    fn test_resolve_in_workspace_rejects_escape() {
        let root = Path::new("/workspace");
        assert_eq!(
            resolve_in_workspace(root, "../secret.txt"),
            Err(PathError::EscapesRoot("../secret.txt".into()))
        );
        assert_eq!(
            resolve_in_workspace(root, "notes/../../secret.txt"),
            Err(PathError::EscapesRoot("notes/../../secret.txt".into()))
        );
    }

    #[test]
    fn test_resolve_in_workspace_allows_inner_dots() {
        let root = Path::new("/workspace");
        let res = resolve_in_workspace(root, "notes/sub/../settlement.md");
        assert!(res.is_ok());
        assert_eq!(res.unwrap(), root.join("notes/settlement.md"));
    }

    #[test]
    fn test_resolve_in_workspace_rejects_null_bytes() {
        let root = Path::new("/workspace");
        assert_eq!(
            resolve_in_workspace(root, "notes/daily\0.md"),
            Err(PathError::NullByte("notes/daily\0.md".into()))
        );
    }

    #[test]
    fn test_resolve_in_workspace_rejects_windows_reserved() {
        let root = Path::new("/workspace");
        assert_eq!(
            resolve_in_workspace(root, "CON.md"),
            Err(PathError::ReservedName("CON.md".into()))
        );
        assert_eq!(
            resolve_in_workspace(root, "notes/aux"),
            Err(PathError::ReservedName("aux".into()))
        );
        assert_eq!(
            resolve_in_workspace(root, "sub/com1.txt"),
            Err(PathError::ReservedName("com1.txt".into()))
        );
    }

    #[test]
    fn test_resolve_in_workspace_rejects_overlong_and_empty() {
        let root = Path::new("/workspace");
        assert_eq!(
            resolve_in_workspace(root, ""),
            Err(PathError::EmptyComponent("".into()))
        );
        assert_eq!(
            resolve_in_workspace(root, "notes//daily.md"),
            Err(PathError::EmptyComponent("notes//daily.md".into()))
        );
        let overlong = "a".repeat(256);
        assert_eq!(
            resolve_in_workspace(root, &overlong),
            Err(PathError::ComponentTooLong(overlong))
        );
    }

    #[test]
    fn test_resolve_in_workspace_accepts_unicode_and_spaces() {
        let root = Path::new("/workspace");
        let res = resolve_in_workspace(root, "projets/résumé 2026/note & graph.md");
        assert!(res.is_ok());
        assert_eq!(
            res.unwrap(),
            root.join("projets/résumé 2026/note & graph.md")
        );
    }

    #[test]
    fn test_title_resolution() {
        let path = Path::new("daily-log.md");
        // 1. Front-matter
        let content1 = "---\ntitle: Custom Title\ntags: [a]\n---\n# Ignored Heading";
        assert_eq!(resolve_note_title(content1, path), "Custom Title");

        // 2. First heading
        let content2 = "Some intro text\n\n# Main Heading\n## Subheading";
        assert_eq!(resolve_note_title(content2, path), "Main Heading");

        // 3. Fallback to stem
        let content3 = "Just paragraph without heading or front-matter";
        assert_eq!(resolve_note_title(content3, path), "daily-log");
    }

    #[test]
    fn test_workspace_tree_building() {
        let dir = tempdir().unwrap();
        let root = dir.path();

        // Create structure
        fs::create_dir_all(root.join("projects/payments")).unwrap();
        fs::create_dir_all(root.join(".git")).unwrap();
        fs::create_dir_all(root.join(".flint")).unwrap();

        fs::write(
            root.join("projects/payments/settlement.md"),
            "# Settlement Windows\nContent",
        )
        .unwrap();
        fs::write(root.join("daily.md"), "---\ntitle: Daily Log\n---\nLog").unwrap();
        fs::write(root.join("LICENSE"), "MIT License").unwrap();

        // Tree without non-notes
        let tree = build_workspace_tree(root, false).unwrap();
        assert_eq!(tree.len(), 2); // projects/ (folder) and daily.md (note)
        assert_eq!(tree[0].name, "projects");
        assert!(tree[0].is_folder);
        assert_eq!(tree[1].name, "daily.md");
        assert_eq!(tree[1].title.as_deref(), Some("Daily Log"));

        // Tree with non-notes
        let tree_with_all = build_workspace_tree(root, true).unwrap();
        assert_eq!(tree_with_all.len(), 3); // projects/, daily.md, LICENSE
    }
}

#[cfg(test)]
mod proptests {
    use super::*;
    use proptest::prelude::*;

    proptest! {
        #[test]
        fn test_never_panics_on_arbitrary_string(s in "\\PC*") {
            let root = Path::new("/workspace/root");
            let _ = resolve_in_workspace(root, &s);
        }

        #[test]
        fn test_valid_alphanumeric_nested_always_ok(
            segments in prop::collection::vec("[a-zA-Z0-9_-]{1,20}", 1..5)
        ) {
            let candidate = segments.join("/");
            let root = Path::new("/workspace/root");
            let res = resolve_in_workspace(root, &candidate);
            prop_assert!(res.is_ok());
            let resolved = res.unwrap();
            prop_assert!(resolved.starts_with(root));
        }

        #[test]
        fn test_leading_slash_always_rejected(s in "[a-zA-Z0-9/_-]{1,30}") {
            let candidate = format!("/{}", s);
            let root = Path::new("/workspace/root");
            let res = resolve_in_workspace(root, &candidate);
            prop_assert!(res.is_err());
            prop_assert_eq!(res.unwrap_err(), PathError::AbsolutePath(candidate));
        }
    }
}
