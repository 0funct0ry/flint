//! `flint-core`: pure logic domain types, indexing, path resolution, and link handling.
//!
//! This crate has zero Tauri or GUI dependencies and can be tested in complete isolation.

pub mod config;
pub mod md_extensions;
pub mod render;
pub mod template;
pub mod template_gen;
pub use config::{
    config_get, config_reset, config_set, validate_ignore_patterns, RedbSequenceStore,
};
pub use render::{render_note_markdown, RenderResult};
pub use template::{
    list_templates, missing_required_variables, parse_template_variables, render_template,
    render_template_checked, resolve_variables, serialize_template_variables, NoteLookup,
    RenderOutcome, SequenceStore, TemplateContext, TemplateMeta, TemplateVariableDef,
    TemplateVariableKind, TEMPLATES_DIR, TEMPLATE_VARIABLES_FIELD,
};

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
    /// 0-based source line number of the heading, used to scroll the editor
    /// to the exact heading even when multiple headings share the same text.
    pub line: usize,
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
    pub front_matter_fields: Vec<(String, String)>,
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

/// Which link syntax produced a [`Link`] (M10.23). Markdown inline links and wikilinks are
/// indexed side by side in the same note — this field lets a consumer (backlinks panel, rename
/// rewriting) tell them apart without inferring it from the raw text's shape.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum LinkSyntax {
    Markdown,
    Wikilink,
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
    /// Which syntax this link was written in (M10.23). Defaults to `Markdown` on deserialize so
    /// older-shaped `Link` data (persisted state, other callers) still parses.
    #[serde(default = "default_link_syntax")]
    pub syntax: LinkSyntax,
    /// Non-empty only for a bare-name wikilink whose target stem matches more than one note in
    /// the workspace (M10.23) — the candidate note paths, so the UI can surface the ambiguity
    /// instead of silently picking one. `resolved` stays `None` while this is non-empty.
    #[serde(default)]
    pub ambiguous_with: Vec<NotePath>,
}

fn default_link_syntax() -> LinkSyntax {
    LinkSyntax::Markdown
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
    /// Every note's filename stem (lower-cased key, original-case `NotePath` values), for
    /// wikilink bare-name lookup (M10.23). Kept up to date alongside `notes` on every build,
    /// insert/update, and removal — cheap to maintain even when wikilinks are off.
    #[serde(default)]
    pub filename_stems: HashMap<String, Vec<NotePath>>,
    /// Whether `markdown.wikilinks` is on for this workspace (M10.23). Set once via
    /// [`Index::set_wikilinks_enabled`] after a workspace's config is read; while `false`,
    /// `[[...]]` spans are not parsed as links at all (fully inert), matching the render
    /// pipeline's own opt-in gating.
    #[serde(default)]
    pub wikilinks_enabled: bool,
    /// Reverse map of tag text (front-matter `tags:` ∪ inline `#tag`) to every note carrying it
    /// (M10.25). Keyed by the canonical casing of each case-insensitively distinct tag — the
    /// casing of whichever note introduced that tag first in workspace-walk order — looked up via
    /// [`Index::tag_canonical_key`] rather than by re-lowercasing the whole key, so display casing
    /// stays stable across rebuilds.
    #[serde(default)]
    pub tags: HashMap<String, Vec<NotePath>>,
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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub initial_note: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub start_collapsed: Option<bool>,
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

/// A search hit when matching note names or paths (SPEC §7, M9).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct NameHit {
    pub path: String,
    pub title: String,
    pub score: i64,
    pub match_indices_title: Vec<usize>,
    pub match_indices_path: Vec<usize>,
}

/// A line match inside a note's content (SPEC §7, M9).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ContentHit {
    pub line: u32,
    pub col: u32,
    pub match_length: usize,
    pub line_text: String,
}

/// A group of content matches in a single note.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ContentHitGroup {
    pub path: String,
    pub title: String,
    pub matches: Vec<ContentHit>,
}

/// Content search options (SPEC §7, M9).
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct ContentSearchOptions {
    #[serde(default)]
    pub case_sensitive: bool,
    #[serde(default)]
    pub whole_word: bool,
    #[serde(default)]
    pub is_regex: bool,
    #[serde(default)]
    pub folder_scope: Option<String>,
    #[serde(default)]
    pub includes: Vec<String>,
    #[serde(default)]
    pub excludes: Vec<String>,
}

/// Health report returned by workspace doctor (SPEC §4, §13, M9).
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct DoctorReport {
    pub workspace: String,
    pub note_count: usize,
    pub link_count: usize,
    pub broken_links: Vec<Link>,
    pub orphan_notes: Vec<String>,
    pub unreadable_files: Vec<String>,
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
            Component::ParentDir => Some(".."),
            Component::CurDir => Some("."),
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

/// Ordered top-level `(key, raw_value)` front-matter pairs, in source order.
pub type FrontMatterFields = Vec<(String, String)>;

/// The result of [`parse_front_matter`]: the raw fenced block (if any), the
/// body with that block stripped, the parsed `tags:` list, and the ordered
/// key/raw-value pairs.
pub type ParsedFrontMatter<'a> = (Option<String>, &'a str, Vec<String>, FrontMatterFields);

/// Parse YAML front matter and body separation.
/// If front matter exists at byte 0 (`---`), returns
/// `(Some(raw_front_matter), body, tags, fields)`, where `fields` is the ordered
/// list of top-level `(key, raw_value)` pairs as they appear in source order.
/// `raw_value` preserves the original scalar/flow-list/block-list text verbatim
/// (block-list values are reconstructed as `- item\n- item2` lines) so that
/// rebuilding front matter from `fields` never reformats untouched keys.
pub fn parse_front_matter(content: &str) -> ParsedFrontMatter<'_> {
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

            let fields = parse_front_matter_fields(raw_fm);

            return (Some(raw_fm.to_string()), body, tags, fields);
        }
    }
    (None, content, Vec::new(), Vec::new())
}

/// Parse a raw front-matter block (without the `---` fences) into an ordered
/// list of top-level `(key, raw_value)` pairs. A block-list value (`key:` with
/// no inline value, followed by `- item` lines) is reconstructed back into its
/// original `- item\n- item2` raw text so it round-trips verbatim.
fn parse_front_matter_fields(raw_fm: &str) -> Vec<(String, String)> {
    let mut fields: Vec<(String, String)> = Vec::new();
    let mut current_block_list: Option<usize> = None;

    for line in raw_fm.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        if let Some(colon_idx) = line.find(':') {
            // A top-level key has no leading whitespace before it.
            let leading_ws = line.len() - line.trim_start().len();
            if leading_ws == 0 {
                let key = line[..colon_idx].trim().to_string();
                let val = line[colon_idx + 1..].trim().to_string();
                if val.is_empty() {
                    // Possibly the start of a block list; value filled in as
                    // subsequent `- item` lines are seen.
                    fields.push((key, String::new()));
                    current_block_list = Some(fields.len() - 1);
                } else {
                    fields.push((key, val));
                    current_block_list = None;
                }
                continue;
            }
        }
        if let Some(idx) = current_block_list {
            if let Some(item) = trimmed.strip_prefix("- ") {
                let (_, existing) = &mut fields[idx];
                if existing.is_empty() {
                    *existing = format!("- {}", item.trim());
                } else {
                    existing.push('\n');
                    existing.push_str(&format!("- {}", item.trim()));
                }
                continue;
            } else {
                current_block_list = None;
            }
        }
    }

    fields
}

/// Rebuild note content with an updated ordered set of front-matter fields,
/// leaving the body and every untouched key's raw text byte-for-byte
/// unchanged. If `content` has no front-matter block yet, a new `---` block
/// is inserted at byte 0 ahead of the existing body. A key whose value is
/// unchanged from the original front matter keeps its original raw line(s)
/// verbatim; only added, removed, or edited keys get freshly serialized lines.
pub fn set_front_matter_fields(content: &str, fields: &[(String, String)]) -> String {
    let (_, body, _, _) = parse_front_matter(content);

    let mut fm = String::new();
    fm.push_str("---\n");
    for (key, value) in fields {
        fm.push_str(key);
        fm.push(':');
        if value.is_empty() {
            fm.push('\n');
        } else if value.starts_with("- ") || value.contains("\n- ") {
            fm.push('\n');
            for line in value.lines() {
                fm.push_str(line);
                fm.push('\n');
            }
        } else {
            fm.push(' ');
            fm.push_str(value);
            fm.push('\n');
        }
    }
    fm.push_str("---\n");

    if fields.is_empty() {
        // No fields left: drop the front-matter block entirely.
        body.to_string()
    } else {
        format!("{fm}{body}")
    }
}

/// Replace a note's body while leaving its front-matter block (if any) byte-for-byte unchanged —
/// the inverse counterpart of [`set_front_matter_fields`], needed wherever only the body is being
/// edited (M10.27 template body editor) without touching declared front-matter fields.
pub fn set_note_body(content: &str, new_body: &str) -> String {
    let (raw_fm, _, _, _) = parse_front_matter(content);
    match raw_fm {
        Some(fm) => format!("---\n{fm}\n---\n{new_body}"),
        None => new_body.to_string(),
    }
}

/// Normalize heading text to a slug: lowercase, non-alphanumeric runs become
/// single hyphens. Formatting markup (`**`, `_`, `[`, `]`, ...) collapses away
/// like any other non-alphanumeric run, so this is stable across representations
/// of the same heading (e.g. raw Markdown text vs. its rendered plain text).
pub fn slugify(text: &str) -> String {
    text.to_lowercase()
        .chars()
        .map(|ch| if ch.is_alphanumeric() { ch } else { '-' })
        .collect::<String>()
        .split('-')
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join("-")
}

/// Disambiguate a heading slug against slugs already seen in the same note,
/// appending `-2`, `-3`, ... on repeats (matching common Markdown renderer
/// conventions), so every heading in a note gets a unique anchor even when
/// two headings share the same text (e.g. repeated "Usage" subsections).
pub fn dedup_slug(seen: &mut std::collections::HashMap<String, u32>, base_slug: String) -> String {
    let count = seen.entry(base_slug.clone()).or_insert(0);
    *count += 1;
    if *count == 1 {
        base_slug
    } else {
        format!("{}-{}", base_slug, *count)
    }
}

