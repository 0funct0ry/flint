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

/// A fingerprint of a note on disk for safe concurrent edit conflict detection (SPEC §8.3).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Fingerprint {
    pub path: NotePath,
    pub size_bytes: u64,
    pub modified_ms: u64,
    pub content_hash: String,
}

/// The loaded content, metadata, and fingerprint of a note.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct NoteContent {
    pub content: String,
    pub meta: NoteMeta,
    pub fingerprint: Fingerprint,
    pub front_matter_raw: Option<String>,
}

/// Error type for note reading and writing operations.
#[derive(Debug, thiserror::Error, PartialEq, Eq, Clone, Serialize, Deserialize)]
pub enum NoteError {
    #[error("Path error: {0}")]
    Path(#[from] PathError),
    #[error("Note not found: {0}")]
    NotFound(String),
    #[error("File or folder already exists: {0}")]
    AlreadyExists(String),
    #[error("Target is a directory, not a note: {0}")]
    IsADirectory(String),
    #[error("Target is a file, not a directory: {0}")]
    NotADirectory(String),
    #[error("Conflict detected: note on disk was modified externally")]
    Conflict {
        expected: Option<Box<Fingerprint>>,
        actual: Option<Box<Fingerprint>>,
    },
    #[error("File is not a valid UTF-8 note: {0}")]
    EncodingError(String),
    #[error("Failed to delete item: {0}")]
    DeleteFailed(String),
    #[error("I/O error: {0}")]
    Io(String),
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

/// Parse YAML front matter and body separation.
/// If front matter exists at byte 0 (`---`), returns `(Some(raw_front_matter), body, tags)`.
pub fn parse_front_matter(content: &str) -> (Option<String>, &str, Vec<String>) {
    if let Some(rest) = content
        .strip_prefix("---\n")
        .or_else(|| content.strip_prefix("---\r\n"))
    {
        if let Some(end_idx) = rest.find("\n---").or_else(|| rest.find("\r\n---")) {
            let raw_fm = &rest[..end_idx];
            let after_end = &rest[end_idx..];
            let body = if let Some(b) = after_end.strip_prefix("\n---\n") {
                b
            } else if let Some(b) = after_end.strip_prefix("\n---\r\n") {
                b
            } else if let Some(b) = after_end.strip_prefix("\r\n---\r\n") {
                b
            } else if let Some(b) = after_end.strip_prefix("\r\n---\n") {
                b
            } else if let Some(b) = after_end.strip_prefix("\n---") {
                b
            } else if let Some(b) = after_end.strip_prefix("\r\n---") {
                b
            } else {
                after_end
            };

            // Parse tags from front-matter
            let mut tags = Vec::new();
            let mut in_tags_list = false;
            for line in raw_fm.lines() {
                let trimmed = line.trim();
                if trimmed.starts_with("tags:") {
                    let val = trimmed.strip_prefix("tags:").unwrap().trim();
                    if val.starts_with('[') && val.ends_with(']') {
                        let inner = &val[1..val.len() - 1];
                        for item in inner.split(',') {
                            let t = item.trim().trim_matches('"').trim_matches('\'').trim();
                            if !t.is_empty() {
                                tags.push(t.to_string());
                            }
                        }
                    } else if val.is_empty() {
                        in_tags_list = true;
                    } else {
                        tags.push(val.to_string());
                    }
                } else if in_tags_list {
                    if let Some(t) = trimmed.strip_prefix("- ") {
                        let tag = t.trim().trim_matches('"').trim_matches('\'').trim();
                        if !tag.is_empty() {
                            tags.push(tag.to_string());
                        }
                    } else if !trimmed.is_empty() && !trimmed.starts_with('#') {
                        in_tags_list = false;
                    }
                }
            }

            return (Some(raw_fm.to_string()), body, tags);
        }
    }
    (None, content, Vec::new())
}

/// Extract heading outline from note Markdown content.
pub fn extract_headings(content: &str) -> Vec<HeadingItem> {
    let mut headings = Vec::new();
    let mut in_code_block = false;

    for line in content.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with("```") || trimmed.starts_with("~~~") {
            in_code_block = !in_code_block;
            continue;
        }
        if in_code_block {
            continue;
        }

        if let Some(rest) = trimmed.strip_prefix('#') {
            let mut level = 1u8;
            let mut chars = rest.chars();
            while let Some(c) = chars.next() {
                if c == '#' {
                    level += 1;
                    if level > 6 {
                        break;
                    }
                } else if c.is_whitespace() {
                    let text = chars.as_str().trim();
                    if !text.is_empty() {
                        // Generate slug anchor
                        let anchor = text
                            .to_lowercase()
                            .chars()
                            .map(|ch| if ch.is_alphanumeric() { ch } else { '-' })
                            .collect::<String>()
                            .split('-')
                            .filter(|s| !s.is_empty())
                            .collect::<Vec<_>>()
                            .join("-");

                        headings.push(HeadingItem {
                            level,
                            text: text.to_string(),
                            anchor,
                        });
                    }
                    break;
                } else {
                    break;
                }
            }
        }
    }
    headings
}

/// Fast simple 64-bit hash (FNV-1a) formatted as hex string.
fn hash_bytes(bytes: &[u8]) -> String {
    let mut hash: u64 = 0xcbf29ce484222325;
    for byte in bytes {
        hash ^= *byte as u64;
        hash = hash.wrapping_mul(0x100000001b3);
    }
    format!("{:016x}", hash)
}

/// Compute a note fingerprint from its metadata and raw content bytes.
pub fn compute_fingerprint(
    file_path: &Path,
    posix_path: &str,
    content_bytes: &[u8],
) -> Result<Fingerprint, NoteError> {
    let (size_bytes, modified_ms) = if file_path.exists() {
        let meta = fs::metadata(file_path).map_err(|e| NoteError::Io(e.to_string()))?;
        let mtime = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        (meta.len(), mtime)
    } else {
        (content_bytes.len() as u64, 0)
    };

    Ok(Fingerprint {
        path: posix_path.to_string(),
        size_bytes,
        modified_ms,
        content_hash: hash_bytes(content_bytes),
    })
}

/// Read note content and metadata safely using the path guard (SPEC §8.3, §11).
pub fn read_note(_root: &Path, safe_path: &SafePath) -> Result<NoteContent, NoteError> {
    let abs_path = safe_path.as_path();
    if !abs_path.exists() {
        return Err(NoteError::NotFound(safe_path.to_posix_string()));
    }

    let bytes = fs::read(abs_path).map_err(|e| NoteError::Io(e.to_string()))?;
    let content =
        String::from_utf8(bytes.clone()).map_err(|e| NoteError::EncodingError(e.to_string()))?;

    let posix = safe_path.to_posix_string();
    let fingerprint = compute_fingerprint(abs_path, &posix, &bytes)?;

    let (front_matter_raw, _, tags) = parse_front_matter(&content);
    let title = resolve_note_title(&content, safe_path.as_relative_path());
    let headings = extract_headings(&content);

    let meta = NoteMeta {
        path: posix,
        title,
        size_bytes: fingerprint.size_bytes,
        modified_ms: fingerprint.modified_ms,
        headings,
        tags,
    };

    Ok(NoteContent {
        content,
        meta,
        fingerprint,
        front_matter_raw,
    })
}

/// Atomically write note content to disk with fingerprint conflict detection (SPEC §8.3, §10.3).
///
/// Steps:
/// 1. If file already exists and `expected_fingerprint` is provided, compare current on-disk state
///    with `expected_fingerprint`. If different, return `NoteError::Conflict`.
/// 2. Write to `<filename>.flint-tmp` in the same directory.
/// 3. Call `sync_all()` (`fsync`).
/// 4. Rename temp file to target file atomically.
/// 5. Return the new `Fingerprint`.
pub fn write_note_atomic(
    root: &Path,
    safe_path: &SafePath,
    new_content: &str,
    expected_fingerprint: Option<&Fingerprint>,
) -> Result<Fingerprint, NoteError> {
    let _ = root;
    let target_path = safe_path.as_path();
    let posix = safe_path.to_posix_string();

    // Check for conflict if expected fingerprint provided
    if let Some(expected) = expected_fingerprint {
        if target_path.exists() {
            let current_bytes = fs::read(target_path).map_err(|e| NoteError::Io(e.to_string()))?;
            let current_fp = compute_fingerprint(target_path, &posix, &current_bytes)?;

            // If hash or size or modified timestamp differs from expected
            if current_fp.content_hash != expected.content_hash {
                return Err(NoteError::Conflict {
                    expected: Some(Box::new(expected.clone())),
                    actual: Some(Box::new(current_fp)),
                });
            }
        } else {
            // File was deleted on disk externally
            return Err(NoteError::Conflict {
                expected: Some(Box::new(expected.clone())),
                actual: None,
            });
        }
    }

    // Ensure parent directory exists
    if let Some(parent) = target_path.parent() {
        if !parent.exists() {
            fs::create_dir_all(parent).map_err(|e| NoteError::Io(e.to_string()))?;
        }
    }

    // Atomic write pattern: write to temp file in same dir, fsync, rename
    let file_name = target_path
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("note.md");
    let temp_name = format!("{}.flint-tmp", file_name);
    let temp_path = match target_path.parent() {
        Some(p) => p.join(temp_name),
        None => target_path.with_file_name(temp_name),
    };

    {
        use std::io::Write;
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .open(&temp_path)
            .map_err(|e| NoteError::Io(e.to_string()))?;

        file.write_all(new_content.as_bytes())
            .map_err(|e| NoteError::Io(e.to_string()))?;
        file.sync_all().map_err(|e| NoteError::Io(e.to_string()))?;
    }

    // Rename temp file to target
    fs::rename(&temp_path, target_path).map_err(|e| {
        let _ = fs::remove_file(&temp_path);
        NoteError::Io(e.to_string())
    })?;

    // Compute updated fingerprint
    let bytes = new_content.as_bytes();
    compute_fingerprint(target_path, &posix, bytes)
}

/// Create a new note at the given safe path, optionally with template content (SPEC §11, M4).
pub fn create_note(
    _root: &Path,
    safe_path: &SafePath,
    template_content: Option<&str>,
) -> Result<NoteMeta, NoteError> {
    let abs_path = safe_path.as_path();
    if abs_path.exists() {
        return Err(NoteError::AlreadyExists(safe_path.to_posix_string()));
    }

    if let Some(parent) = abs_path.parent() {
        if !parent.exists() {
            fs::create_dir_all(parent).map_err(|e| NoteError::Io(e.to_string()))?;
        }
    }

    let initial_content = template_content.unwrap_or("");
    fs::write(abs_path, initial_content.as_bytes()).map_err(|e| NoteError::Io(e.to_string()))?;

    let posix = safe_path.to_posix_string();
    let (front_matter_raw, _, tags) = parse_front_matter(initial_content);
    let _ = front_matter_raw;
    let title = resolve_note_title(initial_content, safe_path.as_relative_path());
    let headings = extract_headings(initial_content);
    let meta = fs::metadata(abs_path).map_err(|e| NoteError::Io(e.to_string()))?;
    let modified_ms = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);

