//! `flint-core`: pure logic domain types, indexing, path resolution, and link handling.
//!
//! This crate has zero Tauri or GUI dependencies and can be tested in complete isolation.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;

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

/// Error type for path validation.
#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum PathError {
    #[error("Path escapes workspace root: {0}")]
    EscapesRoot(String),
    #[error("Absolute path is forbidden: {0}")]
    AbsolutePath(String),
    #[error("Invalid character or component in path: {0}")]
    InvalidComponent(String),
}

/// Path guard stub for M1 (detailed proptests & validation expand in M2).
pub fn resolve_in_workspace(root: &std::path::Path, candidate: &str) -> Result<PathBuf, PathError> {
    if candidate.starts_with('/') || candidate.starts_with('\\') {
        return Err(PathError::AbsolutePath(candidate.to_string()));
    }
    if candidate.contains("..") {
        return Err(PathError::EscapesRoot(candidate.to_string()));
    }
    Ok(root.join(candidate))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    #[test]
    fn test_resolve_in_workspace_rejects_absolute() {
        let root = Path::new("/workspace");
        assert!(resolve_in_workspace(root, "/etc/passwd").is_err());
    }

    #[test]
    fn test_resolve_in_workspace_accepts_relative() {
        let root = Path::new("/workspace");
        let res = resolve_in_workspace(root, "notes/daily.md");
        assert!(res.is_ok());
        assert_eq!(res.unwrap(), root.join("notes/daily.md"));
    }
}