/// Extract heading outline from note Markdown content.
pub fn extract_headings(content: &str) -> Vec<HeadingItem> {
    let mut headings = Vec::new();
    let mut in_code_block = false;
    let mut slug_counts: std::collections::HashMap<String, u32> = std::collections::HashMap::new();

    for (line_number, line) in content.lines().enumerate() {
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
                        let base_slug = slugify(text);
                        let anchor = dedup_slug(&mut slug_counts, base_slug);

                        headings.push(HeadingItem {
                            level,
                            text: text.to_string(),
                            anchor,
                            line: line_number,
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
pub fn hash_bytes(bytes: &[u8]) -> String {
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

    let (front_matter_raw, _, tags, front_matter_fields) = parse_front_matter(&content);
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
        front_matter_fields,
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
    let (front_matter_raw, _, tags, _) = parse_front_matter(initial_content);
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
pub fn duplicate_note(root: &Path, safe_path: &SafePath) -> Result<NoteMeta, NoteError> {
    let abs_path = safe_path.as_path();
    if !abs_path.exists() {
        return Err(NoteError::NotFound(safe_path.to_posix_string()));
    }
    if abs_path.is_dir() {
        return Err(NoteError::IsADirectory(safe_path.to_posix_string()));
    }

    let content = fs::read_to_string(abs_path).map_err(|e| NoteError::Io(e.to_string()))?;
    let parent_rel = safe_path
        .as_relative_path()
        .parent()
        .unwrap_or_else(|| Path::new(""));
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
    while resolve_in_workspace(root, &candidate_rel)
        .map(|p| p.exists())
        .unwrap_or(false)
    {
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
pub fn delete_path(_root: &Path, safe_path: &SafePath, permanent: bool) -> Result<(), NoteError> {
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
pub fn create_folder(_root: &Path, safe_path: &SafePath) -> Result<(), NoteError> {
    let abs_path = safe_path.as_path();
    if abs_path.exists() {
        return Err(NoteError::AlreadyExists(safe_path.to_posix_string()));
    }
    fs::create_dir_all(abs_path).map_err(|e| NoteError::Io(e.to_string()))?;
    Ok(())
}

/// Delete a folder. If `permanent` is false, moves to OS trash (SPEC §11, M4).
pub fn delete_folder(_root: &Path, safe_path: &SafePath, permanent: bool) -> Result<(), NoteError> {
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
    #[error("Not a Markdown file: {0}")]
    NotAMarkdownFile(PathBuf),
    #[error("Permission denied: {0}")]
    PermissionDenied(String),
    #[error("I/O error: {0}")]
    Io(String),
}

/// Resolved workspace target result (SPEC §4.1, M10.06).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ResolvedWorkspaceTarget {
    Directory(PathBuf),
    File {
        ws_root: PathBuf,
        initial_note: String,
    },
}

/// Resolve workspace path target according to SPEC §4.1 & M10.06:
/// 1. Explicit PATH argument, else `--workspace`, else `$FLINT_WORKSPACE`, else current directory.
/// 2. Canonicalize. Follow symlinks at the root only.
/// 3. If target is a directory, return `ResolvedWorkspaceTarget::Directory(canonical_dir)`.
/// 4. If target is a file and a valid Markdown note (`.md`/`.markdown`), return `ResolvedWorkspaceTarget::File`
///    with `ws_root` set to its parent directory and `initial_note` set to its relative POSIX path.
/// 5. If target is a non-Markdown file, return `Err(WorkspaceError::NotAMarkdownFile(path))`.
pub fn resolve_workspace_target(
    explicit: Option<&Path>,
    workspace_flag: Option<&Path>,
    env_var: Option<&str>,
    current_dir: &Path,
) -> Result<ResolvedWorkspaceTarget, WorkspaceError> {
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

    if canonical.is_dir() {
        Ok(ResolvedWorkspaceTarget::Directory(canonical))
    } else if is_note_path(&canonical) {
        let parent = canonical
            .parent()
            .map(|p| p.to_path_buf())
            .unwrap_or_else(|| current_dir.to_path_buf());
        let relative_name = canonical
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or_default()
            .to_string();
        Ok(ResolvedWorkspaceTarget::File {
            ws_root: parent,
            initial_note: relative_name,
        })
    } else {
        Err(WorkspaceError::NotAMarkdownFile(canonical))
    }
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
    match resolve_workspace_target(explicit, workspace_flag, env_var, current_dir)? {
        ResolvedWorkspaceTarget::Directory(dir) => Ok(dir),
        ResolvedWorkspaceTarget::File { ws_root, .. } => Ok(ws_root),
    }
}

pub use crate::config::{
    get_global_config_path, get_last_workspace, get_recent_workspaces, load_global_config,
    save_last_workspace,
};

/// Ensure `<workspace-root>/.flint.db` exists idempotently (SPEC §3.1, §12, §17; M10.21 — this
/// used to create `.flint/config.json`, but no `.flint/` directory is created anymore since
/// nothing left in scope still writes there).
pub fn bootstrap_workspace(root: &Path) -> Result<PathBuf, std::io::Error> {
    crate::config::bootstrap_workspace_db(root).map_err(|e| std::io::Error::other(e.to_string()))
}

/// Check if a path component is ignored by Flint's standard ignore rules (SPEC §5.2).
pub fn is_default_ignored(name: &str) -> bool {
    name == ".flint.db"
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
    ignore_patterns: &[String],
) -> Result<Vec<TreeNodeItem>, WorkspaceError> {
    if !root.exists() {
        return Err(WorkspaceError::NotFound(root.to_path_buf()));
    }
    if !root.is_dir() {
        return Err(WorkspaceError::NotADirectory(root.to_path_buf()));
    }

    let ignore_set = if ignore_patterns.is_empty() {
        None
    } else {
        let mut builder = globset::GlobSetBuilder::new();
        for pat in ignore_patterns {
            if let Ok(glob) = globset::Glob::new(pat) {
                builder.add(glob);
            }
        }
        builder.build().ok()
    };

    fn scan_dir(
        root: &Path,
        current: &Path,
        show_non_notes: bool,
        ignore_set: &Option<globset::GlobSet>,
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

            if let Some(set) = ignore_set {
                // For a directory, also probe with a trailing slash: a pattern like
                // "vendor/**" doesn't match the literal string "vendor", only paths under it,
                // so without this an ignored directory would still show up (empty) in the tree.
                let matched =
                    set.is_match(&posix_rel) || (is_dir && set.is_match(format!("{posix_rel}/")));
                if matched {
                    continue;
                }
            }

            if is_dir {
                let children = scan_dir(root, &path, show_non_notes, ignore_set)?;
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
        folders.sort_by_key(|a| a.name.to_lowercase());
        // Sort files case-insensitively
        files.sort_by_key(|a| a.name.to_lowercase());

        let mut all = folders;
        all.extend(files);
        Ok(all)
    }

    scan_dir(root, root, show_non_note_files, &ignore_set)
}

/// Outcome of resolving a raw link target (SPEC §6.3).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum ResolvedTarget {
    /// Internal note in workspace, with optional heading anchor (e.g. `settlement`).
    Internal {
        path: NotePath,
        anchor: Option<String>,
    },
    /// External link (http, https, mailto, etc.)
    External(String),
    /// Unresolved / broken link inside the workspace, with raw target path.
    Unresolved {
        raw_path: String,
        anchor: Option<String>,
    },
    /// A bare-name wikilink target (M10.23) whose filename stem matches more than one note.
    /// Not silently resolved to any one of them — the UI surfaces the candidates so the user
    /// picks. Re-evaluated at every render/index, never remembered as a per-link choice.
    Ambiguous(Vec<NotePath>),
}

/// Simple URL percent-decoding helper.
pub fn url_decode(input: &str) -> String {
    let mut bytes = Vec::with_capacity(input.len());
    let mut chars = input.bytes();
    while let Some(b) = chars.next() {
        if b == b'%' {
            let h1 = chars.next();
            let h2 = chars.next();
            if let (Some(h1), Some(h2)) = (h1, h2) {
                let s = [h1, h2];
                if let Ok(hex_str) = std::str::from_utf8(&s) {
                    if let Ok(byte) = u8::from_str_radix(hex_str, 16) {
                        bytes.push(byte);
                        continue;
                    }
                }
                bytes.push(b'%');
                bytes.push(h1);
                bytes.push(h2);
            } else {
                bytes.push(b'%');
                if let Some(h) = h1 {
                    bytes.push(h);
                }
            }
        } else if b == b'+' {
            bytes.push(b' ');
        } else {
            bytes.push(b);
        }
    }
    String::from_utf8_lossy(&bytes).to_string()
}

/// Resolve a link target according to SPEC §6.3:
/// - URL decoding
/// - Anchor stripping (`#heading`)
/// - External link check (`http://`, `https://`, `mailto:`, etc.)
/// - Relative against source note folder or workspace-absolute (`/path`)
/// - Implicit `.md` extension fallback
/// - Canonicalization and containment check inside root
pub fn resolve_link_target(
    workspace_root: &Path,
    source_note_rel: &str,
    raw_target: &str,
) -> ResolvedTarget {
    let trimmed = raw_target.trim();
    if trimmed.is_empty() {
        return ResolvedTarget::Unresolved {
            raw_path: String::new(),
            anchor: None,
        };
    }

    // 1. External check
    if trimmed.starts_with("http://")
        || trimmed.starts_with("https://")
        || trimmed.starts_with("mailto:")
        || trimmed.starts_with("ftp://")
    {
        return ResolvedTarget::External(trimmed.to_string());
    }

    // 2. URL decode and anchor split
    let decoded = url_decode(trimmed);
    let (path_part, anchor) = match decoded.split_once('#') {
        Some((p, a)) => (p.trim(), Some(a.trim().to_string())),
        None => (decoded.as_str(), None),
    };

    // If only an anchor is provided (e.g. `#heading`), it refers to the current note
    if path_part.is_empty() {
        if anchor.is_some() {
            return ResolvedTarget::Internal {
                path: source_note_rel.to_string(),
                anchor,
            };
        }
        return ResolvedTarget::Unresolved {
            raw_path: String::new(),
            anchor: None,
        };
    }

    let source_dir_rel = Path::new(source_note_rel)
        .parent()
        .unwrap_or_else(|| Path::new(""));

    // Helper to evaluate candidate relative path string
    let try_resolve_candidate = |candidate: &str| -> Option<NotePath> {
        let is_abs = candidate.starts_with('/');
        let norm_candidate = candidate.trim_start_matches('/');

        let rel_path_buf = if is_abs || source_dir_rel.as_os_str().is_empty() {
            PathBuf::from(norm_candidate)
        } else {
            source_dir_rel.join(norm_candidate)
        };

        let posix_rel = to_posix_path(&rel_path_buf);
        if let Ok(safe_path) = SafePath::resolve(workspace_root, &posix_rel) {
            let abs = safe_path.as_path();
            if abs.exists() && abs.is_file() {
                return Some(safe_path.to_posix_string());
            }
        }
        None
    };

    // Try exact path part
    if let Some(resolved) = try_resolve_candidate(path_part) {
        return ResolvedTarget::Internal {
            path: resolved,
            anchor,
        };
    }

    // Try appending .md if no extension
    if !path_part.ends_with(".md") && !path_part.ends_with(".markdown") {
        let with_md = format!("{}.md", path_part);
        if let Some(resolved) = try_resolve_candidate(&with_md) {
            return ResolvedTarget::Internal {
                path: resolved,
                anchor,
            };
        }
    }

    // Unresolved: compute what path it would have created
    let is_abs = path_part.starts_with('/');
    let norm_candidate = path_part.trim_start_matches('/');
    let target_with_ext =
        if !norm_candidate.ends_with(".md") && !norm_candidate.ends_with(".markdown") {
            format!("{}.md", norm_candidate)
        } else {
            norm_candidate.to_string()
        };

    let target_rel_buf = if is_abs || source_dir_rel.as_os_str().is_empty() {
        PathBuf::from(target_with_ext)
    } else {
        source_dir_rel.join(target_with_ext)
    };

    let posix_candidate = to_posix_path(&target_rel_buf);
    let raw_clean = if let Ok(safe) = SafePath::resolve(workspace_root, &posix_candidate) {
        safe.to_posix_string()
    } else {
        posix_candidate
    };

    ResolvedTarget::Unresolved {
        raw_path: raw_clean,
        anchor,
    }
}

/// Extract all links from Markdown note content with line and column positions.
pub fn extract_links(workspace_root: &Path, source_note_rel: &str, content: &str) -> Vec<Link> {
    use pulldown_cmark::{Event, Options, Parser, Tag};

    let mut links = Vec::new();
    let (_fm_raw, body, _, _) = parse_front_matter(content);

    // Track line offsets in the full content
    let line_offsets: Vec<usize> = std::iter::once(0)
        .chain(content.match_indices('\n').map(|(i, _)| i + 1))
        .collect();

    let offset_to_line_col = |byte_idx: usize| -> (u32, u32) {
        let line_idx = match line_offsets.binary_search(&byte_idx) {
            Ok(idx) => idx,
            Err(idx) => idx.saturating_sub(1),
        };
        let line_start = line_offsets[line_idx];
        let col = byte_idx.saturating_sub(line_start) + 1;
        ((line_idx + 1) as u32, col as u32)
    };

    let content_lines: Vec<&str> = content.lines().collect();

    let mut options = Options::empty();
    options.insert(Options::ENABLE_TABLES);
    options.insert(Options::ENABLE_FOOTNOTES);
    options.insert(Options::ENABLE_STRIKETHROUGH);
    options.insert(Options::ENABLE_TASKLISTS);

    let parser = Parser::new_ext(body, options).into_offset_iter();

    for (event, range) in parser {
        if let Event::Start(Tag::Link { dest_url, .. }) = event {
            let raw_dest = dest_url.to_string();
            // Calculate absolute range in original content
            let body_offset = content.len() - body.len();
            let abs_start = body_offset + range.start;

            let (line, col) = offset_to_line_col(abs_start);
            let context_line = if (line as usize) <= content_lines.len() {
                content_lines[(line - 1) as usize].trim().to_string()
            } else {
                String::new()
            };

            let resolution = resolve_link_target(workspace_root, source_note_rel, &raw_dest);
            let resolved_path = match resolution {
                ResolvedTarget::Internal { path, .. } => Some(path),
                ResolvedTarget::External(_) => None,
                ResolvedTarget::Unresolved { .. } => None,
                // resolve_link_target (Markdown-only path resolution) never produces this.
                ResolvedTarget::Ambiguous(_) => None,
            };

            links.push(Link {
                source: source_note_rel.to_string(),
                raw_target: raw_dest,
                resolved: resolved_path,
                line,
                col,
                context: context_line,
                syntax: LinkSyntax::Markdown,
                ambiguous_with: Vec::new(),
            });
        }
    }

    links
}

/// The pattern a candidate inline tag's characters must match, not counting the leading `#`.
const INLINE_TAG_PATTERN: &str = r"#[A-Za-z0-9_-]+";

/// Scan a note body's Markdown event stream for inline `#tag` tokens, returning each match's
/// absolute byte range within `body` and its tag text (without the leading `#`). Shared by
/// [`extract_inline_tags`] and [`rewrite_inline_tags`] (M10.25).
///
/// Only `Event::Text` runs outside a fenced/indented code block are scanned, so inline code spans
/// (`Event::Code`, a distinct event pulldown-cmark never turns into `Text`) and code blocks are
/// structurally excluded rather than regexed around. ATX heading markers (`# Heading`) need no
/// separate exclusion either: pulldown-cmark consumes the leading `#`s as the heading marker
/// before emitting `Event::Text`, so they're never candidate text — a tag appearing later on a
/// heading line (`## Sub #tag`) is still recognized normally. A `#` immediately preceded by a word
/// character (e.g. `C#`, `foo#bar`) is never a tag start; the preceding character is checked
/// against the original `body` (not just the current text run), so a tag split across inline
/// markup boundaries still excludes correctly.
fn scan_inline_tag_matches(body: &str) -> Vec<(usize, usize, String)> {
    use pulldown_cmark::{Event, Options, Parser, Tag, TagEnd};

    static TAG_REGEX: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    let re = TAG_REGEX.get_or_init(|| {
        regex::Regex::new(INLINE_TAG_PATTERN).expect("static tag pattern is valid")
    });

    let mut options = Options::empty();
    options.insert(Options::ENABLE_TABLES);
    options.insert(Options::ENABLE_FOOTNOTES);
    options.insert(Options::ENABLE_STRIKETHROUGH);
    options.insert(Options::ENABLE_TASKLISTS);

    let parser = Parser::new_ext(body, options).into_offset_iter();
    let mut in_code_block = false;
    let mut matches = Vec::new();

    for (event, range) in parser {
        match event {
            Event::Start(Tag::CodeBlock(_)) => in_code_block = true,
            Event::End(TagEnd::CodeBlock) => in_code_block = false,
            Event::Text(text) if !in_code_block => {
                let text_str = text.as_ref();
                for m in re.find_iter(text_str) {
                    let abs_start = range.start + m.start();
                    let abs_end = range.start + m.end();
                    let preceded_by_word = body[..abs_start]
                        .chars()
                        .next_back()
                        .is_some_and(|c| c.is_alphanumeric() || c == '_');
                    if preceded_by_word {
                        continue;
                    }
                    matches.push((abs_start, abs_end, m.as_str()[1..].to_string()));
                }
            }
            _ => {}
        }
    }

    matches
}

/// Extract inline `#tag` tokens from a note's post-front-matter body, with 1-based line/col
/// positions (SPEC/M10.25). See [`scan_inline_tag_matches`] for the exclusion rules.
pub fn extract_inline_tags(body: &str) -> Vec<(String, u32, u32)> {
    let line_offsets: Vec<usize> = std::iter::once(0)
        .chain(body.match_indices('\n').map(|(i, _)| i + 1))
        .collect();
    let offset_to_line_col = |byte_idx: usize| -> (u32, u32) {
        let line_idx = match line_offsets.binary_search(&byte_idx) {
            Ok(idx) => idx,
            Err(idx) => idx.saturating_sub(1),
        };
        let line_start = line_offsets[line_idx];
        let col = byte_idx.saturating_sub(line_start) + 1;
        ((line_idx + 1) as u32, col as u32)
    };

    scan_inline_tag_matches(body)
        .into_iter()
        .map(|(start, _end, tag)| {
            let (line, col) = offset_to_line_col(start);
            (tag, line, col)
        })
        .collect()
}

/// Rewrite every inline `#old_tag` occurrence in a note body to `#new_tag` (case-insensitive
/// match on the tag text), using the same exclusion rules as [`extract_inline_tags`] so a rename
/// can never corrupt a `C#`/code-span occurrence or an ATX heading marker (M10.25). Returns
/// `(new_body, rewritten_count)`.
pub fn rewrite_inline_tags(body: &str, old_tag: &str, new_tag: &str) -> (String, usize) {
    let mut replacements: Vec<(usize, usize, String)> = scan_inline_tag_matches(body)
        .into_iter()
        .filter(|(_, _, tag)| tag.eq_ignore_ascii_case(old_tag))
        .map(|(start, end, _)| (start, end, format!("#{}", new_tag)))
        .collect();

    if replacements.is_empty() {
        return (body.to_string(), 0);
    }

    replacements.sort_by_key(|r| std::cmp::Reverse(r.0));
    let mut updated = body.to_string();
    let count = replacements.len();
    for (start, end, replacement) in replacements {
        if start <= end && end <= updated.len() {
            updated.replace_range(start..end, &replacement);
        }
    }
    (updated, count)
}

/// Union of a note's front-matter `tags:` entries and its body's inline `#tag` tokens, de-duped
/// case-insensitively with the first occurrence's casing kept (front-matter entries are scanned
/// before inline ones, so a front-matter `tags: [Rust]` wins over a later inline `#rust`) (M10.25).
fn merged_note_tags(front_matter_tags: Vec<String>, body: &str) -> Vec<String> {
    let mut merged = Vec::new();
    let mut seen_lower: std::collections::HashSet<String> = std::collections::HashSet::new();
    for t in front_matter_tags {
        if seen_lower.insert(t.to_lowercase()) {
            merged.push(t);
        }
    }
    for (t, _, _) in extract_inline_tags(body) {
        if seen_lower.insert(t.to_lowercase()) {
            merged.push(t);
        }
    }
    merged
}

/// Resolve a wikilink `target` (bare-name or path-shaped) against the workspace, per SPEC/M10.23:
/// - A `target` containing `/` is path-shaped: resolved exactly like a Markdown link target
///   (delegates to [`resolve_link_target`]), skipping name lookup entirely.
/// - A bare `target` is looked up case-insensitively by filename stem in `filename_stems`: zero
///   matches is `Unresolved`, one match is `Internal`, two or more is `Ambiguous` — never silently
///   resolved to the "shortest" or first match.
/// - `heading`, when present, is resolved against the matched note's rendered heading-anchor
///   slugs (the same slugification `extract_headings`/`note_render` already produce). An
///   unmatched heading still resolves the note; it just drops the anchor.
pub fn resolve_wikilink_target(
    workspace_root: &Path,
    source_note_rel: &str,
    filename_stems: &HashMap<String, Vec<NotePath>>,
    target: &str,
    heading: Option<&str>,
) -> ResolvedTarget {
    let trimmed = target.trim();

    if trimmed.contains('/') {
        return resolve_link_target(
            workspace_root,
            source_note_rel,
            &match heading {
                Some(h) if !h.is_empty() => format!("{trimmed}#{h}"),
                _ => trimmed.to_string(),
            },
        );
    }

    let key = trimmed.to_lowercase();
    let matches = filename_stems.get(&key).cloned().unwrap_or_default();

    let resolved_note = match matches.len() {
        0 => {
            return ResolvedTarget::Unresolved {
                raw_path: trimmed.to_string(),
                anchor: heading.map(|h| h.to_string()),
            };
        }
        1 => matches[0].clone(),
        _ => return ResolvedTarget::Ambiguous(matches),
    };

    let anchor = match heading {
        Some(h) if !h.is_empty() => {
            let wanted_slug = slugify(h);
            let target_abs = workspace_root.join(&resolved_note);
            let matched = fs::read_to_string(&target_abs)
                .ok()
                .map(|content| extract_headings(&content))
                .and_then(|headings| {
                    headings
                        .into_iter()
                        .find(|hd| hd.anchor == wanted_slug)
                        .map(|hd| hd.anchor)
                });
            matched.or(Some(wanted_slug))
        }
        _ => None,
    };
    // An unmatched heading still resolves the note; keep the requested (unmatched) slug as the
    // anchor so a stale/typo'd `#heading` doesn't silently drop to the note's top — matching how
    // a Markdown link's own `#heading` behaves in `resolve_link_target` today.

    ResolvedTarget::Internal {
        path: resolved_note,
        anchor,
    }
}

/// Extract wikilink spans from `content` (only when `wikilinks_enabled`) and resolve each via
/// [`resolve_wikilink_target`], returning one [`Link`] per span. Scans the **original** `content`
/// directly (not a `pulldown-cmark`-rewritten form), so `line`/`col`/`context` point at the
/// `[[...]]` text the user actually wrote.
pub fn extract_wikilinks(
    workspace_root: &Path,
    source_note_rel: &str,
    content: &str,
    filename_stems: &HashMap<String, Vec<NotePath>>,
) -> Vec<Link> {
    let spans = md_extensions::scan_wikilink_spans(content);
    if spans.is_empty() {
        return Vec::new();
    }

    let line_offsets: Vec<usize> = std::iter::once(0)
        .chain(content.match_indices('\n').map(|(i, _)| i + 1))
        .collect();
    let offset_to_line_col = |byte_idx: usize| -> (u32, u32) {
        let line_idx = match line_offsets.binary_search(&byte_idx) {
            Ok(idx) => idx,
            Err(idx) => idx.saturating_sub(1),
        };
        let line_start = line_offsets[line_idx];
        let col = byte_idx.saturating_sub(line_start) + 1;
        ((line_idx + 1) as u32, col as u32)
    };
    let content_lines: Vec<&str> = content.lines().collect();

    spans
        .into_iter()
        .map(|span| {
            let (line, col) = offset_to_line_col(span.start);
            let context_line = if (line as usize) <= content_lines.len() {
                content_lines[(line - 1) as usize].trim().to_string()
            } else {
                String::new()
            };

            let resolution = resolve_wikilink_target(
                workspace_root,
                source_note_rel,
                filename_stems,
                &span.target,
                span.heading.as_deref(),
            );
            let (resolved, ambiguous_with) = match resolution {
                ResolvedTarget::Internal { path, .. } => (Some(path), Vec::new()),
                ResolvedTarget::Ambiguous(candidates) => (None, candidates),
                ResolvedTarget::Unresolved { .. } | ResolvedTarget::External(_) => {
                    (None, Vec::new())
                }
            };

            Link {
                source: source_note_rel.to_string(),
                raw_target: span.target.clone(),
                resolved,
                line,
                col,
                context: context_line,
                syntax: LinkSyntax::Wikilink,
                ambiguous_with,
            }
        })
        .collect()
}

/// Extract every link in a note — Markdown inline links plus, when `wikilinks_enabled`,
/// wikilinks — merged into one list in document order (M10.23). This is the function `Index`
/// building/incremental-update calls; `extract_links` alone stays Markdown-only for callers that
/// don't need wikilink awareness.
pub fn extract_links_all(
    workspace_root: &Path,
    source_note_rel: &str,
    content: &str,
    wikilinks_enabled: bool,
    filename_stems: &HashMap<String, Vec<NotePath>>,
) -> Vec<Link> {
    let mut links = extract_links(workspace_root, source_note_rel, content);
    if wikilinks_enabled {
        links.extend(extract_wikilinks(
            workspace_root,
            source_note_rel,
            content,
            filename_stems,
        ));
    }
    links.sort_by_key(|l| (l.line, l.col));
    links
}

/// Retrieve all outgoing links for a given note (SPEC §11, M6).
pub fn links_outgoing(
    workspace_root: &Path,
    source_note_safe: &SafePath,
    override_content: Option<&str>,
) -> Result<Vec<Link>, NoteError> {
    let source_rel = source_note_safe.to_posix_string();
    let content = match override_content {
        Some(c) => c.to_string(),
        None => {
            let abs = source_note_safe.as_path();
            if !abs.exists() {
                return Err(NoteError::NotFound(source_rel));
            }
            fs::read_to_string(abs).map_err(|e| NoteError::Io(e.to_string()))?
        }
    };

    Ok(extract_links(workspace_root, &source_rel, &content))
}

/// Summary of link rewriting across the workspace.
#[derive(Debug, Default, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RewriteSummary {
    pub links_updated: usize,
    pub notes_updated: usize,
    #[serde(default)]
    pub rewritten_notes: Vec<(String, String)>,
    /// Count of bare-name wikilinks whose target resolved `Ambiguous` and were therefore *not*
    /// rewritten (M10.23) — there is no single note to know the rename applies to. Reported in
    /// the rename summary toast alongside `links_updated`/`notes_updated` so this isn't a silent
    /// gap.
    #[serde(default)]
    pub wikilinks_skipped_ambiguous: usize,
}

/// Compute shortest POSIX relative path from the directory of `from_note_rel` to `to_target_rel`.
pub fn relativize_path(from_note_rel: &str, to_target_rel: &str) -> String {
    let from_dir = Path::new(from_note_rel)
        .parent()
        .unwrap_or_else(|| Path::new(""));
    let target_path = Path::new(to_target_rel);

    // If both are in same directory
    if from_dir == target_path.parent().unwrap_or_else(|| Path::new("")) {
        let file_name = target_path
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or(to_target_rel);
        return format!("./{}", file_name);
    }

    let from_components: Vec<_> = from_dir.components().collect();
    let target_components: Vec<_> = target_path.components().collect();

    let mut common_len = 0;
    while common_len < from_components.len()
        && common_len < target_components.len()
        && from_components[common_len] == target_components[common_len]
    {
        common_len += 1;
    }

    let up_count = from_components.len() - common_len;
    let mut result_parts = Vec::new();
    result_parts.extend(std::iter::repeat_n("..", up_count));

    for comp in &target_components[common_len..] {
        if let Component::Normal(s) = comp {
            if let Some(s_str) = s.to_str() {
                result_parts.push(s_str);
            }
        }
    }

    let joined = result_parts.join("/");
    if up_count == 0 {
        format!("./{}", joined)
    } else {
        joined
    }
}

/// Locate a section by its heading path (root heading text first, then each nested
/// sub-heading's text in order), matching the same nesting rules the outline panel
/// (`src/services/outline.ts`, M10.09) uses to build its tree. Returns the matched heading
/// plus the source line where its section ends (the line of the next heading at the same or
/// shallower level, or `None` if the section runs to end of file).
fn find_section(
    headings: &[HeadingItem],
    heading_path: &[String],
) -> Result<(HeadingItem, Option<usize>), NoteError> {
    if heading_path.is_empty() {
        return Err(NoteError::NotFound("empty heading path".to_string()));
    }

    let mut window_start = 0usize;
    let mut window_end = headings.len();
    let mut matched_idx = None;

    for name in heading_path {
        let found = (window_start..window_end).find(|&i| &headings[i].text == name);
        let idx = found.ok_or_else(|| {
            NoteError::NotFound(format!(
                "heading not found: {} (path: {:?})",
                name, heading_path
            ))
        })?;
        matched_idx = Some(idx);
        let level = headings[idx].level;
        let end = headings[(idx + 1)..]
            .iter()
            .position(|h| h.level <= level)
            .map(|offset| idx + 1 + offset)
            .unwrap_or(headings.len());
        window_start = idx + 1;
        window_end = end;
    }

    let idx = matched_idx.expect("heading_path is non-empty, so a match was always attempted");
    let level = headings[idx].level;
    let mut boundary_line = None;
    for h in &headings[(idx + 1)..] {
        if h.level <= level {
            boundary_line = Some(h.line);
            break;
        }
    }

    Ok((headings[idx].clone(), boundary_line))
}

/// Replace one section's body Markdown (everything under a heading, up to but not including
/// its next same-or-shallower-level sibling) without touching the heading line itself, any
/// other section, or the fingerprint-conflict path `note_write` already enforces
/// (M10.21 — MCP `note_patch_section` tool).
///
/// `heading_path` names the target section from the top: `["Intro", "Details"]` means the
/// `Details` sub-heading nested under `Intro`. Returns the new fingerprint and full content.
pub fn patch_section(
    root: &Path,
    safe_path: &SafePath,
    heading_path: &[String],
    new_body: &str,
    expected_fingerprint: Option<&Fingerprint>,
) -> Result<(Fingerprint, String), NoteError> {
    let current = read_note(root, safe_path)?;
    if let Some(expected) = expected_fingerprint {
        if expected.content_hash != current.fingerprint.content_hash {
            return Err(NoteError::Conflict {
                expected: Some(Box::new(expected.clone())),
                actual: Some(Box::new(current.fingerprint.clone())),
            });
        }
    }

    let headings = extract_headings(&current.content);
    let (target, boundary_line) = find_section(&headings, heading_path)?;

    let lines: Vec<&str> = current.content.lines().collect();
    let body_start_line = (target.line + 1).min(lines.len());
    let body_end_line = boundary_line.unwrap_or(lines.len()).max(body_start_line);

    let mut out = String::new();
    for line in &lines[..body_start_line] {
        out.push_str(line);
        out.push('\n');
    }
    out.push('\n');
    let trimmed_body = new_body.trim_end_matches('\n');
    if !trimmed_body.is_empty() {
        out.push_str(trimmed_body);
        out.push('\n');
    }
    if boundary_line.is_some() {
        out.push('\n');
    }
    for line in &lines[body_end_line..] {
        out.push_str(line);
        out.push('\n');
    }
    if !current.content.ends_with('\n') && out.ends_with('\n') {
        out.pop();
    }

    let fp = write_note_atomic(root, safe_path, &out, Some(&current.fingerprint))?;
    Ok((fp, out))
}

/// Where an inserted cross-link lands (M10.21 — MCP `note_insert_link` tool).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum LinkLocation {
    /// Append to the note's "Related" section, creating one (a trailing `## Related` heading
    /// with a bullet list) if the note doesn't already have one.
    Related,
    /// Insert immediately after the given 0-based source line.
    AfterLine { line: usize },
}

/// Insert a Markdown inline link to `target_note_rel` into `safe_path`'s note, resolving the
/// relative path the same way the editor's link-autocomplete does (`relativize_path`), so
/// agent-authored links use the same convention as human-authored ones (M10.21 — MCP
/// `note_insert_link` tool). `link_text` defaults to the target note's title (falling back to
/// its file stem if the target can't be read). Returns the new fingerprint and full content.
pub fn insert_link(
    root: &Path,
    safe_path: &SafePath,
    target_note_rel: &str,
    link_text: Option<&str>,
    location: LinkLocation,
    expected_fingerprint: Option<&Fingerprint>,
) -> Result<(Fingerprint, String), NoteError> {
    let current = read_note(root, safe_path)?;
    if let Some(expected) = expected_fingerprint {
        if expected.content_hash != current.fingerprint.content_hash {
            return Err(NoteError::Conflict {
                expected: Some(Box::new(expected.clone())),
                actual: Some(Box::new(current.fingerprint.clone())),
            });
        }
    }

    let source_rel = safe_path.to_posix_string();
    let target_safe = SafePath::resolve(root, target_note_rel)?;
    let rel_link = relativize_path(&source_rel, &target_safe.to_posix_string());

    let owned_title;
    let text = match link_text {
        Some(t) => t,
        None => {
            owned_title = read_note(root, &target_safe)
                .map(|c| c.meta.title)
                .unwrap_or_else(|_| {
                    Path::new(target_note_rel)
                        .file_stem()
                        .and_then(|s| s.to_str())
                        .unwrap_or(target_note_rel)
                        .to_string()
                });
            &owned_title
        }
    };
    let md_link = format!("[{}]({})", text, rel_link);

    let new_content = match location {
        LinkLocation::AfterLine { line } => {
            let lines: Vec<&str> = current.content.lines().collect();
            let insert_at = (line + 1).min(lines.len());
            let mut out = String::new();
            for l in &lines[..insert_at] {
                out.push_str(l);
                out.push('\n');
            }
            out.push_str(&md_link);
            out.push('\n');
            for l in &lines[insert_at..] {
                out.push_str(l);
                out.push('\n');
            }
            out
        }
        LinkLocation::Related => {
            let headings = extract_headings(&current.content);
            let related_idx = headings
                .iter()
                .position(|h| h.text.eq_ignore_ascii_case("related"));
            let lines: Vec<&str> = current.content.lines().collect();
            match related_idx {
                Some(i) => {
                    let level = headings[i].level;
                    let mut boundary = lines.len();
                    for h in &headings[(i + 1)..] {
                        if h.level <= level {
                            boundary = h.line;
                            break;
                        }
                    }
                    let mut out = String::new();
                    for l in &lines[..boundary] {
                        out.push_str(l);
                        out.push('\n');
                    }
                    out.push_str(&format!("- {}\n", md_link));
                    for l in &lines[boundary..] {
                        out.push_str(l);
                        out.push('\n');
                    }
                    out
                }
                None => {
                    let mut out = current.content.clone();
                    if !out.ends_with('\n') {
                        out.push('\n');
                    }
                    if !out.ends_with("\n\n") {
                        out.push('\n');
                    }
                    out.push_str("## Related\n\n");
                    out.push_str(&format!("- {}\n", md_link));
                    out
                }
            }
        }
    };

    let fp = write_note_atomic(root, safe_path, &new_content, Some(&current.fingerprint))?;
    Ok((fp, new_content))
}

/// Parse and rewrite Markdown inline link destinations pointing to moved notes.
///
/// Rules:
/// - Links inside fenced code blocks (\`\`\` or ~~~) and inline code (\`...\`) are strictly preserved.
/// - Anchors (e.g. `#section`) and URL percent-encoding are preserved.
/// - Returns `(new_content, rewritten_count)`.
pub fn rewrite_markdown_links(
    workspace_root: &Path,
    source_note_rel: &str,
    content: &str,
    moved_notes_map: &HashMap<String, String>,
) -> (String, usize) {
    use pulldown_cmark::{Event, Options, Parser, Tag, TagEnd};

    if moved_notes_map.is_empty() {
        return (content.to_string(), 0);
    }

    let (_fm_raw, body, _, _) = parse_front_matter(content);
    let body_offset = content.len() - body.len();

    let mut options = Options::empty();
    options.insert(Options::ENABLE_TABLES);
    options.insert(Options::ENABLE_FOOTNOTES);
    options.insert(Options::ENABLE_STRIKETHROUGH);
    options.insert(Options::ENABLE_TASKLISTS);

    let parser = Parser::new_ext(body, options).into_offset_iter();

    let mut replacements = Vec::new();
    let mut pending_link: Option<(String, usize)> = None; // (trimmed, start_pos)

    for (event, range) in parser {
        match event {
            Event::Start(Tag::Link { dest_url, .. }) => {
                let raw_dest = dest_url.to_string();
                let trimmed = raw_dest.trim().to_string();
                pending_link = Some((trimmed, range.start));
            }
            Event::End(TagEnd::Link) => {
                if let Some((trimmed, start_pos)) = pending_link.take() {
                    if trimmed.starts_with("http://")
                        || trimmed.starts_with("https://")
                        || trimmed.starts_with("mailto:")
                        || trimmed.starts_with("ftp://")
                    {
                        continue;
                    }

                    let full_range = start_pos..range.end;
                    if full_range.end > body.len() || full_range.start >= full_range.end {
                        continue;
                    }

                    // Resolve target
                    let resolution = resolve_link_target(workspace_root, source_note_rel, &trimmed);
                    let resolved_note = match resolution {
                        ResolvedTarget::Internal { path, .. } => path,
                        ResolvedTarget::Unresolved { raw_path, .. } => raw_path,
                        _ => continue,
                    };

                    // Check if resolved note is in moved map
                    if let Some(new_target_path) = moved_notes_map.get(&resolved_note) {
                        if new_target_path == &resolved_note
                            && !moved_notes_map.contains_key(source_note_rel)
                        {
                            continue;
                        }

                        let has_percent_encoding = trimmed.contains('%');
                        let (_, anchor_opt) = match trimmed.split_once('#') {
                            Some((_, a)) => ((), Some(a)),
                            None => ((), None),
                        };

                        let current_source = moved_notes_map
                            .get(source_note_rel)
                            .map(|s| s.as_str())
                            .unwrap_or(source_note_rel);

                        let mut new_rel = relativize_path(current_source, new_target_path);

                        if has_percent_encoding {
                            new_rel = new_rel.replace(' ', "%20");
                        }

                        let new_dest = if let Some(anchor) = anchor_opt {
                            format!("{}#{}", new_rel, anchor)
                        } else {
                            new_rel
                        };

                        // In the full link range `[text](dest)`
                        let link_slice = &body[full_range.clone()];
                        if let Some(dest_pos_in_slice) = link_slice.rfind('(') {
                            if let Some(close_paren) = link_slice[dest_pos_in_slice..].find(')') {
                                let dest_start_in_slice = dest_pos_in_slice + 1;
                                let dest_end_in_slice = dest_pos_in_slice + close_paren;
                                let raw_slice_dest =
                                    &link_slice[dest_start_in_slice..dest_end_in_slice];

                                if raw_slice_dest.trim() == trimmed {
                                    let abs_dest_start =
                                        body_offset + full_range.start + dest_start_in_slice;
                                    let abs_dest_end =
                                        body_offset + full_range.start + dest_end_in_slice;

                                    replacements.push((abs_dest_start, abs_dest_end, new_dest));
                                }
                            }
                        }
                    }
                }
            }
            _ => {}
        }
    }

    if replacements.is_empty() {
        return (content.to_string(), 0);
    }

    // Sort replacements descending by start position to apply from back to front
    replacements.sort_by_key(|a| std::cmp::Reverse(a.0));

    let mut updated = content.to_string();
    let count = replacements.len();

    for (start, end, replacement) in replacements {
        if start <= end && end <= updated.len() {
            updated.replace_range(start..end, &replacement);
        }
    }

    (updated, count)
}

/// Byte length, within a wikilink span's inner text (`target#heading|alias`), of just the
/// `target` portion — up to the first *unescaped* `#` or `|`, matching the same escaping rule
/// [`crate::md_extensions::scan_wikilink_spans`] uses. Used by rename rewriting to replace only
/// the target text and leave `#heading`/`|alias` untouched.
fn wikilink_target_byte_len(inner: &str) -> usize {
    let bytes = inner.as_bytes();
    let len = bytes.len();
    let mut i = 0;
    while i < len {
        match bytes[i] {
            b'\\' if i + 1 < len => i += 2,
            b'#' | b'|' => return i,
            _ => i += 1,
        }
    }
    len
}

/// Rewrite wikilink `target`s pointing at moved notes (M10.23), preserving `|alias`, `#heading`,
/// and the `[[`/`![[` form exactly. A bare-name wikilink whose resolution is `Ambiguous` is left
/// untouched and counted in the returned skip count — there is no single note to know the rename
/// applies to. Returns `(new_content, rewritten_count, skipped_ambiguous_count)`.
pub fn rewrite_wikilinks_for_rename(
    workspace_root: &Path,
    source_note_rel: &str,
    content: &str,
    moved_notes_map: &HashMap<String, String>,
    filename_stems: &HashMap<String, Vec<NotePath>>,
) -> (String, usize, usize) {
    if moved_notes_map.is_empty() {
        return (content.to_string(), 0, 0);
    }
    let spans = md_extensions::scan_wikilink_spans(content);
    if spans.is_empty() {
        return (content.to_string(), 0, 0);
    }

    let mut replacements = Vec::new();
    let mut skipped_ambiguous = 0;

    for span in &spans {
        let resolution = resolve_wikilink_target(
            workspace_root,
            source_note_rel,
            filename_stems,
            &span.target,
            span.heading.as_deref(),
        );

        match resolution {
            ResolvedTarget::Ambiguous(_) => {
                skipped_ambiguous += 1;
            }
            ResolvedTarget::Internal { path, .. } => {
                if let Some(new_target_path) = moved_notes_map.get(&path) {
                    if new_target_path == &path && !moved_notes_map.contains_key(source_note_rel) {
                        continue;
                    }
                    let current_source = moved_notes_map
                        .get(source_note_rel)
                        .map(|s| s.as_str())
                        .unwrap_or(source_note_rel);

                    let is_path_shaped = span.target.contains('/');
                    let new_target_text = if is_path_shaped {
                        relativize_path(current_source, new_target_path)
                    } else {
                        Path::new(new_target_path)
                            .file_stem()
                            .map(|s| s.to_string_lossy().to_string())
                            .unwrap_or_else(|| new_target_path.clone())
                    };

                    if new_target_text != span.target {
                        let content_start = span.start + if span.is_embed { 3 } else { 2 };
                        let inner_end = span.end - 2;
                        if content_start <= inner_end && inner_end <= content.len() {
                            let inner = &content[content_start..inner_end];
                            let target_len = wikilink_target_byte_len(inner);
                            replacements.push((
                                content_start,
                                content_start + target_len,
                                new_target_text,
                            ));
                        }
                    }
                }
            }
            _ => {}
        }
    }

    if replacements.is_empty() {
        return (content.to_string(), 0, skipped_ambiguous);
    }

    replacements.sort_by_key(|r| std::cmp::Reverse(r.0));
    let mut updated = content.to_string();
    let count = replacements.len();
    for (start, end, replacement) in replacements {
        if start <= end && end <= updated.len() {
            updated.replace_range(start..end, &replacement);
        }
    }
    (updated, count, skipped_ambiguous)
}

/// Rewrite all relative links resolving to moved notes across the entire workspace (SPEC §5.4).
/// `filename_stems` (an `Index`'s stem map) is used for wikilink bare-name rewriting; pass an
/// empty map to skip wikilink rewriting entirely (equivalent to `markdown.wikilinks` off).
pub fn rewrite_workspace_links_for_rename(
    root: &Path,
    moved_notes_map: &HashMap<String, String>,
    filename_stems: &HashMap<String, Vec<NotePath>>,
) -> Result<RewriteSummary, NoteError> {
    if moved_notes_map.is_empty() || !root.exists() {
        return Ok(RewriteSummary::default());
    }

    let mut total_links = 0;
    let mut total_notes = 0;
    let mut total_wikilinks_skipped = 0;
    let mut rewritten_notes = Vec::new();

    let walker = ignore::WalkBuilder::new(root)
        .hidden(false)
        .parents(true)
        .git_ignore(true)
        .git_global(true)
        .git_exclude(true)
        .build();

    for entry in walker.flatten() {
        let path = entry.path();
        if !path.is_file() || !is_note_path(path) {
            continue;
        }

        let rel = path.strip_prefix(root).unwrap_or(path);
        let mut is_ignored = false;
        for comp in rel.components() {
            if let Component::Normal(s) = comp {
                let name = s.to_string_lossy();
                if is_default_ignored(&name) {
                    is_ignored = true;
                    break;
                }
            }
        }
        if is_ignored {
            continue;
        }

        let posix_rel = to_posix_path(rel);
        if let Ok(safe_path) = SafePath::resolve(root, &posix_rel) {
            if let Ok(content) = fs::read_to_string(safe_path.as_path()) {
                let (after_markdown, markdown_count) =
                    rewrite_markdown_links(root, &posix_rel, &content, moved_notes_map);
                let (new_content, wikilink_count, skipped_ambiguous) = rewrite_wikilinks_for_rename(
                    root,
                    &posix_rel,
                    &after_markdown,
                    moved_notes_map,
                    filename_stems,
                );
                let rewritten_count = markdown_count + wikilink_count;
                total_wikilinks_skipped += skipped_ambiguous;

                if rewritten_count > 0 && new_content != content {
                    write_note_atomic(root, &safe_path, &new_content, None)?;
                    rewritten_notes.push((posix_rel.clone(), new_content));
                    total_links += rewritten_count;
                    total_notes += 1;
                }
            }
        }
    }

    Ok(RewriteSummary {
        links_updated: total_links,
        notes_updated: total_notes,
        rewritten_notes,
        wikilinks_skipped_ambiguous: total_wikilinks_skipped,
    })
}

/// Re-serialize a front-matter `tags:` field's raw value, matching whatever container shape the
/// original raw value used (inline `[a, b]` list, `- item` block list, or a single bare scalar)
/// so an unrelated stylistic change isn't introduced alongside the rename (M10.25).
fn serialize_tags_field(original_raw: &str, tags: &[String]) -> String {
    if tags.is_empty() {
        return String::new();
    }
    let trimmed = original_raw.trim_start();
    if trimmed.starts_with('[') {
        format!("[{}]", tags.join(", "))
    } else if trimmed.starts_with("- ") {
        tags.iter()
            .map(|t| format!("- {}", t))
            .collect::<Vec<_>>()
            .join("\n")
    } else if tags.len() == 1 {
        tags[0].clone()
    } else {
        format!("[{}]", tags.join(", "))
    }
}

/// Summary of a workspace-wide tag rename (M10.25).
#[derive(Debug, Default, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TagRenameSummary {
    pub notes_updated: usize,
    /// `(note_path, new_content)` for every note actually rewritten, so a caller can suppress the
    /// watcher for these writes and update the in-memory index without a re-read (mirrors
    /// `RewriteSummary::rewritten_notes`).
    #[serde(default)]
    pub rewritten_notes: Vec<(String, String)>,
}

/// Rename `old_tag` to `new_tag` across every note that carries it (case-insensitive match),
/// rewriting both representations per note: the front-matter `tags:` entry (always, since that's
/// the core meaning of "rename this tag") and, when `rewrite_inline` is true, every inline
/// `#old_tag` occurrence in the body too (M10.25). `tag_index` is an [`Index`]'s `tags` map, used
/// to find the affected notes directly rather than re-walking the whole workspace. A note counts
/// once in the returned summary even when both representations changed.
pub fn rewrite_tags_workspace(
    root: &Path,
    old_tag: &str,
    new_tag: &str,
    tag_index: &HashMap<String, Vec<NotePath>>,
    rewrite_inline: bool,
) -> Result<TagRenameSummary, NoteError> {
    let lower = old_tag.to_lowercase();
    let note_paths: Vec<NotePath> = tag_index
        .iter()
        .find(|(k, _)| k.to_lowercase() == lower)
        .map(|(_, v)| v.clone())
        .unwrap_or_default();

    let mut notes_updated = 0;
    let mut rewritten_notes = Vec::new();

    for note_path in &note_paths {
        let safe_path = match SafePath::resolve(root, note_path) {
            Ok(p) => p,
            Err(_) => continue,
        };
        let content = match fs::read_to_string(safe_path.as_path()) {
            Ok(c) => c,
            Err(_) => continue,
        };

        let (_, _, fm_tags, fields) = parse_front_matter(&content);
        let mut new_content = content.clone();
        let mut changed = false;

        if let Some(idx) = fields.iter().position(|(k, _)| k == "tags") {
            if fm_tags.iter().any(|t| t.eq_ignore_ascii_case(old_tag)) {
                let new_fm_tags: Vec<String> = fm_tags
                    .iter()
                    .map(|t| {
                        if t.eq_ignore_ascii_case(old_tag) {
                            new_tag.to_string()
                        } else {
                            t.clone()
                        }
                    })
                    .collect();
                let mut new_fields = fields.clone();
                new_fields[idx].1 = serialize_tags_field(&fields[idx].1, &new_fm_tags);
                new_content = set_front_matter_fields(&content, &new_fields);
                changed = true;
            }
        }

        if rewrite_inline {
            let spliced = {
                let (_, body_now, _, _) = parse_front_matter(&new_content);
                let (new_body, inline_count) = rewrite_inline_tags(body_now, old_tag, new_tag);
                if inline_count > 0 {
                    let body_offset = new_content.len() - body_now.len();
                    Some(format!("{}{}", &new_content[..body_offset], new_body))
                } else {
                    None
                }
            };
            if let Some(s) = spliced {
                new_content = s;
                changed = true;
            }
        }

        if changed && new_content != content {
            write_note_atomic(root, &safe_path, &new_content, None)?;
            rewritten_notes.push((note_path.clone(), new_content));
            notes_updated += 1;
        }
    }

    Ok(TagRenameSummary {
        notes_updated,
        rewritten_notes,
    })
}

/// The lookup key `filename_stems` uses for a note path: its filename stem, lower-cased (M10.23).
fn stem_key(note_path: &str) -> String {
    Path::new(note_path)
        .file_stem()
        .map(|s| s.to_string_lossy().to_lowercase())
        .unwrap_or_default()
}

impl Index {
    pub fn new() -> Self {
        Self {
            notes: HashMap::new(),
            links_out: HashMap::new(),
            links_in: HashMap::new(),
            filename_stems: HashMap::new(),
            wikilinks_enabled: false,
            tags: HashMap::new(),
        }
    }

    /// Find the canonical (first-seen-casing) key in `self.tags` matching `tag`
    /// case-insensitively, if one already exists (M10.25).
    fn tag_canonical_key(&self, tag: &str) -> Option<String> {
        let lower = tag.to_lowercase();
        self.tags
            .keys()
            .find(|k| k.to_lowercase() == lower)
            .cloned()
    }

    /// Record that `note_path` carries `tag`, reusing this tag's existing canonical casing (from
    /// whichever note introduced it first) if one is already known (M10.25).
    fn add_note_to_tag(&mut self, tag: &str, note_path: &NotePath) {
        let key = self
            .tag_canonical_key(tag)
            .unwrap_or_else(|| tag.to_string());
        let entry = self.tags.entry(key).or_default();
        if !entry.contains(note_path) {
            entry.push(note_path.clone());
        }
    }

    /// Remove `note_path` from every tag bucket it appears in, dropping any bucket that becomes
    /// empty as a result (M10.25).
    fn remove_note_from_all_tags(&mut self, note_path: &str) {
        let mut empty_keys = Vec::new();
        for (key, notes) in self.tags.iter_mut() {
            notes.retain(|p| p != note_path);
            if notes.is_empty() {
                empty_keys.push(key.clone());
            }
        }
        for key in empty_keys {
            self.tags.remove(&key);
        }
    }

    /// Turn `markdown.wikilinks` on/off for this in-memory index (M10.23), re-extracting every
    /// note's links (so previously-inert `[[...]]` spans start/stop being indexed) when the
    /// value actually changes. Call once after reading a workspace's config, right after
    /// [`Index::build_from_workspace`] — incremental updates ([`Index::insert_or_update_note`])
    /// pick up the current setting from `self.wikilinks_enabled` automatically afterward.
    pub fn set_wikilinks_enabled(&mut self, enabled: bool, root: &Path) {
        if self.wikilinks_enabled == enabled {
            return;
        }
        self.wikilinks_enabled = enabled;

        let paths: Vec<NotePath> = self.notes.keys().cloned().collect();
        for rel_posix in paths {
            let abs_path = root.join(&rel_posix);
            if let Ok(content) = fs::read_to_string(&abs_path) {
                let links =
                    extract_links_all(root, &rel_posix, &content, enabled, &self.filename_stems);
                self.links_out.insert(rel_posix, links);
            }
        }
        self.rebuild_links_in();
    }

    /// Build a full workspace index walking notes per SPEC §6.2.
    ///
    /// The `on_progress` callback is invoked as `(indexed_count, total_count)` for progress reporting.
    pub fn build_from_workspace<F: FnMut(usize, usize)>(
        root: &Path,
        mut on_progress: F,
    ) -> Result<Self, NoteError> {
        let mut index = Self::new();
        if !root.exists() || !root.is_dir() {
            return Ok(index);
        }

        // Collect all note paths first per SPEC §5.2
        let mut note_files = Vec::new();
        let walker = ignore::WalkBuilder::new(root)
            .hidden(false)
            .parents(false)
            .git_ignore(false)
            .git_global(false)
            .git_exclude(false)
            .require_git(false)
            .build();

        for entry in walker.flatten() {
            let path = entry.path();
            if !path.is_file() {
                continue;
            }

            // Check if ignored by default rules
            let rel = path.strip_prefix(root).unwrap_or(path);
            let mut is_ignored = false;
            for comp in rel.components() {
                if let Component::Normal(s) = comp {
                    let name = s.to_string_lossy();
                    if is_default_ignored(&name) {
                        is_ignored = true;
                        break;
                    }
                }
            }
            if is_ignored {
                continue;
            }

            if is_note_path(path) {
                if let Ok(safe) = SafePath::resolve(root, &to_posix_path(rel)) {
                    note_files.push(safe);
                }
            }
        }

        let total = note_files.len();
        on_progress(0, total);

        // First pass: notes + `filename_stems` (wikilink bare-name resolution below needs the
        // full stem map built before any note's links are extracted, so a link to a note later
        // in iteration order still resolves).
        let mut contents: HashMap<NotePath, String> = HashMap::new();
        for (i, safe_path) in note_files.iter().enumerate() {
            let rel_posix = safe_path.to_posix_string();
            let abs_path = safe_path.as_path();
            if let Ok(bytes) = fs::read(abs_path) {
                if let Ok(content) = String::from_utf8(bytes) {
                    let title = resolve_note_title(&content, safe_path.as_relative_path());
                    let headings = extract_headings(&content);
                    let (_, body, fm_tags, _) = parse_front_matter(&content);
                    let tags = merged_note_tags(fm_tags, body);
                    let meta = fs::metadata(abs_path).ok();
                    let size_bytes = meta.as_ref().map(|m| m.len()).unwrap_or(0);
                    let modified_ms = meta
                        .and_then(|m| m.modified().ok())
                        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                        .map(|d| d.as_millis() as u64)
                        .unwrap_or(0);

                    for tag in &tags {
                        index.add_note_to_tag(tag, &rel_posix);
                    }
                    index.notes.insert(
                        rel_posix.clone(),
                        NoteMeta {
                            path: rel_posix.clone(),
                            title,
                            size_bytes,
                            modified_ms,
                            headings,
                            tags,
                        },
                    );
                    index
                        .filename_stems
                        .entry(stem_key(&rel_posix))
                        .or_default()
                        .push(rel_posix.clone());
                    contents.insert(rel_posix, content);
                }
            }
            on_progress(i + 1, total);
        }

        // Second pass: extract links now that `filename_stems` is complete.
        for (rel_posix, content) in &contents {
            let links = extract_links_all(
                root,
                rel_posix,
                content,
                index.wikilinks_enabled,
                &index.filename_stems,
            );
            index.links_out.insert(rel_posix.clone(), links);
        }

        // Recompute links_in (backlinks graph)
        index.rebuild_links_in();

        Ok(index)
    }

    /// Rebuild derived `links_in` map from `links_out`.
    pub fn rebuild_links_in(&mut self) {
        let mut links_in: HashMap<NotePath, Vec<Link>> = HashMap::new();
        for links in self.links_out.values() {
            for link in links {
                if let Some(ref target) = link.resolved {
                    links_in
                        .entry(target.clone())
                        .or_default()
                        .push(link.clone());
                }
            }
        }
        self.links_in = links_in;
    }

    /// Insert or update a note incrementally (SPEC §6.2).
    pub fn insert_or_update_note(&mut self, root: &Path, safe_path: &SafePath, content: &str) {
        let rel_posix = safe_path.to_posix_string();
        let abs_path = safe_path.as_path();

        let title = resolve_note_title(content, safe_path.as_relative_path());
        let headings = extract_headings(content);
        let (_, body, fm_tags, _) = parse_front_matter(content);
        let tags = merged_note_tags(fm_tags, body);
        let meta = fs::metadata(abs_path).ok();
        let size_bytes = meta
            .as_ref()
            .map(|m| m.len())
            .unwrap_or(content.len() as u64);
        let modified_ms = meta
            .and_then(|m| m.modified().ok())
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as u64)
            .unwrap_or_else(|| {
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_millis() as u64)
                    .unwrap_or(0)
            });

        self.remove_note_from_all_tags(&rel_posix);
        for tag in &tags {
            self.add_note_to_tag(tag, &rel_posix);
        }

        self.notes.insert(
            rel_posix.clone(),
            NoteMeta {
                path: rel_posix.clone(),
                title,
                size_bytes,
                modified_ms,
                headings,
                tags,
            },
        );

        let stem = stem_key(&rel_posix);
        let stem_entry = self.filename_stems.entry(stem).or_default();
        if !stem_entry.contains(&rel_posix) {
            stem_entry.push(rel_posix.clone());
        }

        // Remove old incoming links for this source note
        for in_links in self.links_in.values_mut() {
            in_links.retain(|l| l.source != rel_posix);
        }

        let links = extract_links_all(
            root,
            &rel_posix,
            content,
            self.wikilinks_enabled,
            &self.filename_stems,
        );

        // Add newly resolved links to links_in
        for link in &links {
            if let Some(ref target) = link.resolved {
                self.links_in
                    .entry(target.clone())
                    .or_default()
                    .push(link.clone());
            }
        }

        self.links_out.insert(rel_posix.clone(), links);

        // Also re-resolve any links across the workspace that were previously unresolved (or, for
        // wikilinks, previously ambiguous — a filename-stem collision can be introduced or
        // resolved by this note's own creation/edit).
        for (source_path, out_links) in self.links_out.iter_mut() {
            if source_path == &rel_posix {
                continue;
            }
            for link in out_links.iter_mut() {
                if link.resolved.is_some() && link.ambiguous_with.is_empty() {
                    continue;
                }
                let is_external = link.raw_target.starts_with("http://")
                    || link.raw_target.starts_with("https://")
                    || link.raw_target.starts_with("mailto:")
                    || link.raw_target.starts_with("ftp://");
                if is_external {
                    continue;
                }
                let res = match link.syntax {
                    LinkSyntax::Markdown => {
                        resolve_link_target(root, source_path, &link.raw_target)
                    }
                    LinkSyntax::Wikilink => resolve_wikilink_target(
                        root,
                        source_path,
                        &self.filename_stems,
                        &link.raw_target,
                        None,
                    ),
                };
                match res {
                    ResolvedTarget::Internal { path, .. } => {
                        link.resolved = Some(path.clone());
                        link.ambiguous_with.clear();
                        self.links_in.entry(path).or_default().push(link.clone());
                    }
                    ResolvedTarget::Ambiguous(candidates) => {
                        link.resolved = None;
                        link.ambiguous_with = candidates;
                    }
                    _ => {}
                }
            }
        }
    }

    /// Remove a note from the index on deletion (SPEC §6.2).
    pub fn remove_note(&mut self, _root: Option<&Path>, rel_path: &str) {
        self.notes.remove(rel_path);
        self.links_out.remove(rel_path);
        self.remove_note_from_all_tags(rel_path);

        let stem = stem_key(rel_path);
        if let Some(entry) = self.filename_stems.get_mut(&stem) {
            entry.retain(|p| p != rel_path);
            if entry.is_empty() {
                self.filename_stems.remove(&stem);
            }
        }

        // Remove from links_in where this note was target
        self.links_in.remove(rel_path);

        // Remove from links_in where this note was source
        for in_links in self.links_in.values_mut() {
            in_links.retain(|l| l.source != rel_path);
        }

        // Mark any links pointing to this deleted note as unresolved
        for out_links in self.links_out.values_mut() {
            for link in out_links.iter_mut() {
                if link.resolved.as_deref() == Some(rel_path) {
                    link.resolved = None;
                }
            }
        }
    }

    /// Retrieve backlinks for a note grouped by source note and ordered by source note title (SPEC §6.4).
    pub fn get_backlinks(&self, note_path: &str) -> Vec<BacklinkGroup> {
        let raw_links = match self.links_in.get(note_path) {
            Some(links) => links,
            None => return Vec::new(),
        };

        // Group by source note
        let mut groups_map: HashMap<NotePath, Vec<BacklinkOccurrence>> = HashMap::new();
        for link in raw_links {
            groups_map
                .entry(link.source.clone())
                .or_default()
                .push(BacklinkOccurrence {
                    line: link.line,
                    context: link.context.clone(),
                });
        }

        let mut result: Vec<BacklinkGroup> = groups_map
            .into_iter()
            .map(|(source_path, mut occurrences)| {
                // Sort occurrences by line number
                occurrences.sort_by_key(|occ| occ.line);

                let source_title = self
                    .notes
                    .get(&source_path)
                    .map(|n| n.title.clone())
                    .unwrap_or_else(|| {
                        source_path
                            .split('/')
                            .next_back()
                            .unwrap_or(&source_path)
                            .trim_end_matches(".md")
                            .trim_end_matches(".markdown")
                            .to_string()
                    });

                let folder = Path::new(&source_path)
                    .parent()
                    .map(to_posix_path)
                    .unwrap_or_default();

                BacklinkGroup {
                    source_path,
                    source_title,
                    folder,
                    occurrences,
                }
            })
            .collect();

        // Order groups by title case-insensitively
        result.sort_by(|a, b| {
            a.source_title
                .to_lowercase()
                .cmp(&b.source_title.to_lowercase())
        });

        result
    }

    /// Calculate workspace statistics (note count, link count, unresolved count) (SPEC §6.1, §11).
    pub fn get_stats(&self) -> WorkspaceStats {
        let note_count = self.notes.len();
        let mut link_count = 0;
        let mut unresolved_count = 0;

        for links in self.links_out.values() {
            for link in links {
                link_count += 1;
                // An internal link is unresolved if it's not external and resolved is None
                let is_external = link.raw_target.starts_with("http://")
                    || link.raw_target.starts_with("https://")
                    || link.raw_target.starts_with("mailto:")
                    || link.raw_target.starts_with("ftp://");
                if !is_external && link.resolved.is_none() {
                    unresolved_count += 1;
                }
            }
        }

        WorkspaceStats {
            note_count,
            link_count,
            unresolved_count,
        }
    }

    /// Retrieve all unresolved links across the workspace.
    pub fn get_unresolved_links(&self) -> Vec<Link> {
        let mut unresolved = Vec::new();
        for links in self.links_out.values() {
            for link in links {
                let is_external = link.raw_target.starts_with("http://")
                    || link.raw_target.starts_with("https://")
                    || link.raw_target.starts_with("mailto:")
                    || link.raw_target.starts_with("ftp://");
                if !is_external && link.resolved.is_none() {
                    unresolved.push(link.clone());
                }
            }
        }
        unresolved.sort_by(|a, b| a.source.cmp(&b.source).then_with(|| a.line.cmp(&b.line)));
        unresolved
    }

    /// Retrieve all indexed notes as a list.
    pub fn get_note_list(&self) -> Vec<NoteMeta> {
        let mut notes: Vec<NoteMeta> = self.notes.values().cloned().collect();
        notes.sort_by(|a, b| {
            a.title
                .to_lowercase()
                .cmp(&b.title.to_lowercase())
                .then_with(|| a.path.cmp(&b.path))
        });
        notes
    }

    /// Search note names and paths fuzzily across the index (SPEC §7, M9).
    ///
    /// Scored by:
    /// - Exact match: +1000
    /// - Prefix match: +500
    /// - Word boundary match: +200
    /// - Subsequence match: +10 per char, bonus for consecutive matches
    /// - Path depth penalty: -10 per slash (shallower paths score higher)
    pub fn search_names(&self, query: &str, limit: Option<usize>) -> Vec<NameHit> {
        let trimmed = query.trim();
        if trimmed.is_empty() {
            // Return top notes up to limit
            let max = limit.unwrap_or(30);
            return self
                .get_note_list()
                .into_iter()
                .take(max)
                .map(|n| NameHit {
                    path: n.path,
                    title: n.title,
                    score: 0,
                    match_indices_title: Vec::new(),
                    match_indices_path: Vec::new(),
                })
                .collect();
        }

        let query_lower = trimmed.to_lowercase();
        let query_chars: Vec<char> = query_lower.chars().collect();
        let mut hits = Vec::new();

        for note in self.notes.values() {
            let title_lower = note.title.to_lowercase();
            let path_lower = note.path.to_lowercase();

            let title_match = fuzzy_match_subsequence(&query_chars, &title_lower);
            let path_match = fuzzy_match_subsequence(&query_chars, &path_lower);

            if let Some((score_title, indices_title)) = title_match {
                let depth = note.path.matches('/').count() as i64;
                let final_score = score_title + 50 - (depth * 5);
                hits.push(NameHit {
                    path: note.path.clone(),
                    title: note.title.clone(),
                    score: final_score,
                    match_indices_title: indices_title,
                    match_indices_path: Vec::new(),
                });
            } else if let Some((score_path, indices_path)) = path_match {
                let depth = note.path.matches('/').count() as i64;
                let final_score = score_path - (depth * 10);
                hits.push(NameHit {
                    path: note.path.clone(),
                    title: note.title.clone(),
                    score: final_score,
                    match_indices_title: Vec::new(),
                    match_indices_path: indices_path,
                });
            }
        }

        hits.sort_by(|a, b| b.score.cmp(&a.score).then_with(|| a.path.cmp(&b.path)));

        if let Some(l) = limit {
            hits.truncate(l);
        }

        hits
    }
}

/// Helper function to perform fuzzy subsequence matching and scoring.
/// Returns Option<(score, match_indices)>
fn fuzzy_match_subsequence(query_chars: &[char], target: &str) -> Option<(i64, Vec<usize>)> {
    if query_chars.is_empty() {
        return Some((0, Vec::new()));
    }

    let target_chars: Vec<char> = target.chars().collect();
    if target_chars.is_empty() {
        return None;
    }

    // Exact match check
    let query_str: String = query_chars.iter().collect();
    if target == query_str {
        return Some((1000, (0..target.len()).collect()));
    }

    // Substring match check
    if let Some(pos) = target.find(&query_str) {
        let is_word_boundary = pos == 0
            || target
                .chars()
                .nth(pos - 1)
                .map(|c| !c.is_alphanumeric())
                .unwrap_or(true);
        let score = if pos == 0 {
            500 + (query_chars.len() as i64 * 20)
        } else if is_word_boundary {
            300 + (query_chars.len() as i64 * 15)
        } else {
            150 + (query_chars.len() as i64 * 10)
        };
        return Some((score, (pos..pos + query_str.len()).collect()));
    }

    // Greedy subsequence match
    let mut q_idx = 0;
    let mut indices = Vec::with_capacity(query_chars.len());
    let mut score = 0i64;
    let mut last_match_idx = None;

    for (t_idx, &tc) in target_chars.iter().enumerate() {
        if q_idx < query_chars.len() && tc == query_chars[q_idx] {
            indices.push(t_idx);
            let mut char_score = 10;

            // Bonus for consecutive matches
            if let Some(prev) = last_match_idx {
                if prev + 1 == t_idx {
                    char_score += 15;
                }
            }

            // Bonus for word boundaries (start of string or after non-alphanumeric)
            if t_idx == 0 || (t_idx > 0 && !target_chars[t_idx - 1].is_alphanumeric()) {
                char_score += 25;
            }

            score += char_score;
            last_match_idx = Some(t_idx);
            q_idx += 1;
        }
    }

    if q_idx == query_chars.len() {
        Some((score, indices))
    } else {
        None
    }
}

/// Search note content in parallel using `rayon` with regex, whole word, case sensitivity, and glob filters (SPEC §7, M9).
pub fn search_content(
    root: &Path,
    query: &str,
    options: &ContentSearchOptions,
) -> Result<Vec<ContentHitGroup>, String> {
    if query.trim().is_empty() {
        return Ok(Vec::new());
    }

    // Prepare Regex pattern
    let pattern_str = if options.is_regex {
        if options.whole_word {
            format!(r"\b(?:{})\b", query)
        } else {
            query.to_string()
        }
    } else {
        let escaped = regex::escape(query);
        if options.whole_word {
            format!(r"\b{}\b", escaped)
        } else {
            escaped
        }
    };

    let regex = regex::RegexBuilder::new(&pattern_str)
        .case_insensitive(!options.case_sensitive)
        .build()
        .map_err(|e| format!("Invalid regex: {}", e))?;

    // Build include / exclude glob matchers if specified
    let include_builder = if !options.includes.is_empty() {
        let mut builder = globset::GlobSetBuilder::new();
        for inc in &options.includes {
            let glob = globset::Glob::new(inc)
                .map_err(|e| format!("Invalid include glob '{}': {}", inc, e))?;
            builder.add(glob);
        }
        Some(builder.build().map_err(|e| e.to_string())?)
    } else {
        None
    };

    let exclude_builder = if !options.excludes.is_empty() {
        let mut builder = globset::GlobSetBuilder::new();
        for exc in &options.excludes {
            let glob = globset::Glob::new(exc)
                .map_err(|e| format!("Invalid exclude glob '{}': {}", exc, e))?;
            builder.add(glob);
        }
        Some(builder.build().map_err(|e| e.to_string())?)
    } else {
        None
    };

    // Collect note candidate paths per SPEC §5.2
    let walker = ignore::WalkBuilder::new(root)
        .hidden(false)
        .parents(false)
        .git_ignore(false)
        .git_global(false)
        .git_exclude(false)
        .require_git(false)
        .build();

    let mut note_paths = Vec::new();
    for entry in walker.flatten() {
        let path = entry.path();
        if !path.is_file() || !is_note_path(path) {
            continue;
        }

        let rel = path.strip_prefix(root).unwrap_or(path);

        // Check if any component is default ignored
        let mut is_ignored = false;
        for comp in rel.components() {
            if let Component::Normal(s) = comp {
                let name = s.to_string_lossy();
                if is_default_ignored(&name) {
                    is_ignored = true;
                    break;
                }
            }
        }
        if is_ignored {
            continue;
        }

        let posix_rel = to_posix_path(rel);

        // Check folder scope
        if let Some(ref folder) = options.folder_scope {
            let clean_folder = folder.trim().trim_matches('/');
            if !clean_folder.is_empty()
                && !posix_rel.starts_with(&format!("{}/", clean_folder))
                && posix_rel != clean_folder
            {
                continue;
            }
        }

        // Check include globs
        if let Some(ref inc) = include_builder {
            if !inc.is_match(&posix_rel) {
                continue;
            }
        }

        // Check exclude globs
        if let Some(ref exc) = exclude_builder {
            if exc.is_match(&posix_rel) {
                continue;
            }
        }

        if let Ok(safe) = SafePath::resolve(root, &posix_rel) {
            note_paths.push(safe);
        }
    }

    // Scan in parallel with rayon
    use rayon::prelude::*;
    let results: Vec<ContentHitGroup> = note_paths
        .par_iter()
        .filter_map(|safe_path| {
            let abs_path = safe_path.as_path();
            let posix = safe_path.to_posix_string();
            let content = fs::read_to_string(abs_path).ok()?;
            let title = resolve_note_title(&content, safe_path.as_relative_path());
            let searchable_content = crate::md_extensions::strip_comments(&content);

            let mut hits = Vec::new();
            for (line_idx, line) in searchable_content.lines().enumerate() {
                for mat in regex.find_iter(line) {
                    hits.push(ContentHit {
                        line: (line_idx + 1) as u32,
                        col: (mat.start() + 1) as u32,
                        match_length: mat.end() - mat.start(),
                        line_text: line.to_string(),
                    });
                }
            }

            if !hits.is_empty() {
                Some(ContentHitGroup {
                    path: posix,
                    title,
                    matches: hits,
                })
            } else {
                None
            }
        })
        .collect();

    let mut sorted_results = results;
    sorted_results.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(sorted_results)
}

/// Perform workspace health checks: broken links, orphan notes, unreadable files (SPEC §4, §13, M9).
pub fn check_workspace_health(root: &Path) -> Result<DoctorReport, String> {
    if !root.exists() || !root.is_dir() {
        return Err(format!("Workspace directory not found: {}", root.display()));
    }

    let mut unreadable_files = Vec::new();
    let walker = ignore::WalkBuilder::new(root)
        .hidden(false)
        .parents(false)
        .git_ignore(false)
        .git_global(false)
        .git_exclude(false)
        .require_git(false)
        .build();

    let mut _total_notes = 0;
    for entry in walker.flatten() {
        let path = entry.path();
        if path.is_file() && is_note_path(path) {
            let rel = path.strip_prefix(root).unwrap_or(path);

            // Check if ignored by default rules
            let mut is_ignored = false;
            for comp in rel.components() {
                if let Component::Normal(s) = comp {
                    let name = s.to_string_lossy();
                    if is_default_ignored(&name) {
                        is_ignored = true;
                        break;
                    }
                }
            }
            if is_ignored {
                continue;
            }

            _total_notes += 1;
            if fs::read_to_string(path).is_err() {
                unreadable_files.push(to_posix_path(rel));
            }
        }
    }

    let index = Index::build_from_workspace(root, |_, _| {})
        .map_err(|e| format!("Index build error: {}", e))?;

    let broken_links = index.get_unresolved_links();

    // Find orphan notes: notes that have 0 incoming links and 0 outgoing links
    let mut orphan_notes = Vec::new();
    for note_path in index.notes.keys() {
        let out_links_count = index.links_out.get(note_path).map(|l| l.len()).unwrap_or(0);
        let in_links_count = index.links_in.get(note_path).map(|l| l.len()).unwrap_or(0);

        if out_links_count == 0 && in_links_count == 0 {
            orphan_notes.push(note_path.clone());
        }
    }
    orphan_notes.sort();

    let stats = index.get_stats();

    Ok(DoctorReport {
        workspace: root.display().to_string(),
        note_count: stats.note_count,
        link_count: stats.link_count,
        broken_links,
        orphan_notes,
        unreadable_files,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn patch_section_replaces_only_matched_body() {
        let dir = tempdir().unwrap();
        let root = dir.path();
        fs::write(
            root.join("note.md"),
            "# Title\n\nIntro text.\n\n## Details\n\nold body.\n\n## Other\n\nuntouched.\n",
        )
        .unwrap();
        let safe = SafePath::resolve(root, "note.md").unwrap();

        let (_, new_content) =
            patch_section(root, &safe, &["Details".to_string()], "new body.", None).unwrap();

        assert!(new_content.contains("## Details\n\nnew body.\n"));
        assert!(new_content.contains("## Other\n\nuntouched.\n"));
        assert!(!new_content.contains("old body."));
    }

    #[test]
    fn patch_section_supports_nested_heading_path() {
        let dir = tempdir().unwrap();
        let root = dir.path();
        fs::write(
            root.join("note.md"),
            "# Intro\n\nintro body.\n\n## Sub\n\nold sub body.\n\n# Next\n\nnext body.\n",
        )
        .unwrap();
        let safe = SafePath::resolve(root, "note.md").unwrap();

        let (_, new_content) = patch_section(
            root,
            &safe,
            &["Intro".to_string(), "Sub".to_string()],
            "new sub body.",
            None,
        )
        .unwrap();

        assert!(new_content.contains("## Sub\n\nnew sub body.\n"));
        assert!(new_content.contains("# Next\n\nnext body.\n"));
    }

    #[test]
    fn patch_section_missing_heading_errors() {
        let dir = tempdir().unwrap();
        let root = dir.path();
        fs::write(root.join("note.md"), "# Title\n\nbody.\n").unwrap();
        let safe = SafePath::resolve(root, "note.md").unwrap();

        let err = patch_section(root, &safe, &["Nope".to_string()], "x", None).unwrap_err();
        assert!(matches!(err, NoteError::NotFound(_)));
    }

    #[test]
    fn patch_section_detects_conflict() {
        let dir = tempdir().unwrap();
        let root = dir.path();
        fs::write(root.join("note.md"), "## Details\n\nbody.\n").unwrap();
        let safe = SafePath::resolve(root, "note.md").unwrap();
        let stale = Fingerprint {
            path: "note.md".to_string(),
            size_bytes: 0,
            modified_ms: 0,
            content_hash: "stale".to_string(),
        };

        let err =
            patch_section(root, &safe, &["Details".to_string()], "new", Some(&stale)).unwrap_err();
        assert!(matches!(err, NoteError::Conflict { .. }));
    }

    #[test]
    fn insert_link_appends_to_existing_related_section() {
        let dir = tempdir().unwrap();
        let root = dir.path();
        fs::create_dir_all(root.join("notes")).unwrap();
        fs::write(
            root.join("notes/source.md"),
            "# Source\n\nbody.\n\n## Related\n\n- [old](./old.md)\n\n## After\n\nmore.\n",
        )
        .unwrap();
        fs::write(root.join("notes/target.md"), "# Target Note\n").unwrap();
        let safe = SafePath::resolve(root, "notes/source.md").unwrap();

        let (_, new_content) = insert_link(
            root,
            &safe,
            "notes/target.md",
            None,
            LinkLocation::Related,
            None,
        )
        .unwrap();

        assert!(new_content.contains("- [Target Note](./target.md)"));
        assert!(new_content.contains("- [old](./old.md)"));
        assert!(new_content.contains("## After\n\nmore.\n"));
    }

    #[test]
    fn insert_link_creates_related_section_when_absent() {
        let dir = tempdir().unwrap();
        let root = dir.path();
        fs::write(root.join("source.md"), "# Source\n\nbody.\n").unwrap();
        fs::write(root.join("target.md"), "# Target Note\n").unwrap();
        let safe = SafePath::resolve(root, "source.md").unwrap();

        let (_, new_content) =
            insert_link(root, &safe, "target.md", None, LinkLocation::Related, None).unwrap();

        assert!(new_content.contains("## Related\n\n- [Target Note](./target.md)"));
    }

    #[test]
    fn insert_link_after_line_uses_relative_path() {
        let dir = tempdir().unwrap();
        let root = dir.path();
        fs::create_dir_all(root.join("a/b")).unwrap();
        fs::write(root.join("a/b/source.md"), "line0\nline1\nline2\n").unwrap();
        fs::write(root.join("a/target.md"), "# Target Note\n").unwrap();
        let safe = SafePath::resolve(root, "a/b/source.md").unwrap();

        let (_, new_content) = insert_link(
            root,
            &safe,
            "a/target.md",
            Some("see target"),
            LinkLocation::AfterLine { line: 0 },
            None,
        )
        .unwrap();

        let lines: Vec<&str> = new_content.lines().collect();
        assert_eq!(lines[1], "[see target](../target.md)");
    }

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
    fn test_index_build_and_backlinks_and_stats() {
        let dir = tempdir().unwrap();
        let root = dir.path();

        // Create structure:
        // projects/payments/settlement.md -> links to ./rails.md and ./missing.md
        // projects/payments/rails.md -> links to ./settlement.md
        // daily.md -> links to projects/payments/settlement.md
        fs::create_dir_all(root.join("projects/payments")).unwrap();

        fs::write(
            root.join("projects/payments/settlement.md"),
            "# Settlement Windows\nSee [rails](./rails.md) and [missing note](./missing.md).",
        )
        .unwrap();

        fs::write(
            root.join("projects/payments/rails.md"),
            "---\ntitle: Payment Rails\n---\nRefers to [settlement](./settlement.md).",
        )
        .unwrap();

        fs::write(
            root.join("daily.md"),
            "# Daily Log\nCheck [settlement](/projects/payments/settlement.md).",
        )
        .unwrap();

        let mut progress_calls = Vec::new();
        let mut index = Index::build_from_workspace(root, |indexed, total| {
            progress_calls.push((indexed, total));
        })
        .unwrap();

        assert!(!progress_calls.is_empty());
        assert_eq!(progress_calls.last().unwrap().0, 3);
        assert_eq!(progress_calls.last().unwrap().1, 3);

        let stats = index.get_stats();
        assert_eq!(stats.note_count, 3);
        assert_eq!(stats.link_count, 4); // settlement(2) + rails(1) + daily(1)
        assert_eq!(stats.unresolved_count, 1); // missing.md

        // Test backlinks for settlement.md
        let backlinks = index.get_backlinks("projects/payments/settlement.md");
        assert_eq!(backlinks.len(), 2); // daily.md and rails.md
        assert_eq!(backlinks[0].source_title, "Daily Log");
        assert_eq!(backlinks[0].source_path, "daily.md");
        assert_eq!(backlinks[1].source_title, "Payment Rails");
        assert_eq!(backlinks[1].source_path, "projects/payments/rails.md");
        assert_eq!(backlinks[1].occurrences.len(), 1);
        assert_eq!(backlinks[1].occurrences[0].line, 4);

        // Test incremental note addition
        let safe_new = SafePath::resolve(root, "projects/payments/missing.md").unwrap();
        fs::write(safe_new.as_path(), "# Missing Note\nResolved!").unwrap();
        index.insert_or_update_note(root, &safe_new, "# Missing Note\nResolved!");

        let stats_after = index.get_stats();
        assert_eq!(stats_after.note_count, 4);
        assert_eq!(stats_after.unresolved_count, 0);

        // Test remove note
        index.remove_note(Some(root), "daily.md");
        let stats_del = index.get_stats();
        assert_eq!(stats_del.note_count, 3);
        let backlinks_after_del = index.get_backlinks("projects/payments/settlement.md");
        assert_eq!(backlinks_after_del.len(), 1);
        assert_eq!(
            backlinks_after_del[0].source_path,
            "projects/payments/rails.md"
        );
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
        let tree = build_workspace_tree(root, false, &[]).unwrap();
        assert_eq!(tree.len(), 2); // projects/ (folder) and daily.md (note)
        assert_eq!(tree[0].name, "projects");
        assert!(tree[0].is_folder);
        assert_eq!(tree[1].name, "daily.md");
        assert_eq!(tree[1].title.as_deref(), Some("Daily Log"));

        // Tree with non-notes
        let tree_with_all = build_workspace_tree(root, true, &[]).unwrap();
        assert_eq!(tree_with_all.len(), 3); // projects/, daily.md, LICENSE
    }

    #[test]
    fn workspace_tree_respects_configured_ignore_globs() {
        let dir = tempdir().unwrap();
        let root = dir.path();

        fs::create_dir_all(root.join("vendor")).unwrap();
        fs::write(root.join("vendor/lib.md"), "# Vendored").unwrap();
        fs::write(root.join("keep.md"), "# Keep").unwrap();

        // No ignore patterns: both notes present.
        let tree = build_workspace_tree(root, false, &[]).unwrap();
        assert_eq!(tree.len(), 2);

        // With a configured glob not covered by the hardcoded baseline: vendor/ excluded.
        let ignore = vec!["vendor/**".to_string()];
        let tree = build_workspace_tree(root, false, &ignore).unwrap();
        assert_eq!(tree.len(), 1);
        assert_eq!(tree[0].name, "keep.md");
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
    fn test_parse_front_matter_fields_ordered() {
        let content = "---\ntitle: Safe Note\nauthor: Alice\ntags: [tag1, tag2]\nkeywords:\n- one\n- two\n---\nBody text.\n";
        let (_, body, _, fields) = parse_front_matter(content);
        assert_eq!(body, "Body text.\n");
        assert_eq!(
            fields,
            vec![
                ("title".to_string(), "Safe Note".to_string()),
                ("author".to_string(), "Alice".to_string()),
                ("tags".to_string(), "[tag1, tag2]".to_string()),
                ("keywords".to_string(), "- one\n- two".to_string()),
            ]
        );
    }

    #[test]
    fn test_set_front_matter_fields_edit_preserves_other_lines_and_body() {
        let content =
            "---\ntitle: Safe Note\nauthor: Alice\ncustom_field: preserve_me\n---\n# Heading\n\nBody.\n";
        let (_, _, _, mut fields) = parse_front_matter(content);
        // Edit only the "title" field.
        fields[0].1 = "New Title".to_string();
        let updated = set_front_matter_fields(content, &fields);
        assert_eq!(
            updated,
            "---\ntitle: New Title\nauthor: Alice\ncustom_field: preserve_me\n---\n# Heading\n\nBody.\n"
        );
    }

    #[test]
    fn test_set_front_matter_fields_delete_field() {
        let content = "---\ntitle: Safe Note\nauthor: Alice\n---\nBody.\n";
        let (_, _, _, fields) = parse_front_matter(content);
        let remaining: Vec<_> = fields.into_iter().filter(|(k, _)| k != "author").collect();
        let updated = set_front_matter_fields(content, &remaining);
        assert_eq!(updated, "---\ntitle: Safe Note\n---\nBody.\n");
    }

    #[test]
    fn test_set_front_matter_fields_add_to_note_with_no_front_matter() {
        let content = "# Heading\n\nBody.\n";
        let updated = set_front_matter_fields(content, &[("title".to_string(), "New".to_string())]);
        assert_eq!(updated, "---\ntitle: New\n---\n# Heading\n\nBody.\n");
    }

    #[test]
    fn test_set_front_matter_fields_removing_all_fields_drops_block() {
        let content = "---\ntitle: Safe Note\n---\nBody.\n";
        let updated = set_front_matter_fields(content, &[]);
        assert_eq!(updated, "Body.\n");
    }

    #[test]
    fn test_set_note_body_preserves_front_matter_replaces_body() {
        let content = "---\ntitle: Safe Note\ncustom: keep_me\n---\nOld body.\n";
        let updated = set_note_body(content, "New body.\n");
        assert_eq!(
            updated,
            "---\ntitle: Safe Note\ncustom: keep_me\n---\nNew body.\n"
        );
    }

    #[test]
    fn test_set_note_body_with_no_front_matter_is_just_the_new_body() {
        let content = "Old body.\n";
        let updated = set_note_body(content, "New body.\n");
        assert_eq!(updated, "New body.\n");
    }

    #[test]
    fn test_set_note_body_round_trips_through_parse_front_matter() {
        let content = "---\ntemplateVariables: '[]'\n---\n# {{title}}\n\nSome text.\n";
        let updated = set_note_body(content, "# {{title}}\n\nEdited text.\n");
        let (_, body, _, fields) = parse_front_matter(&updated);
        assert_eq!(body, "# {{title}}\n\nEdited text.\n");
        assert_eq!(
            fields,
            vec![("templateVariables".to_string(), "'[]'".to_string())]
        );
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
        let nested_meta =
            create_note(root, &nested_note, Some("---\ntitle: Nested\n---\n")).unwrap();
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

    #[test]
    fn test_resolve_link_target_and_extraction() {
        let dir = tempdir().unwrap();
        let root = dir.path();

        // Create target notes
        fs::create_dir_all(root.join("projects/payments")).unwrap();
        fs::write(root.join("projects/payments/rails.md"), "# Rails").unwrap();
        fs::write(root.join("overview.md"), "# Overview").unwrap();

        let source = "projects/payments/settlement.md";

        // 1. Relative link with implicit .md
        let res1 = resolve_link_target(root, source, "./rails");
        assert_eq!(
            res1,
            ResolvedTarget::Internal {
                path: "projects/payments/rails.md".into(),
                anchor: None,
            }
        );

        // 2. Relative link with anchor and extension
        let res2 = resolve_link_target(root, source, "rails.md#instant-settlement");
        assert_eq!(
            res2,
            ResolvedTarget::Internal {
                path: "projects/payments/rails.md".into(),
                anchor: Some("instant-settlement".into()),
            }
        );

        // 3. Workspace absolute link (leading slash)
        let res3 = resolve_link_target(root, source, "/overview.md");
        assert_eq!(
            res3,
            ResolvedTarget::Internal {
                path: "overview.md".into(),
                anchor: None,
            }
        );

        // 4. URL encoded path
        fs::write(root.join("projects/payments/special note.md"), "# Special").unwrap();
        let res4 = resolve_link_target(root, source, "special%20note");
        assert_eq!(
            res4,
            ResolvedTarget::Internal {
                path: "projects/payments/special note.md".into(),
                anchor: None,
            }
        );

        // 5. External link
        let res5 = resolve_link_target(root, source, "https://example.com/docs");
        assert_eq!(
            res5,
            ResolvedTarget::External("https://example.com/docs".into())
        );

        // 6. Unresolved broken link
        let res6 = resolve_link_target(root, source, "./nonexistent");
        assert_eq!(
            res6,
            ResolvedTarget::Unresolved {
                raw_path: "projects/payments/nonexistent.md".into(),
                anchor: None,
            }
        );

        // 7. Extract links test
        let markdown = r#"---
title: Test
---
Check out [Payment rails](./rails) and [Overview](/overview.md#intro).
Also see [Broken link](./missing-note) and external [Google](https://google.com).
"#;
        let links = extract_links(root, source, markdown);
        assert_eq!(links.len(), 4);
        assert_eq!(links[0].raw_target, "./rails");
        assert_eq!(links[0].resolved, Some("projects/payments/rails.md".into()));
        assert_eq!(links[1].raw_target, "/overview.md#intro");
        assert_eq!(links[1].resolved, Some("overview.md".into()));
        assert_eq!(links[2].raw_target, "./missing-note");
        assert_eq!(links[2].resolved, None);
        assert_eq!(links[3].raw_target, "https://google.com");
        assert_eq!(links[3].resolved, None);
    }

    // -----------------------------------------------------------------------------------------
    // Wikilinks (M10.23)
    // -----------------------------------------------------------------------------------------

    fn stems_from(index: &Index) -> HashMap<String, Vec<NotePath>> {
        index.filename_stems.clone()
    }

    #[test]
    fn wikilink_disabled_is_fully_inert() {
        let dir = tempdir().unwrap();
        let root = dir.path();
        fs::write(root.join("target.md"), "# Target").unwrap();
        let content = "See [[target]] here.";
        // extract_links_all with wikilinks_enabled=false should find zero links (no Markdown
        // link syntax present either).
        let links = extract_links_all(root, "source.md", content, false, &HashMap::new());
        assert!(links.is_empty());
        // The render preprocessing pass must also leave `[[...]]` untouched.
        assert_eq!(md_extensions::rewrite_wikilinks(content, false), content);
    }

    #[test]
    fn wikilink_resolves_unique_bare_name() {
        let dir = tempdir().unwrap();
        let root = dir.path();
        fs::create_dir_all(root.join("notes")).unwrap();
        fs::write(root.join("notes/target.md"), "# Target").unwrap();

        let mut index = Index::new();
        index.insert_or_update_note(
            root,
            &SafePath::resolve(root, "notes/target.md").unwrap(),
            "# Target",
        );
        let stems = stems_from(&index);

        let res = resolve_wikilink_target(root, "source.md", &stems, "target", None);
        assert_eq!(
            res,
            ResolvedTarget::Internal {
                path: "notes/target.md".into(),
                anchor: None,
            }
        );
    }

    #[test]
    fn wikilink_bare_name_case_insensitive() {
        let dir = tempdir().unwrap();
        let root = dir.path();
        let mut index = Index::new();
        index.insert_or_update_note(
            root,
            &SafePath::resolve(root, "notes/Target.md").unwrap(),
            "# Target",
        );
        let stems = stems_from(&index);

        let res = resolve_wikilink_target(root, "source.md", &stems, "TARGET", None);
        assert_eq!(
            res,
            ResolvedTarget::Internal {
                path: "notes/Target.md".into(),
                anchor: None,
            }
        );
    }

    #[test]
    fn wikilink_colliding_bare_name_is_ambiguous() {
        let dir = tempdir().unwrap();
        let root = dir.path();
        let mut index = Index::new();
        index.insert_or_update_note(
            root,
            &SafePath::resolve(root, "a/target.md").unwrap(),
            "# A",
        );
        index.insert_or_update_note(
            root,
            &SafePath::resolve(root, "b/target.md").unwrap(),
            "# B",
        );
        let stems = stems_from(&index);

        let res = resolve_wikilink_target(root, "source.md", &stems, "target", None);
        match res {
            ResolvedTarget::Ambiguous(mut candidates) => {
                candidates.sort();
                assert_eq!(candidates, vec!["a/target.md", "b/target.md"]);
            }
            other => panic!("expected Ambiguous, got {other:?}"),
        }
    }

    #[test]
    fn wikilink_unresolved_bare_name() {
        let dir = tempdir().unwrap();
        let root = dir.path();
        let res = resolve_wikilink_target(root, "source.md", &HashMap::new(), "nope", None);
        assert_eq!(
            res,
            ResolvedTarget::Unresolved {
                raw_path: "nope".into(),
                anchor: None,
            }
        );
    }

    #[test]
    fn wikilink_path_shaped_target_uses_path_resolution() {
        let dir = tempdir().unwrap();
        let root = dir.path();
        fs::create_dir_all(root.join("notes")).unwrap();
        fs::write(root.join("notes/target.md"), "# Target").unwrap();

        let res = resolve_wikilink_target(root, "source.md", &HashMap::new(), "notes/target", None);
        assert_eq!(
            res,
            ResolvedTarget::Internal {
                path: "notes/target.md".into(),
                anchor: None,
            }
        );
    }

    #[test]
    fn wikilink_heading_valid_and_invalid_anchor() {
        let dir = tempdir().unwrap();
        let root = dir.path();
        fs::write(
            root.join("target.md"),
            "# Target\n\n## Some Heading\n\nBody.",
        )
        .unwrap();
        let mut stems = HashMap::new();
        stems.insert("target".to_string(), vec!["target.md".to_string()]);

        let valid =
            resolve_wikilink_target(root, "source.md", &stems, "target", Some("Some Heading"));
        assert_eq!(
            valid,
            ResolvedTarget::Internal {
                path: "target.md".into(),
                anchor: Some("some-heading".into()),
            }
        );

        // An unmatched heading still resolves the note; it just drops to the requested slug
        // rather than making the whole link unresolved.
        let invalid = resolve_wikilink_target(root, "source.md", &stems, "target", Some("Nope"));
        assert_eq!(
            invalid,
            ResolvedTarget::Internal {
                path: "target.md".into(),
                anchor: Some("nope".into()),
            }
        );
    }

    #[test]
    fn extract_wikilinks_all_five_forms_and_markdown_merge_in_document_order() {
        let dir = tempdir().unwrap();
        let root = dir.path();
        let mut index = Index::new();
        index.insert_or_update_note(
            root,
            &SafePath::resolve(root, "target.md").unwrap(),
            "# Target\n\n## Heading One",
        );
        let stems = stems_from(&index);

        let content = concat!(
            "[md link](target.md) then\n",
            "[[target]] then\n",
            "[[target|Alias]] then\n",
            "[[target#Heading One]] then\n",
            "[[target#Heading One|Alias2]] then\n",
            "![[target]]\n",
        );
        let links = extract_links_all(root, "source.md", content, true, &stems);
        assert_eq!(links.len(), 6);
        assert_eq!(links[0].syntax, LinkSyntax::Markdown);
        for link in &links[1..] {
            assert_eq!(link.syntax, LinkSyntax::Wikilink);
            assert_eq!(link.resolved.as_deref(), Some("target.md"));
        }
        // Document order preserved (sorted by line/col).
        for pair in links.windows(2) {
            assert!((pair[0].line, pair[0].col) <= (pair[1].line, pair[1].col));
        }
    }

    #[test]
    fn extract_wikilinks_ambiguous_link_reports_candidates() {
        let dir = tempdir().unwrap();
        let root = dir.path();
        let mut index = Index::new();
        index.insert_or_update_note(root, &SafePath::resolve(root, "a/dup.md").unwrap(), "# A");
        index.insert_or_update_note(root, &SafePath::resolve(root, "b/dup.md").unwrap(), "# B");
        let stems = stems_from(&index);

        let links = extract_links_all(root, "source.md", "[[dup]]", true, &stems);
        assert_eq!(links.len(), 1);
        assert_eq!(links[0].resolved, None);
        let mut candidates = links[0].ambiguous_with.clone();
        candidates.sort();
        assert_eq!(candidates, vec!["a/dup.md", "b/dup.md"]);
    }

    #[test]
    fn render_wikilinks_alias_and_broken() {
        let dir = tempdir().unwrap();
        let root = dir.path();
        let mut index = Index::new();
        index.insert_or_update_note(
            root,
            &SafePath::resolve(root, "target.md").unwrap(),
            "# Target",
        );
        let stems = stems_from(&index);

        let html = crate::render::render_note_markdown_with_config(
            "[[target|Friendly Name]] and [[missing]]",
            "dark",
            Some(root),
            Some("source.md"),
            true,
            Some(&stems),
        )
        .html;
        assert!(html.contains("Friendly Name"));
        assert!(html.contains("flint-internal-link"));
        assert!(html.contains("flint-broken-link"));
    }

    #[test]
    fn render_wikilinks_off_is_inert_literal_text() {
        let html =
            crate::render::render_note_markdown("literal [[target]] text", "dark", None, None).html;
        assert!(html.contains("[[target]]"));
        assert!(!html.contains("flint-internal-link"));
    }

    #[test]
    fn render_embed_resolved_target_wraps_content_with_boundary() {
        let dir = tempdir().unwrap();
        let root = dir.path();
        fs::write(root.join("target.md"), "# Target\n\nBody text.").unwrap();
        let mut index = Index::new();
        index.insert_or_update_note(
            root,
            &SafePath::resolve(root, "target.md").unwrap(),
            "# Target\n\nBody text.",
        );
        let stems = stems_from(&index);

        let html = crate::render::render_note_markdown_with_config(
            "![[target]]",
            "dark",
            Some(root),
            Some("source.md"),
            true,
            Some(&stems),
        )
        .html;
        assert!(html.contains("flint-embed"));
        assert!(html.contains("data-embed-source=\"target.md\""));
        assert!(html.contains("Body text."));
    }

    #[test]
    fn render_embed_relative_links_resolve_against_embedded_notes_own_folder() {
        let dir = tempdir().unwrap();
        let root = dir.path();
        fs::create_dir_all(root.join("sub")).unwrap();
        fs::write(root.join("sub/target.md"), "![local](./pic.png)").unwrap();
        fs::write(root.join("sub/pic.png"), b"fake png bytes").unwrap();
        let mut index = Index::new();
        index.insert_or_update_note(
            root,
            &SafePath::resolve(root, "sub/target.md").unwrap(),
            "![local](./pic.png)",
        );
        let stems = stems_from(&index);

        let html = crate::render::render_note_markdown_with_config(
            "![[target]]",
            "dark",
            Some(root),
            Some("source.md"),
            true,
            Some(&stems),
        )
        .html;
        // The embedded note's own relative image resolves against `sub/`, not the workspace
        // root the embedding note (`source.md`) lives in.
        assert!(!html.contains("flint-missing-image"));
        assert!(html.contains("<img"));
    }

    #[test]
    fn render_embed_unresolved_target_reuses_broken_link_ui() {
        let html = crate::render::render_note_markdown_with_config(
            "![[missing]]",
            "dark",
            Some(Path::new("/tmp")),
            Some("source.md"),
            true,
            None,
        )
        .html;
        assert!(html.contains("flint-broken-link"));
        assert!(!html.contains("flint-embed\""));
    }

    #[test]
    fn render_embed_ambiguous_target_reuses_ambiguous_link_ui() {
        let dir = tempdir().unwrap();
        let root = dir.path();
        let mut index = Index::new();
        index.insert_or_update_note(root, &SafePath::resolve(root, "a/dup.md").unwrap(), "# A");
        index.insert_or_update_note(root, &SafePath::resolve(root, "b/dup.md").unwrap(), "# B");
        let stems = stems_from(&index);

        let html = crate::render::render_note_markdown_with_config(
            "![[dup]]",
            "dark",
            Some(root),
            Some("source.md"),
            true,
            Some(&stems),
        )
        .html;
        assert!(html.contains("flint-ambiguous-link"));
    }

    #[test]
    fn render_embed_direct_cycle_renders_named_error_not_infinite_recursion() {
        let dir = tempdir().unwrap();
        let root = dir.path();
        fs::write(root.join("a.md"), "![[a]]").unwrap();
        let mut index = Index::new();
        index.insert_or_update_note(root, &SafePath::resolve(root, "a.md").unwrap(), "![[a]]");
        let stems = stems_from(&index);

        let html = crate::render::render_note_markdown_with_config(
            "![[a]]",
            "dark",
            Some(root),
            Some("a.md"),
            true,
            Some(&stems),
        )
        .html;
        assert!(html.contains("flint-embed-cycle"));
        assert!(html.contains("a.md"));
    }

    #[test]
    fn render_embed_indirect_cycle_renders_named_error_not_infinite_recursion() {
        let dir = tempdir().unwrap();
        let root = dir.path();
        fs::write(root.join("a.md"), "![[b]]").unwrap();
        fs::write(root.join("b.md"), "![[a]]").unwrap();
        let mut index = Index::new();
        index.insert_or_update_note(root, &SafePath::resolve(root, "a.md").unwrap(), "![[b]]");
        index.insert_or_update_note(root, &SafePath::resolve(root, "b.md").unwrap(), "![[a]]");
        let stems = stems_from(&index);

        let html = crate::render::render_note_markdown_with_config(
            "![[b]]",
            "dark",
            Some(root),
            Some("a.md"),
            true,
            Some(&stems),
        )
        .html;
        assert!(html.contains("flint-embed-cycle"));
    }

    #[test]
    fn render_embed_over_depth_chain_renders_depth_limit_block_not_crash() {
        let dir = tempdir().unwrap();
        let root = dir.path();
        // note_0 embeds note_1, note_1 embeds note_2, ... note_6 has no further embed. That's 6
        // embed hops from the top-level note, past EMBED_MAX_DEPTH (5).
        let mut index = Index::new();
        for i in 0..7 {
            let content = if i < 6 {
                format!("![[note_{}]]", i + 1)
            } else {
                "# Leaf".to_string()
            };
            let path = format!("note_{i}.md");
            fs::write(root.join(&path), &content).unwrap();
            index.insert_or_update_note(root, &SafePath::resolve(root, &path).unwrap(), &content);
        }
        let stems = stems_from(&index);

        let html = crate::render::render_note_markdown_with_config(
            "![[note_0]]",
            "dark",
            Some(root),
            Some("top.md"),
            true,
            Some(&stems),
        )
        .html;
        assert!(html.contains("flint-embed-depth-limit"));
    }

    #[test]
    fn render_embed_does_not_affect_embedding_notes_own_extracted_links_or_search() {
        let dir = tempdir().unwrap();
        let root = dir.path();
        fs::write(root.join("target.md"), "# Target\n\n[[other]]\n").unwrap();
        let mut index = Index::new();
        index.insert_or_update_note(
            root,
            &SafePath::resolve(root, "target.md").unwrap(),
            "# Target\n\n[[other]]\n",
        );
        let stems = stems_from(&index);

        // The embedding note's own raw content has no links of its own beyond the embed marker
        // itself; `extract_wikilinks` on the embedding note's raw text must not see `[[other]]`,
        // which only exists inside the *embedded* note's content.
        let embedding_source = "![[target]]";
        let links = extract_wikilinks(root, "source.md", embedding_source, &stems);
        assert!(!links.iter().any(|l| l.raw_target.contains("other")));
    }

    #[test]
    fn rewrite_wikilinks_for_rename_preserves_alias_and_heading() {
        let dir = tempdir().unwrap();
        let root = dir.path();
        fs::create_dir_all(root.join("old")).unwrap();
        fs::write(root.join("old/target.md"), "# Target").unwrap();

        let mut stems = HashMap::new();
        stems.insert("target".to_string(), vec!["old/target.md".to_string()]);

        let mut moved = HashMap::new();
        moved.insert("old/target.md".to_string(), "new/renamed.md".to_string());

        let content = "[[target#Section|Alias]] and ![[target]]";
        let (rewritten, count, skipped) =
            rewrite_wikilinks_for_rename(root, "source.md", content, &moved, &stems);
        assert_eq!(count, 2);
        assert_eq!(skipped, 0);
        assert_eq!(rewritten, "[[renamed#Section|Alias]] and ![[renamed]]");
    }

    #[test]
    fn rewrite_wikilinks_for_rename_skips_ambiguous_and_counts_it() {
        let dir = tempdir().unwrap();
        let root = dir.path();
        let mut stems = HashMap::new();
        stems.insert(
            "dup".to_string(),
            vec!["a/dup.md".to_string(), "b/dup.md".to_string()],
        );
        let mut moved = HashMap::new();
        moved.insert("a/dup.md".to_string(), "a/renamed.md".to_string());

        let content = "[[dup]]";
        let (rewritten, count, skipped) =
            rewrite_wikilinks_for_rename(root, "source.md", content, &moved, &stems);
        assert_eq!(count, 0);
        assert_eq!(skipped, 1);
        assert_eq!(rewritten, content);
    }

    #[test]
    fn index_set_wikilinks_enabled_rescans_existing_notes() {
        let dir = tempdir().unwrap();
        let root = dir.path();
        fs::write(root.join("target.md"), "# Target").unwrap();
        fs::write(root.join("source.md"), "See [[target]]").unwrap();

        let mut index = Index::build_from_workspace(root, |_, _| {}).unwrap();
        // Off by default: the wikilink is not indexed yet.
        assert!(index
            .links_out
            .get("source.md")
            .map(|l| l.is_empty())
            .unwrap_or(true));

        index.set_wikilinks_enabled(true, root);
        let links = index
            .links_out
            .get("source.md")
            .cloned()
            .unwrap_or_default();
        assert_eq!(links.len(), 1);
        assert_eq!(links[0].syntax, LinkSyntax::Wikilink);
        assert_eq!(links[0].resolved.as_deref(), Some("target.md"));
        assert!(index
            .get_backlinks("target.md")
            .iter()
            .any(|g| g.source_path == "source.md"));
    }

    #[test]
    fn test_benchmark_10k_notes() {
        use std::time::Instant;

        let dir = tempdir().unwrap();
        let root = dir.path();

        // Generate 10,000 notes across multiple subfolders
        // Average note ~5KB -> total ~50MB
        let subfolders = [
            "architecture",
            "payments",
            "core",
            "ui",
            "notes",
            "archive",
            "daily",
            "research",
            "specs",
            "guides",
        ];
        for folder in &subfolders {
            fs::create_dir_all(root.join(folder)).unwrap();
        }

        let total_notes = 10_000;
        let paragraph = "Flint is a local-first Markdown knowledge workspace. It indexes bidirectional links and renders math and code.\n".repeat(30);

        for i in 0..total_notes {
            let folder = subfolders[i % subfolders.len()];
            let target_idx = (i + 1) % total_notes;
            let target_folder = subfolders[target_idx % subfolders.len()];
            let target_path = format!("/{}/note_{}.md", target_folder, target_idx);

            let content = format!(
                "---\ntitle: Note {}\ntags: [benchmark, test]\n---\n# Note {}\n\nLink to [next note]({}).\n\n{}\n",
                i, i, target_path, paragraph
            );
            let file_path = root.join(folder).join(format!("note_{}.md", i));
            fs::write(file_path, content).unwrap();
        }

        // Measure full build time
        let start_build = Instant::now();
        let mut progress_count = 0;
        let mut index = Index::build_from_workspace(root, |_indexed, _total| {
            progress_count += 1;
        })
        .unwrap();
        let build_duration = start_build.elapsed();
        assert!(progress_count > 0);

        let stats = index.get_stats();
        assert_eq!(stats.note_count, total_notes);
        assert_eq!(stats.link_count, total_notes);
        assert_eq!(stats.unresolved_count, 0);

        // Measure incremental update time
        let target_note = SafePath::resolve(root, "payments/note_1.md").unwrap();
        let updated_content = format!(
            "---\ntitle: Updated Note 1\n---\n# Updated Note 1\n\nLink to [note 500](/specs/note_500.md).\n\n{}\n",
            paragraph
        );
        fs::write(target_note.as_path(), &updated_content).unwrap();

        let start_update = Instant::now();
        index.insert_or_update_note(root, &target_note, &updated_content);
        let update_duration = start_update.elapsed();

        println!(
            "\n[Benchmark M7]: 10,000 notes / ~50 MB index build: {:?} (target < 2s); incremental update: {:?} (target < 20ms)",
            build_duration, update_duration
        );

        // SPEC §6.2 target assertions
        // Full build target < 2s, incremental target < 20ms
        assert!(
            build_duration.as_secs_f64() < 5.0,
            "Full build took too long: {:?}",
            build_duration
        );
        assert!(
            update_duration.as_millis() < 50,
            "Incremental update took too long: {:?}",
            update_duration
        );
    }

    #[test]
    fn test_link_relativization() {
        // Sibling
        assert_eq!(
            relativize_path(
                "projects/payments/settlement.md",
                "projects/payments/rails.md"
            ),
            "./rails.md"
        );
        // Child folder
        assert_eq!(
            relativize_path("projects/payments.md", "projects/sub/deep/note.md"),
            "./sub/deep/note.md"
        );
        // Parent folder
        assert_eq!(
            relativize_path("projects/payments/settlement.md", "overview.md"),
            "../../overview.md"
        );
        // Sibling folder
        assert_eq!(
            relativize_path("projects/payments/settlement.md", "projects/auth/login.md"),
            "../auth/login.md"
        );
        // Root note to root note
        assert_eq!(relativize_path("daily.md", "spec.md"), "./spec.md");
    }

    #[test]
    fn test_rewrite_markdown_links_comprehensive() {
        let dir = tempdir().unwrap();
        let root = dir.path();

        // Setup notes
        fs::create_dir_all(root.join("projects/payments")).unwrap();
        fs::create_dir_all(root.join("docs")).unwrap();
        fs::write(root.join("projects/payments/rails.md"), "# Rails").unwrap();
        fs::write(root.join("projects/payments/special note.md"), "# Special").unwrap();

        let source_note = "projects/payments/settlement.md";
        let markdown = r#"# Settlement

Check out [Payment rails](./rails.md) and [Rails anchor](./rails.md#instant).
Check [Special Note](./special%20note.md).
Check [Workspace absolute](/projects/payments/rails.md).

Here is a code block that should NOT be rewritten:
```markdown
[Payment rails in code fence](./rails.md)
```

And inline code `[Payment rails in inline code](./rails.md)` should not be touched.

Also [Unrelated link](https://example.com) and [Other Note](../other.md).
"#;

        let mut moved_map = HashMap::new();
        // Rename rails.md to docs/payment-rails.md
        moved_map.insert(
            "projects/payments/rails.md".to_string(),
            "docs/payment-rails.md".to_string(),
        );
        // Rename special note.md to docs/special note.md
        moved_map.insert(
            "projects/payments/special note.md".to_string(),
            "docs/special note.md".to_string(),
        );

        let (rewritten, count) = rewrite_markdown_links(root, source_note, markdown, &moved_map);

        assert_eq!(count, 4); // 4 links rewritten outside code blocks

        // Verify updated links
        assert!(rewritten.contains("[Payment rails](../../docs/payment-rails.md)"));
        assert!(rewritten.contains("[Rails anchor](../../docs/payment-rails.md#instant)"));
        assert!(rewritten.contains("[Special Note](../../docs/special%20note.md)"));
        assert!(rewritten.contains("[Workspace absolute](../../docs/payment-rails.md)"));

        // Verify code blocks and inline code preserved
        assert!(rewritten.contains("```markdown\n[Payment rails in code fence](./rails.md)\n```"));
        assert!(rewritten.contains("`[Payment rails in inline code](./rails.md)`"));
    }

    #[test]
    fn test_rewrite_workspace_links_on_rename() {
        let dir = tempdir().unwrap();
        let root = dir.path();

        // Create folders & notes
        fs::create_dir_all(root.join("projects/payments")).unwrap();
        fs::create_dir_all(root.join("architecture")).unwrap();

        let settlement_content = "# Settlement\n\nSee [Rails](./rails.md) for details.\n";
        fs::write(
            root.join("projects/payments/settlement.md"),
            settlement_content,
        )
        .unwrap();

        let arch_content =
            "# Architecture\n\nSee [Settlement](/projects/payments/settlement.md#daily).\n";
        fs::write(root.join("architecture/overview.md"), arch_content).unwrap();

        let rails_content = "# Rails\n\nSee [Settlement](./settlement.md).\n";
        fs::write(root.join("projects/payments/rails.md"), rails_content).unwrap();

        fs::create_dir_all(root.join("projects/auth")).unwrap();
        let auth_content = "# Auth\n\nSee [Settlement](../payments/settlement.md).\n";
        fs::write(root.join("projects/auth/login.md"), auth_content).unwrap();

        // Move settlement.md to core/settlement-engine.md
        fs::create_dir_all(root.join("core")).unwrap();
        let from_safe = SafePath::resolve(root, "projects/payments/settlement.md").unwrap();
        let to_safe = SafePath::resolve(root, "core/settlement-engine.md").unwrap();
        rename_path(root, &from_safe, &to_safe).unwrap();

        let mut moved_map = HashMap::new();
        moved_map.insert(
            "projects/payments/settlement.md".to_string(),
            "core/settlement-engine.md".to_string(),
        );

        let summary =
            rewrite_workspace_links_for_rename(root, &moved_map, &HashMap::new()).unwrap();
        assert_eq!(summary.links_updated, 3);
        assert_eq!(summary.notes_updated, 3);

        // Verify architecture/overview.md updated
        let updated_arch = fs::read_to_string(root.join("architecture/overview.md")).unwrap();
        assert!(updated_arch.contains("[Settlement](../core/settlement-engine.md#daily)"));

        // Verify projects/payments/rails.md updated
        let updated_rails = fs::read_to_string(root.join("projects/payments/rails.md")).unwrap();
        assert!(updated_rails.contains("[Settlement](../../core/settlement-engine.md)"));

        // Verify projects/auth/login.md updated
        let updated_auth = fs::read_to_string(root.join("projects/auth/login.md")).unwrap();
        assert!(updated_auth.contains("[Settlement](../../core/settlement-engine.md)"));
    }

    #[test]
    fn test_search_names_fuzzy_scoring() {
        let dir = tempdir().unwrap();
        let root = dir.path();

        fs::create_dir_all(root.join("projects/payments")).unwrap();
        fs::write(
            root.join("projects/payments/settlement.md"),
            "---\ntitle: Settlement Windows\n---\n",
        )
        .unwrap();
        fs::write(
            root.join("projects/payments/rails.md"),
            "---\ntitle: Payment Rails\n---\n",
        )
        .unwrap();
        fs::write(root.join("daily.md"), "---\ntitle: Daily Log\n---\n").unwrap();

        let index = Index::build_from_workspace(root, |_, _| {}).unwrap();

        // Exact query
        let hits = index.search_names("Settlement Windows", None);
        assert!(!hits.is_empty());
        assert_eq!(hits[0].path, "projects/payments/settlement.md");
        assert!(hits[0].score >= 1000);

        // Substring / fuzzy query
        let hits_fuzzy = index.search_names("pay rail", None);
        assert!(!hits_fuzzy.is_empty());
        assert_eq!(hits_fuzzy[0].path, "projects/payments/rails.md");

        // Path search
        let hits_path = index.search_names("daily", None);
        assert!(!hits_path.is_empty());
        assert_eq!(hits_path[0].path, "daily.md");
    }

    #[test]
    fn test_search_content_regex_and_options() {
        let dir = tempdir().unwrap();
        let root = dir.path();

        fs::create_dir_all(root.join("projects/payments")).unwrap();
        fs::create_dir_all(root.join("archive")).unwrap();

        fs::write(
            root.join("projects/payments/settlement.md"),
            "# Settlement\nBBPS settles daily at 18:00.\nSecond window at 22:00.\n",
        )
        .unwrap();

        fs::write(
            root.join("archive/old_settlement.md"),
            "# Old Settlement\nBBPS settles at 17:00.\n",
        )
        .unwrap();

        // 1. Literal search
        let opts = ContentSearchOptions::default();
        let res = search_content(root, "settles", &opts).unwrap();
        assert_eq!(res.len(), 2);
        assert_eq!(res[0].matches.len(), 1);

        // 2. Folder scope
        let opts_scoped = ContentSearchOptions {
            folder_scope: Some("projects/payments".into()),
            ..Default::default()
        };
        let res_scoped = search_content(root, "settles", &opts_scoped).unwrap();
        assert_eq!(res_scoped.len(), 1);
        assert_eq!(res_scoped[0].path, "projects/payments/settlement.md");

        // 3. Regex search
        let opts_regex = ContentSearchOptions {
            is_regex: true,
            ..Default::default()
        };
        let res_regex = search_content(root, r"\d{2}:\d{2}", &opts_regex).unwrap();
        assert_eq!(res_regex.len(), 2);
        let settlement_group = res_regex
            .iter()
            .find(|g| g.path == "projects/payments/settlement.md")
            .unwrap();
        assert_eq!(settlement_group.matches.len(), 2);

        // 4. Invalid regex returns Err
        let opts_invalid = ContentSearchOptions {
            is_regex: true,
            ..Default::default()
        };
        let res_invalid = search_content(root, "[unclosed-regex", &opts_invalid);
        assert!(res_invalid.is_err());
    }

    #[test]
    fn test_resolve_workspace_target_file_mode() {
        let dir = tempdir().unwrap();
        let root = dir.path();

        let md_file = root.join("test_note.md");
        fs::write(&md_file, "# Test Note").unwrap();

        let markdown_file = root.join("doc.markdown");
        fs::write(&markdown_file, "# Doc").unwrap();

        let non_md_file = root.join("data.txt");
        fs::write(&non_md_file, "plain text").unwrap();

        let missing_file = root.join("missing.md");

        // 1. Ordinary .md file resolves to parent dir & relative initial note
        let res_md = resolve_workspace_target(Some(&md_file), None, None, root).unwrap();
        assert_eq!(
            res_md,
            ResolvedWorkspaceTarget::File {
                ws_root: root.canonicalize().unwrap(),
                initial_note: "test_note.md".to_string(),
            }
        );

        // 2. .markdown file resolves as valid target
        let res_markdown =
            resolve_workspace_target(Some(&markdown_file), None, None, root).unwrap();
        assert_eq!(
            res_markdown,
            ResolvedWorkspaceTarget::File {
                ws_root: root.canonicalize().unwrap(),
                initial_note: "doc.markdown".to_string(),
            }
        );

        // 3. Relative path resolves against current_dir
        let rel_path = Path::new("test_note.md");
        let res_rel = resolve_workspace_target(Some(rel_path), None, None, root).unwrap();
        assert_eq!(
            res_rel,
            ResolvedWorkspaceTarget::File {
                ws_root: root.canonicalize().unwrap(),
                initial_note: "test_note.md".to_string(),
            }
        );

        // 4. Non-markdown file returns NotAMarkdownFile error
        let res_non_md = resolve_workspace_target(Some(&non_md_file), None, None, root);
        assert!(matches!(
            res_non_md,
            Err(WorkspaceError::NotAMarkdownFile(_))
        ));

        // 5. Missing file returns NotFound error
        let res_missing = resolve_workspace_target(Some(&missing_file), None, None, root);
        assert!(matches!(res_missing, Err(WorkspaceError::NotFound(_))));
    }

    #[test]
    fn test_search_content_excludes_comment_text() {
        let dir = tempdir().unwrap();
        let root = dir.path();

        fs::write(
            root.join("note.md"),
            "# Note\nVisible text.\n%%secret%%\nFenced example:\n```\n%%secret%%\n```\n",
        )
        .unwrap();

        let opts = ContentSearchOptions::default();

        // Comment text is excluded from search results.
        let res = search_content(root, "secret", &opts).unwrap();
        assert_eq!(res.len(), 1);
        // Only the fenced (non-comment) occurrence should match.
        assert_eq!(res[0].matches.len(), 1);

        // Non-comment text still matches.
        let res_visible = search_content(root, "Visible", &opts).unwrap();
        assert_eq!(res_visible.len(), 1);
    }

    #[test]
    fn test_check_workspace_health_doctor() {
        let dir = tempdir().unwrap();
        let root = dir.path();

        fs::create_dir_all(root.join("notes")).unwrap();
        fs::write(
            root.join("notes/main.md"),
            "# Main\nLink to [missing](./missing.md) and [orphan](./orphan.md).",
        )
        .unwrap();
        fs::write(root.join("notes/orphan.md"), "# Orphan\nIsolated note.").unwrap();
        fs::write(root.join("notes/lonely.md"), "# Lonely\nNo links at all.").unwrap();

        let report = check_workspace_health(root).unwrap();
        assert_eq!(report.note_count, 3);
        assert_eq!(report.broken_links.len(), 1);
        assert_eq!(report.broken_links[0].raw_target, "./missing.md");
        assert_eq!(report.orphan_notes, vec!["notes/lonely.md".to_string()]);
        assert!(report.unreadable_files.is_empty());
    }

    // --- M10.25: tags and tag navigation ---

    #[test]
    fn extract_inline_tags_finds_plain_tag() {
        let tags = extract_inline_tags("Some text with a #project-x tag in it.");
        assert_eq!(tags, vec![("project-x".to_string(), 1, 18)]);
    }

    #[test]
    fn extract_inline_tags_excludes_word_char_prefix() {
        // `foo#bar` and `C#` must not be treated as tags: the `#` is preceded by a word char.
        let tags = extract_inline_tags("This is foo#bar and also C# code.");
        assert!(tags.is_empty());
    }

    #[test]
    fn extract_inline_tags_excludes_atx_heading_marker_but_finds_tag_later_on_line() {
        let tags = extract_inline_tags("# Heading\n\n## Sub #tag\n\nBody #ok.");
        let names: Vec<&str> = tags.iter().map(|(t, _, _)| t.as_str()).collect();
        assert_eq!(names, vec!["tag", "ok"]);
    }

    #[test]
    fn extract_inline_tags_excludes_code_span_and_fence() {
        let body = "Inline `#not_a_tag` code.\n\n```\n#also_not_a_tag\n```\n\n#real_tag here.";
        let tags = extract_inline_tags(body);
        let names: Vec<&str> = tags.iter().map(|(t, _, _)| t.as_str()).collect();
        assert_eq!(names, vec!["real_tag"]);
    }

    #[test]
    fn extract_inline_tags_matches_after_punctuation_and_line_start() {
        let tags = extract_inline_tags("#start-tag and (#paren-tag) and, #after-comma.");
        let names: Vec<&str> = tags.iter().map(|(t, _, _)| t.as_str()).collect();
        assert_eq!(names, vec!["start-tag", "paren-tag", "after-comma"]);
    }

    #[test]
    fn rewrite_inline_tags_replaces_matching_occurrences_case_insensitively() {
        let body = "Work on #Project-X today. See also #project-x notes. Skip foo#project-x.";
        let (new_body, count) = rewrite_inline_tags(body, "project-x", "project-y");
        assert_eq!(count, 2);
        assert_eq!(
            new_body,
            "Work on #project-y today. See also #project-y notes. Skip foo#project-x."
        );
    }

    #[test]
    fn rewrite_inline_tags_never_touches_heading_marker_or_code() {
        let body = "# Heading\n\n`#project-x` in code.\n\n```\n#project-x\n```\n";
        let (new_body, count) = rewrite_inline_tags(body, "project-x", "project-y");
        assert_eq!(count, 0);
        assert_eq!(new_body, body);
    }

    #[test]
    fn note_meta_tags_is_union_of_front_matter_and_inline_case_insensitive_dedup() {
        let dir = tempdir().unwrap();
        let root = dir.path();
        fs::write(
            root.join("note.md"),
            "---\ntags: [Rust, alpha]\n---\n# Title\n\nBody with #rust and #beta tags.\n",
        )
        .unwrap();

        let mut index = Index::new();
        let safe = SafePath::resolve(root, "note.md").unwrap();
        let content = fs::read_to_string(safe.as_path()).unwrap();
        index.insert_or_update_note(root, &safe, &content);

        let meta = index.notes.get("note.md").unwrap();
        // `Rust` (front-matter) wins over `rust` (inline) casing; `beta` is added from inline.
        assert_eq!(meta.tags, vec!["Rust", "alpha", "beta"]);
    }

    #[test]
    fn index_tags_reverse_map_tracks_notes_and_updates_incrementally() {
        let dir = tempdir().unwrap();
        let root = dir.path();
        fs::write(root.join("a.md"), "---\ntags: [shared]\n---\n# A\n").unwrap();
        fs::write(root.join("b.md"), "# B\n\nBody with #shared and #only-b.\n").unwrap();

        let index = Index::build_from_workspace(root, |_, _| {}).unwrap();
        let shared_key = index.tag_canonical_key("shared").unwrap();
        let mut shared_notes = index.tags.get(&shared_key).unwrap().clone();
        shared_notes.sort();
        assert_eq!(shared_notes, vec!["a.md".to_string(), "b.md".to_string()]);
        assert!(index
            .tags
            .contains_key(&index.tag_canonical_key("only-b").unwrap()));

        // Removing b.md should drop it from `shared` and remove the now-empty `only-b` bucket.
        let mut index = index;
        index.remove_note(Some(root), "b.md");
        let shared_key = index.tag_canonical_key("shared").unwrap();
        assert_eq!(
            index.tags.get(&shared_key).unwrap(),
            &vec!["a.md".to_string()]
        );
        assert!(index.tag_canonical_key("only-b").is_none());
    }

    #[test]
    fn rewrite_tags_workspace_renames_front_matter_and_inline_across_notes() {
        let dir = tempdir().unwrap();
        let root = dir.path();
        fs::write(
            root.join("fm-only.md"),
            "---\ntags: [old-tag, keep]\n---\n# FM Only\n",
        )
        .unwrap();
        fs::write(
            root.join("inline-only.md"),
            "# Inline Only\n\nSome #old-tag text.\n",
        )
        .unwrap();
        fs::write(
            root.join("both.md"),
            "---\ntags: [old-tag]\n---\n# Both\n\nAlso #old-tag inline.\n",
        )
        .unwrap();

        let index = Index::build_from_workspace(root, |_, _| {}).unwrap();
        let summary =
            rewrite_tags_workspace(root, "old-tag", "new-tag", &index.tags, true).unwrap();
        assert_eq!(summary.notes_updated, 3);

        assert_eq!(
            fs::read_to_string(root.join("fm-only.md")).unwrap(),
            "---\ntags: [new-tag, keep]\n---\n# FM Only\n"
        );
        assert_eq!(
            fs::read_to_string(root.join("inline-only.md")).unwrap(),
            "# Inline Only\n\nSome #new-tag text.\n"
        );
        assert_eq!(
            fs::read_to_string(root.join("both.md")).unwrap(),
            "---\ntags: [new-tag]\n---\n# Both\n\nAlso #new-tag inline.\n"
        );
    }

    #[test]
    fn rewrite_tags_workspace_skips_inline_when_disabled() {
        let dir = tempdir().unwrap();
        let root = dir.path();
        fs::write(
            root.join("both.md"),
            "---\ntags: [old-tag]\n---\n# Both\n\nAlso #old-tag inline.\n",
        )
        .unwrap();

        let index = Index::build_from_workspace(root, |_, _| {}).unwrap();
        let summary =
            rewrite_tags_workspace(root, "old-tag", "new-tag", &index.tags, false).unwrap();
        assert_eq!(summary.notes_updated, 1);
        assert_eq!(
            fs::read_to_string(root.join("both.md")).unwrap(),
            "---\ntags: [new-tag]\n---\n# Both\n\nAlso #old-tag inline.\n"
        );
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