    Ok(NoteMeta {
        path: posix,
        title,
        size_bytes: meta.len(),
        modified_ms,
        headings,
        tags,
    })
}

/// Recursively copy a directory or file (used for cross-device moves).
fn copy_recursive(src: &Path, dst: &Path) -> std::io::Result<()> {
    if src.is_dir() {
        fs::create_dir_all(dst)?;
        for entry in fs::read_dir(src)? {
            let entry = entry?;
            let entry_path = entry.path();
            let dest_child = dst.join(entry.file_name());
            copy_recursive(&entry_path, &dest_child)?;
        }
    } else {
        if let Some(parent) = dst.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::copy(src, dst)?;
    }
    Ok(())
}

/// Rename/move a note or folder with fallback to copy-and-remove on cross-device link errors (SPEC §11, M4).
pub fn rename_path(
    _root: &Path,
    from_safe: &SafePath,
    to_safe: &SafePath,
) -> Result<(), NoteError> {
    let from_abs = from_safe.as_path();
    let to_abs = to_safe.as_path();

    if !from_abs.exists() {
        return Err(NoteError::NotFound(from_safe.to_posix_string()));
    }
    if to_abs.exists() {
        return Err(NoteError::AlreadyExists(to_safe.to_posix_string()));
    }

    if let Some(parent) = to_abs.parent() {
        if !parent.exists() {
            fs::create_dir_all(parent).map_err(|e| NoteError::Io(e.to_string()))?;
        }
    }

    // Try standard fs::rename
    match fs::rename(from_abs, to_abs) {
        Ok(()) => Ok(()),
        Err(e) => {
            // Check for cross-device link error (EXDEV on Unix)
            let is_cross_device = e.raw_os_error() == Some(18); // EXDEV is 18 on Linux/macOS
            if is_cross_device {
                copy_recursive(from_abs, to_abs).map_err(|err| NoteError::Io(err.to_string()))?;
                if from_abs.is_dir() {
                    fs::remove_dir_all(from_abs).map_err(|err| NoteError::Io(err.to_string()))?;
                } else {
                    fs::remove_file(from_abs).map_err(|err| NoteError::Io(err.to_string()))?;
                }
                Ok(())
            } else {
                Err(NoteError::Io(e.to_string()))
            }
        }
    }
}

/// Duplicate an existing note, generating a non-colliding copy name (e.g. `<stem> 1.md` or `<stem> copy.md`).
pub fn duplicate_note(
    root: &Path,
    safe_path: &SafePath,
) -> Result<NoteMeta, NoteError> {
    let abs_path = safe_path.as_path();
    if !abs_path.exists() {
        return Err(NoteError::NotFound(safe_path.to_posix_string()));
    }
    if abs_path.is_dir() {
        return Err(NoteError::IsADirectory(safe_path.to_posix_string()));
    }

    let content = fs::read_to_string(abs_path).map_err(|e| NoteError::Io(e.to_string()))?;
    let parent_rel = safe_path.as_relative_path().parent().unwrap_or_else(|| Path::new(""));
    let stem = safe_path
        .as_relative_path()
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("note");
    let ext = safe_path
        .as_relative_path()
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("md");

    // Find next available duplicate name
    let mut candidate_name = format!("{} 1.{}", stem, ext);
    let mut candidate_rel = if parent_rel.as_os_str().is_empty() {
        candidate_name.clone()
    } else {
        format!("{}/{}", to_posix_path(parent_rel), candidate_name)
    };

    let mut counter = 1;
    while resolve_in_workspace(root, &candidate_rel).map(|p| p.exists()).unwrap_or(false) {
        counter += 1;
        candidate_name = format!("{} {}.{}", stem, counter, ext);
        candidate_rel = if parent_rel.as_os_str().is_empty() {
            candidate_name.clone()
        } else {
            format!("{}/{}", to_posix_path(parent_rel), candidate_name)
        };
    }

    let target_safe = SafePath::resolve(root, &candidate_rel)?;
    create_note(root, &target_safe, Some(&content))
}

/// Delete a file or note. If `permanent` is false, moves to OS trash (SPEC §10.3, M4).
pub fn delete_path(
    _root: &Path,
    safe_path: &SafePath,
    permanent: bool,
) -> Result<(), NoteError> {
    let abs_path = safe_path.as_path();
    if !abs_path.exists() {
        return Err(NoteError::NotFound(safe_path.to_posix_string()));
    }

    if permanent {
        if abs_path.is_dir() {
            fs::remove_dir_all(abs_path).map_err(|e| NoteError::Io(e.to_string()))?;
        } else {
            fs::remove_file(abs_path).map_err(|e| NoteError::Io(e.to_string()))?;
        }
    } else {
        trash::delete(abs_path).map_err(|e| NoteError::DeleteFailed(e.to_string()))?;
    }
    Ok(())
}

/// Create a new folder at the given safe path (SPEC §11, M4).
pub fn create_folder(
    _root: &Path,
    safe_path: &SafePath,
) -> Result<(), NoteError> {
    let abs_path = safe_path.as_path();
    if abs_path.exists() {
        return Err(NoteError::AlreadyExists(safe_path.to_posix_string()));
    }
    fs::create_dir_all(abs_path).map_err(|e| NoteError::Io(e.to_string()))?;
    Ok(())
}

/// Delete a folder. If `permanent` is false, moves to OS trash (SPEC §11, M4).
pub fn delete_folder(
    _root: &Path,
    safe_path: &SafePath,
    permanent: bool,
) -> Result<(), NoteError> {
    let abs_path = safe_path.as_path();
    if !abs_path.exists() {
        return Err(NoteError::NotFound(safe_path.to_posix_string()));
    }
    if !abs_path.is_dir() {
        return Err(NoteError::NotADirectory(safe_path.to_posix_string()));
    }

    if permanent {
        fs::remove_dir_all(abs_path).map_err(|e| NoteError::Io(e.to_string()))?;
    } else {
        trash::delete(abs_path).map_err(|e| NoteError::DeleteFailed(e.to_string()))?;
    }
    Ok(())
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

    #[test]
    fn test_note_read_and_write_atomic_and_fingerprint() {
        let dir = tempdir().unwrap();
        let root = dir.path();

        let safe_path = SafePath::resolve(root, "notes/test.md").unwrap();
        let initial_content = "---\ntitle: Safe Note\nauthor: Alice\ncustom_field: preserve_me\ntags: [tag1, tag2]\n---\n# Safe Note\n\nContent here.\n";

        // Initial write
        let fp1 = write_note_atomic(root, &safe_path, initial_content, None).unwrap();
        assert_eq!(fp1.path, "notes/test.md");
        assert!(fp1.size_bytes > 0);

        // Read note
        let note = read_note(root, &safe_path).unwrap();
        assert_eq!(note.content, initial_content);
        assert_eq!(note.meta.title, "Safe Note");
        assert_eq!(note.meta.tags, vec!["tag1".to_string(), "tag2".to_string()]);
        assert_eq!(note.meta.headings.len(), 1);
        assert_eq!(note.meta.headings[0].text, "Safe Note");
        assert_eq!(note.fingerprint.content_hash, fp1.content_hash);
        assert!(note.front_matter_raw.is_some());
        assert!(note
            .front_matter_raw
            .unwrap()
            .contains("custom_field: preserve_me"));

        // Valid edit with expected fingerprint
        let edited_content = "---\ntitle: Safe Note\nauthor: Alice\ncustom_field: preserve_me\ntags: [tag1, tag2]\n---\n# Safe Note\n\nUpdated content!\n";
        let fp2 = write_note_atomic(root, &safe_path, edited_content, Some(&fp1)).unwrap();
        assert_ne!(fp1.content_hash, fp2.content_hash);

        // External change conflict detection:
        // Attempting to save with outdated fp1 should fail with Conflict error
        let conflict_content = "Attempted overwrite with stale fingerprint";
        let err = write_note_atomic(root, &safe_path, conflict_content, Some(&fp1));
        assert!(matches!(err, Err(NoteError::Conflict { .. })));

        // Attempting to save with expected fingerprint on deleted file should also fail
        fs::remove_file(safe_path.as_path()).unwrap();
        let err_del = write_note_atomic(root, &safe_path, conflict_content, Some(&fp2));
        assert!(matches!(err_del, Err(NoteError::Conflict { .. })));
    }

    #[test]
    fn test_note_empty_crlf_and_no_trailing_newline() {
        let dir = tempdir().unwrap();
        let root = dir.path();

        // 1. Empty note
        let empty_path = SafePath::resolve(root, "empty.md").unwrap();
        let fp_empty = write_note_atomic(root, &empty_path, "", None).unwrap();
        assert_eq!(fp_empty.size_bytes, 0);
        let note_empty = read_note(root, &empty_path).unwrap();
        assert_eq!(note_empty.content, "");
        assert_eq!(note_empty.meta.title, "empty");

        // 2. CRLF endings note
        let crlf_path = SafePath::resolve(root, "crlf.md").unwrap();
        let crlf_content = "---\r\ntitle: Windows Note\r\ntags:\r\n  - win\r\n---\r\n# Windows Heading\r\n\r\nLine 1\r\nLine 2\r\n";
        let fp_crlf = write_note_atomic(root, &crlf_path, crlf_content, None).unwrap();
        let note_crlf = read_note(root, &crlf_path).unwrap();
        assert_eq!(note_crlf.content, crlf_content);
        assert_eq!(note_crlf.meta.title, "Windows Note");
        assert_eq!(note_crlf.meta.tags, vec!["win".to_string()]);
        assert_eq!(note_crlf.meta.headings.len(), 1);
        assert_eq!(note_crlf.fingerprint.content_hash, fp_crlf.content_hash);

        // 3. No trailing newline
        let nonl_path = SafePath::resolve(root, "nonl.md").unwrap();
        let nonl_content = "# No Newline\nEnd of file right here";
        let _ = write_note_atomic(root, &nonl_path, nonl_content, None).unwrap();
        let note_nonl = read_note(root, &nonl_path).unwrap();
        assert_eq!(note_nonl.content, nonl_content);
        assert_eq!(note_nonl.meta.title, "No Newline");
    }

    #[test]
    fn test_large_5mb_note() {
        let dir = tempdir().unwrap();
        let root = dir.path();
        let large_path = SafePath::resolve(root, "large.md").unwrap();

        // Generate ~5 MB text
        let mut large_content = String::with_capacity(5 * 1024 * 1024 + 100);
        large_content.push_str("# Large Note\n\n");
        let paragraph = "Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua.\n";
        while large_content.len() < 5 * 1024 * 1024 {
            large_content.push_str(paragraph);
        }

        let fp = write_note_atomic(root, &large_path, &large_content, None).unwrap();
        assert!(fp.size_bytes >= 5 * 1024 * 1024);

        let note = read_note(root, &large_path).unwrap();
        assert_eq!(note.content.len(), large_content.len());
        assert_eq!(note.meta.title, "Large Note");
    }

    #[test]
    fn test_create_note_and_create_folder() {
        let dir = tempdir().unwrap();
        let root = dir.path();

        // 1. Create note in root
        let note_path = SafePath::resolve(root, "my-note.md").unwrap();
        let meta = create_note(root, &note_path, Some("# My Note\n\nBody text")).unwrap();
        assert_eq!(meta.path, "my-note.md");
        assert_eq!(meta.title, "My Note");
        assert!(root.join("my-note.md").exists());

        // Re-creating should fail with AlreadyExists
        let err = create_note(root, &note_path, None);
        assert!(matches!(err, Err(NoteError::AlreadyExists(_))));

        // 2. Create nested note (auto-creates parent folder)
        let nested_note = SafePath::resolve(root, "sub/dir/nested.md").unwrap();
        let nested_meta = create_note(root, &nested_note, Some("---\ntitle: Nested\n---\n")).unwrap();
        assert_eq!(nested_meta.title, "Nested");
        assert!(root.join("sub/dir/nested.md").exists());

        // 3. Create folder
        let folder_path = SafePath::resolve(root, "my-folder").unwrap();
        create_folder(root, &folder_path).unwrap();
        assert!(root.join("my-folder").is_dir());

        // Re-creating folder should fail with AlreadyExists
        let err_folder = create_folder(root, &folder_path);
        assert!(matches!(err_folder, Err(NoteError::AlreadyExists(_))));
    }

    #[test]
    fn test_rename_and_move_note_and_folder() {
        let dir = tempdir().unwrap();
        let root = dir.path();

        // Create initial note and folder
        let from_note = SafePath::resolve(root, "original.md").unwrap();
        create_note(root, &from_note, Some("# Content")).unwrap();

        let to_note = SafePath::resolve(root, "renamed.md").unwrap();
        rename_path(root, &from_note, &to_note).unwrap();
        assert!(!root.join("original.md").exists());
        assert!(root.join("renamed.md").exists());

        // Move note into a subfolder
        let folder = SafePath::resolve(root, "docs").unwrap();
        create_folder(root, &folder).unwrap();

        let moved_note = SafePath::resolve(root, "docs/renamed.md").unwrap();
        rename_path(root, &to_note, &moved_note).unwrap();
        assert!(!root.join("renamed.md").exists());
        assert!(root.join("docs/renamed.md").exists());

        // Rename folder
        let renamed_folder = SafePath::resolve(root, "documentation").unwrap();
        rename_path(root, &folder, &renamed_folder).unwrap();
        assert!(!root.join("docs").exists());
        assert!(root.join("documentation/renamed.md").exists());
    }

    #[test]
    fn test_duplicate_note_naming() {
        let dir = tempdir().unwrap();
        let root = dir.path();

        let note = SafePath::resolve(root, "spec.md").unwrap();
        create_note(root, &note, Some("# Spec Note")).unwrap();

        // First duplicate -> spec 1.md
        let dup1 = duplicate_note(root, &note).unwrap();
        assert_eq!(dup1.path, "spec 1.md");
        assert!(root.join("spec 1.md").exists());

        // Second duplicate -> spec 2.md
        let dup2 = duplicate_note(root, &note).unwrap();
        assert_eq!(dup2.path, "spec 2.md");
        assert!(root.join("spec 2.md").exists());

        // Nested duplicate
        let nested = SafePath::resolve(root, "nested/plan.md").unwrap();
        create_note(root, &nested, Some("# Plan")).unwrap();
        let dup_nested = duplicate_note(root, &nested).unwrap();
        assert_eq!(dup_nested.path, "nested/plan 1.md");
        assert!(root.join("nested/plan 1.md").exists());
    }

    #[test]
    fn test_delete_path_and_folder_permanent() {
        let dir = tempdir().unwrap();
        let root = dir.path();

        let note = SafePath::resolve(root, "delete-me.md").unwrap();
        create_note(root, &note, Some("Text")).unwrap();

        delete_path(root, &note, true).unwrap();
        assert!(!root.join("delete-me.md").exists());

        let folder = SafePath::resolve(root, "delete-folder/sub").unwrap();
        create_folder(root, &folder).unwrap();

        let top_folder = SafePath::resolve(root, "delete-folder").unwrap();
        delete_folder(root, &top_folder, true).unwrap();
        assert!(!root.join("delete-folder").exists());
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
