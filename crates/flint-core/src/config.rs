//! Flint configuration: global defaults + per-workspace overrides (SPEC §11/§12, M10.1).
//!
//! There are two JSON files: a global one (OS config dir, `lastWorkspace`/`recentWorkspaces` plus
//! any global §12 defaults a user sets) and a per-workspace one at `<workspace>/.flint/config.json`
//! (written with the full §12 shape by `bootstrap_workspace`). Reading a "merged" config means:
//! parse both files (falling back to `FlintConfig::default()` per-file if a file is missing,
//! malformed, or mistyped — a bad file never blocks startup), then deep-merge the workspace
//! `Value` over the global `Value` field-by-field, recording which dotted paths came from the
//! workspace file in an `origins` map (a path absent from `origins` is implicitly a global
//! default) so the UI can show "workspace override" vs "global default" badges.

use crate::NoteError;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

// ---------------------------------------------------------------------------------------------
// Typed config shape (SPEC §12)
// ---------------------------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EditorConfig {
    #[serde(default)]
    pub font_size: u32,
    #[serde(default)]
    pub font_family: String,
    #[serde(default)]
    pub soft_wrap: bool,
    #[serde(default)]
    pub tab_size: u32,
    #[serde(default)]
    pub show_line_numbers: bool,
    #[serde(default)]
    pub vim_mode: bool,
    #[serde(flatten)]
    pub extra: serde_json::Map<String, Value>,
}

impl Default for EditorConfig {
    fn default() -> Self {
        Self {
            font_size: 14,
            font_family: "IBM Plex Mono".to_string(),
            soft_wrap: true,
            tab_size: 2,
            show_line_numbers: false,
            vim_mode: false,
            extra: serde_json::Map::new(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MarkdownConfig {
    #[serde(default)]
    pub math: bool,
    #[serde(default)]
    pub tables: bool,
    #[serde(default)]
    pub footnotes: bool,
    #[serde(default)]
    pub smart_punctuation: bool,
    #[serde(flatten)]
    pub extra: serde_json::Map<String, Value>,
}

impl Default for MarkdownConfig {
    fn default() -> Self {
        Self {
            math: true,
            tables: true,
            footnotes: true,
            smart_punctuation: true,
            extra: serde_json::Map::new(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BehaviourConfig {
    #[serde(default)]
    pub autosave_ms: u32,
    #[serde(default)]
    pub rewrite_links_on_rename: bool,
    #[serde(default)]
    pub delete_to_trash: bool,
    #[serde(default)]
    pub new_note_folder: String,
    #[serde(default)]
    pub default_mode: String,
    #[serde(flatten)]
    pub extra: serde_json::Map<String, Value>,
}

impl Default for BehaviourConfig {
    fn default() -> Self {
        Self {
            autosave_ms: 400,
            rewrite_links_on_rename: true,
            delete_to_trash: true,
            new_note_folder: String::new(),
            default_mode: "edit".to_string(),
            extra: serde_json::Map::new(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UiConfig {
    #[serde(default)]
    pub left_sidebar: String,
    #[serde(default)]
    pub right_sidebar_visible: bool,
    #[serde(default)]
    pub show_non_note_files: bool,
    #[serde(flatten)]
    pub extra: serde_json::Map<String, Value>,
}

impl Default for UiConfig {
    fn default() -> Self {
        Self {
            left_sidebar: "tree".to_string(),
            right_sidebar_visible: true,
            show_non_note_files: false,
            extra: serde_json::Map::new(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FlintConfig {
    #[serde(default)]
    pub version: u32,
    #[serde(default)]
    pub theme: String,
    #[serde(default)]
    pub editor: EditorConfig,
    #[serde(default)]
    pub markdown: MarkdownConfig,
    #[serde(default)]
    pub behaviour: BehaviourConfig,
    #[serde(default)]
    pub ui: UiConfig,
    #[serde(default)]
    pub ignore: Vec<String>,
    #[serde(flatten)]
    pub extra: serde_json::Map<String, Value>,
}

/// The only config schema version this build understands.
const CURRENT_CONFIG_VERSION: u32 = 1;

impl Default for FlintConfig {
    fn default() -> Self {
        Self {
            version: CURRENT_CONFIG_VERSION,
            theme: "system".to_string(),
            editor: EditorConfig::default(),
            markdown: MarkdownConfig::default(),
            behaviour: BehaviourConfig::default(),
            ui: UiConfig::default(),
            ignore: vec!["node_modules/**".to_string(), ".obsidian/**".to_string()],
            extra: serde_json::Map::new(),
        }
    }
}

// ---------------------------------------------------------------------------------------------
// Load-with-fallback
// ---------------------------------------------------------------------------------------------

/// Describes why a config file could not be loaded as typed `FlintConfig`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ConfigLoadError {
    pub path: String,
    pub field: String,
    pub message: String,
}

/// Surfaced to the UI as a dismissible notice when a config file failed to parse/type and Flint
/// fell back to defaults for that file.
pub type ConfigNotice = ConfigLoadError;

/// Parse `path` into a `FlintConfig`, typing strictly (unknown `version` values are rejected).
/// Never call this from a code path that must not error on a missing/malformed file — use
/// `load_typed_or_default` for that.
pub fn load_typed(path: &Path) -> Result<FlintConfig, ConfigLoadError> {
    let path_str = path.display().to_string();
    let bytes = fs::read(path).map_err(|e| ConfigLoadError {
        path: path_str.clone(),
        field: "<read>".to_string(),
        message: e.to_string(),
    })?;
    let value: Value = serde_json::from_slice(&bytes).map_err(|e| ConfigLoadError {
        path: path_str.clone(),
        field: "<parse>".to_string(),
        message: e.to_string(),
    })?;

    if let Some(version) = value.get("version") {
        if version.as_u64() != Some(CURRENT_CONFIG_VERSION as u64) {
            return Err(ConfigLoadError {
                path: path_str,
                field: "version".to_string(),
                message: format!("unsupported config version: {}", version),
            });
        }
    }

    serde_json::from_value(value).map_err(|e| ConfigLoadError {
        path: path_str,
        field: e
            .to_string()
            .split('`')
            .nth(1)
            .unwrap_or("<value>")
            .to_string(),
        message: e.to_string(),
    })
}

/// Load `path` as a typed config, falling back to `FlintConfig::default()` (and recording a
/// notice) on any read/parse/type/version failure. Never returns `Err`. A missing file is treated
/// as "use defaults" silently (no notice) since that's the expected first-run state.
pub fn load_typed_or_default(path: &Path) -> (FlintConfig, Option<ConfigNotice>) {
    if !path.exists() {
        return (FlintConfig::default(), None);
    }
    match load_typed(path) {
        Ok(cfg) => (cfg, None),
        Err(e) => (FlintConfig::default(), Some(e)),
    }
}

// ---------------------------------------------------------------------------------------------
// Merge
// ---------------------------------------------------------------------------------------------

/// Where a resolved config field's value came from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ConfigOrigin {
    Global,
    Workspace,
}

/// Recursively merge `patch` (workspace) over `base` (global) in place, at the `Value` level.
/// Every dotted-path key present as a leaf (or object) in `patch` is recorded in `origins` as
/// `ConfigOrigin::Workspace`. A path with no entry in `origins` is implicitly `Global` — the
/// caller never needs to record `Global` explicitly, since "not overridden" already means that.
pub fn deep_merge(
    base: &mut Value,
    patch: &Value,
    prefix: &str,
    origins: &mut HashMap<String, ConfigOrigin>,
) {
    match (base.as_object_mut(), patch.as_object()) {
        (Some(base_obj), Some(patch_obj)) => {
            for (key, patch_val) in patch_obj {
                let path = if prefix.is_empty() {
                    key.clone()
                } else {
                    format!("{prefix}.{key}")
                };
                match base_obj.get_mut(key) {
                    Some(existing) if existing.is_object() && patch_val.is_object() => {
                        deep_merge(existing, patch_val, &path, origins);
                    }
                    _ => {
                        base_obj.insert(key.clone(), patch_val.clone());
                        origins.insert(path.clone(), ConfigOrigin::Workspace);
                        record_leaf_origins(patch_val, &path, origins);
                    }
                }
            }
        }
        _ => {
            *base = patch.clone();
        }
    }
}

/// When an object was inserted wholesale (no matching object existed in base), record every
/// nested leaf path as a workspace origin too, so field-level lookups (e.g. `editor.fontSize`)
/// still report the correct origin.
fn record_leaf_origins(value: &Value, prefix: &str, origins: &mut HashMap<String, ConfigOrigin>) {
    if let Some(obj) = value.as_object() {
        for (key, val) in obj {
            let path = format!("{prefix}.{key}");
            origins.insert(path.clone(), ConfigOrigin::Workspace);
            record_leaf_origins(val, &path, origins);
        }
    }
}

/// Merge a global and workspace `FlintConfig` into one resolved config plus per-path origins.
///
/// Note: because a typed `FlintConfig` always carries every §12 field (defaults fill in
/// anything the source file omitted, via `#[serde(default)]`), serializing an already-typed
/// config back to `Value` cannot distinguish "explicitly set in the file" from "filled in by
/// `Default`". That means this function will over-report origins for any workspace field that
/// happens to equal its own default. The real IPC path (`config_get_with_global_override`) avoids
/// this by merging the *raw* on-disk `Value`s (which only contain keys actually present in the
/// file) before typing, and calls `deep_merge` directly rather than through this function. This
/// function is kept for callers that already hold two resolved `FlintConfig`s and only need a
/// best-effort merge (its origins are not authoritative in that case).
pub fn merged_config(
    global: &FlintConfig,
    workspace: &FlintConfig,
) -> (FlintConfig, HashMap<String, ConfigOrigin>) {
    let mut base = serde_json::to_value(global).unwrap_or_else(|_| serde_json::json!({}));
    let patch = serde_json::to_value(workspace).unwrap_or_else(|_| serde_json::json!({}));
    let mut origins = HashMap::new();
    deep_merge(&mut base, &patch, "", &mut origins);
    let merged: FlintConfig =
        serde_json::from_value(base.clone()).unwrap_or_else(|_| FlintConfig::default());
    (merged, origins)
}

/// Load `path` into a raw `Value` for merge purposes, preserving only the keys actually present
/// in the file (unlike `load_typed_or_default`, which fills in every §12 default). Falls back to
/// an empty object (i.e. "this file contributes nothing") with a notice on any read/parse/version/
/// type failure — the whole file is discarded rather than partially trusted, since we can't tell
/// which of its fields are the ones that are wrong once merged.
fn load_raw_or_default_value(path: &Path) -> (Value, Option<ConfigNotice>) {
    let empty = || Value::Object(serde_json::Map::new());
    if !path.exists() {
        return (empty(), None);
    }
    let path_str = path.display().to_string();
    let bytes = match fs::read(path) {
        Ok(b) => b,
        Err(e) => {
            return (
                empty(),
                Some(ConfigLoadError {
                    path: path_str,
                    field: "<read>".to_string(),
                    message: e.to_string(),
                }),
            )
        }
    };
    if bytes.is_empty() {
        return (empty(), None);
    }
    let value: Value = match serde_json::from_slice(&bytes) {
        Ok(v) => v,
        Err(e) => {
            return (
                empty(),
                Some(ConfigLoadError {
                    path: path_str,
                    field: "<parse>".to_string(),
                    message: e.to_string(),
                }),
            )
        }
    };

    if let Some(version) = value.get("version") {
        if version.as_u64() != Some(CURRENT_CONFIG_VERSION as u64) {
            return (
                empty(),
                Some(ConfigLoadError {
                    path: path_str,
                    field: "version".to_string(),
                    message: format!("unsupported config version: {}", version),
                }),
            );
        }
    }

    // Validate types by attempting a typed parse; discard the whole file on a type error, since
    // a partially-trusted merge could silently mix a broken field into the resolved config.
    if let Err(e) = serde_json::from_value::<FlintConfig>(value.clone()) {
        return (
            empty(),
            Some(ConfigLoadError {
                path: path_str,
                field: e
                    .to_string()
                    .split('`')
                    .nth(1)
                    .unwrap_or("<value>")
                    .to_string(),
                message: e.to_string(),
            }),
        );
    }

    (value, None)
}

// ---------------------------------------------------------------------------------------------
// Global config file (relocated from lib.rs, behavior unchanged, path parameterized for tests)
// ---------------------------------------------------------------------------------------------

/// Retrieve the path to the global Flint config file (SPEC §3.1, M10.04).
/// Returns `$XDG_CONFIG_HOME/flint/config.json` if set, else `~/.config/flint/config.json`.
pub fn get_global_config_path() -> Option<PathBuf> {
    if let Ok(xdg) = std::env::var("XDG_CONFIG_HOME") {
        if !xdg.trim().is_empty() {
            return Some(PathBuf::from(xdg).join("flint").join("config.json"));
        }
    }
    if let Ok(home) = std::env::var("HOME") {
        if !home.trim().is_empty() {
            return Some(
                PathBuf::from(home)
                    .join(".config")
                    .join("flint")
                    .join("config.json"),
            );
        }
    }
    None
}

/// Load the global configuration JSON, if present.
pub fn load_global_config() -> Option<Value> {
    let path = get_global_config_path()?;
    if !path.exists() {
        return None;
    }
    let data = fs::read_to_string(path).ok()?;
    serde_json::from_str(&data).ok()
}

/// Read the remembered `lastWorkspace` path from global configuration, if it exists and is a directory.
pub fn get_last_workspace() -> Option<PathBuf> {
    let config = load_global_config()?;
    let last_ws_str = config.get("lastWorkspace")?.as_str()?;
    let path = PathBuf::from(last_ws_str);
    if path.is_dir() {
        path.canonicalize().ok()
    } else {
        None
    }
}

/// Maximum number of entries kept in the `recentWorkspaces` list.
const MAX_RECENT_WORKSPACES: usize = 8;

/// Persist the `lastWorkspace` canonical path to the global configuration file, and push
/// it to the front of `recentWorkspaces` (deduplicated, most-recent-first, capped).
pub fn save_last_workspace(ws_root: &Path) -> Result<(), std::io::Error> {
    let config_path = match get_global_config_path() {
        Some(p) => p,
        None => return Ok(()),
    };

    if let Some(parent) = config_path.parent() {
        fs::create_dir_all(parent)?;
    }

    let mut config_val = if config_path.exists() {
        fs::read_to_string(&config_path)
            .ok()
            .and_then(|s| serde_json::from_str::<Value>(&s).ok())
            .unwrap_or_else(|| serde_json::json!({}))
    } else {
        serde_json::json!({})
    };

    let canonical = ws_root
        .canonicalize()
        .unwrap_or_else(|_| ws_root.to_path_buf());
    let canonical_str = canonical.display().to_string();

    if let Some(obj) = config_val.as_object_mut() {
        obj.insert(
            "lastWorkspace".to_string(),
            Value::String(canonical_str.clone()),
        );

        let mut recent: Vec<String> = obj
            .get("recentWorkspaces")
            .and_then(|v| v.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|v| v.as_str().map(String::from))
                    .collect()
            })
            .unwrap_or_default();
        recent.retain(|p| p != &canonical_str);
        recent.insert(0, canonical_str);
        recent.truncate(MAX_RECENT_WORKSPACES);

        obj.insert(
            "recentWorkspaces".to_string(),
            Value::Array(recent.into_iter().map(Value::String).collect()),
        );
    }

    let formatted = serde_json::to_string_pretty(&config_val)?;
    fs::write(&config_path, formatted)?;
    Ok(())
}

/// Read the remembered `recentWorkspaces` list from global configuration, most-recent-first.
/// Entries that no longer exist as directories on disk are filtered out.
pub fn get_recent_workspaces() -> Vec<PathBuf> {
    let Some(config) = load_global_config() else {
        return Vec::new();
    };
    let Some(entries) = config.get("recentWorkspaces").and_then(|v| v.as_array()) else {
        return Vec::new();
    };

    entries
        .iter()
        .filter_map(|v| v.as_str())
        .map(PathBuf::from)
        .filter(|p| p.is_dir())
        .collect()
}

// ---------------------------------------------------------------------------------------------
// Per-workspace file I/O (atomic write, unchanged mechanism)
// ---------------------------------------------------------------------------------------------

fn config_path(root: &Path) -> PathBuf {
    root.join(".flint").join("config.json")
}

fn read_config_value(path: &Path) -> Result<Value, NoteError> {
    if !path.exists() {
        return Ok(Value::Object(serde_json::Map::new()));
    }
    let bytes = fs::read(path).map_err(|e| NoteError::Io(e.to_string()))?;
    if bytes.is_empty() {
        return Ok(Value::Object(serde_json::Map::new()));
    }
    serde_json::from_slice(&bytes).map_err(|e| NoteError::Io(e.to_string()))
}

fn write_config_value(path: &Path, value: &Value) -> Result<(), NoteError> {
    let dir = path
        .parent()
        .ok_or_else(|| NoteError::Io("no parent dir".to_string()))?;
    if !dir.exists() {
        fs::create_dir_all(dir).map_err(|e| NoteError::Io(e.to_string()))?;
    }

    let temp_path = dir.join("config.json.flint-tmp");
    let serialized = serde_json::to_vec_pretty(value).map_err(|e| NoteError::Io(e.to_string()))?;

    {
        use std::io::Write;
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .open(&temp_path)
            .map_err(|e| NoteError::Io(e.to_string()))?;
        file.write_all(&serialized)
            .map_err(|e| NoteError::Io(e.to_string()))?;
        file.sync_all().map_err(|e| NoteError::Io(e.to_string()))?;
    }

    fs::rename(&temp_path, path).map_err(|e| {
        let _ = fs::remove_file(&temp_path);
        NoteError::Io(e.to_string())
    })?;

    Ok(())
}

fn set_dotted_path(root_value: &mut Value, key: &str, value: Value) {
    let parts: Vec<&str> = key.split('.').collect();
    let mut current = root_value;
    for (i, part) in parts.iter().enumerate() {
        if !current.is_object() {
            *current = Value::Object(serde_json::Map::new());
        }
        let obj = current.as_object_mut().unwrap();
        if i == parts.len() - 1 {
            obj.insert(part.to_string(), value);
            return;
        }
        current = obj
            .entry(part.to_string())
            .or_insert_with(|| Value::Object(serde_json::Map::new()));
    }
}

fn get_dotted_path<'a>(value: &'a Value, key: &str) -> Option<&'a Value> {
    let mut current = value;
    for part in key.split('.') {
        current = current.as_object()?.get(part)?;
    }
    Some(current)
}

fn remove_dotted_path(root_value: &mut Value, key: &str) {
    let parts: Vec<&str> = key.split('.').collect();
    let mut current = root_value;
    for (i, part) in parts.iter().enumerate() {
        let Some(obj) = current.as_object_mut() else {
            return;
        };
        if i == parts.len() - 1 {
            obj.remove(*part);
            return;
        }
        let Some(next) = obj.get_mut(*part) else {
            return;
        };
        current = next;
    }
}

// ---------------------------------------------------------------------------------------------
// Global config override for tests (hermetic merge tests must not touch the real ~/.config)
// ---------------------------------------------------------------------------------------------

/// Load the effective global `FlintConfig`, optionally from an explicit path (tests only) instead
/// of the real OS config dir.
fn load_global_raw(global_path_override: Option<&Path>) -> (Value, Option<ConfigNotice>) {
    match global_path_override {
        Some(p) => load_raw_or_default_value(p),
        None => match get_global_config_path() {
            Some(p) => load_raw_or_default_value(&p),
            None => (Value::Object(serde_json::Map::new()), None),
        },
    }
}

// ---------------------------------------------------------------------------------------------
// Public IPC-facing API
// ---------------------------------------------------------------------------------------------

/// Result of a keyless `config_get` call: the full merged config, per-path origins, and an
/// optional notice if either file failed to load.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConfigGetResult {
    pub config: Value,
    pub origins: HashMap<String, ConfigOrigin>,
    pub notice: Option<ConfigNotice>,
}

/// Read config: `Some(key)` for the existing single dotted-path lookup (against the merged
/// global+workspace config, falling back to a literal top-level lookup in the merged `extra`
/// map for keys outside the §12 schema, e.g. `outline.confirmMoveToNewNote`); `None` for the
/// full merged config plus origins and an optional load notice.
pub fn config_get(root: &Path, key: Option<&str>) -> Result<ConfigGetResult, NoteError> {
    config_get_with_global_override(root, key, None)
}

/// Same as `config_get`, but allows tests to point at a fake "global" file instead of the real
/// OS config dir, so merge tests stay hermetic.
pub fn config_get_with_global_override(
    root: &Path,
    key: Option<&str>,
    global_path_override: Option<&Path>,
) -> Result<ConfigGetResult, NoteError> {
    let (global_raw, global_notice) = load_global_raw(global_path_override);
    let ws_path = config_path(root);
    let (workspace_raw, workspace_notice) = load_raw_or_default_value(&ws_path);
    let notice = workspace_notice.or(global_notice);

    // Layer: compiled defaults < global file < workspace file. Only the workspace layer's keys
    // are recorded in `origins` (a path absent from `origins` is implicitly a global default,
    // whether that "global default" came from the compiled default or the global file — the UI
    // only distinguishes "workspace override" vs "not overridden").
    let mut merged_value =
        serde_json::to_value(FlintConfig::default()).unwrap_or_else(|_| serde_json::json!({}));
    let mut discarded_origins = HashMap::new();
    deep_merge(&mut merged_value, &global_raw, "", &mut discarded_origins);
    let mut origins = HashMap::new();
    deep_merge(&mut merged_value, &workspace_raw, "", &mut origins);

    let merged: FlintConfig =
        serde_json::from_value(merged_value.clone()).unwrap_or_else(|_| FlintConfig::default());

    match key {
        None => Ok(ConfigGetResult {
            config: merged_value,
            origins,
            notice,
        }),
        Some(k) => {
            let found = get_dotted_path(&merged_value, k).cloned().or_else(|| {
                // Fall back to a literal top-level key in the merged `extra` map, for keys
                // outside the §12 schema (e.g. `outline.confirmMoveToNewNote`).
                merged.extra.get(k).cloned()
            });
            Ok(ConfigGetResult {
                config: found.unwrap_or(Value::Null),
                origins,
                notice,
            })
        }
    }
}

/// Write a single dotted-path config key into the workspace file only (creates
/// `.flint/config.json` if it doesn't exist yet). Unknown keys/paths survive untouched.
pub fn config_set(root: &Path, key: &str, value: Value) -> Result<(), NoteError> {
    let path = config_path(root);
    let mut root_value = read_config_value(&path)?;
    set_dotted_path(&mut root_value, key, value);
    write_config_value(&path, &root_value)
}

/// Delete a dotted-path key's override from the workspace file only, so the merge falls back
/// to the global default. A no-op (not an error) if the key wasn't overridden.
pub fn config_reset(root: &Path, key: &str) -> Result<(), NoteError> {
    let path = config_path(root);
    if !path.exists() {
        return Ok(());
    }
    let mut root_value = read_config_value(&path)?;
    remove_dotted_path(&mut root_value, key);
    write_config_value(&path, &root_value)
}

/// Validate a set of ignore-glob lines, one result per input line: `None` if valid (or
/// blank/whitespace-only, which is skipped), `Some(message)` if `globset::Glob::new` rejects it.
pub fn validate_ignore_patterns(lines: &[String]) -> Vec<Option<String>> {
    lines
        .iter()
        .map(|line| {
            if line.trim().is_empty() {
                None
            } else {
                globset::Glob::new(line).err().map(|e| e.to_string())
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn write_json(path: &Path, value: &Value) {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        fs::write(path, serde_json::to_string_pretty(value).unwrap()).unwrap();
    }

    #[test]
    fn get_missing_key_returns_none() {
        let dir = tempdir().unwrap();
        let result =
            config_get_with_global_override(dir.path(), Some("outline.confirmMoveToNewNote"), None)
                .unwrap();
        assert_eq!(result.config, Value::Null);
    }

    #[test]
    fn set_then_get_round_trips() {
        let dir = tempdir().unwrap();
        config_set(
            dir.path(),
            "outline.confirmMoveToNewNote",
            Value::Bool(false),
        )
        .unwrap();
        let result =
            config_get_with_global_override(dir.path(), Some("outline.confirmMoveToNewNote"), None)
                .unwrap();
        assert_eq!(result.config, Value::Bool(false));
    }

    #[test]
    fn set_preserves_other_keys() {
        let dir = tempdir().unwrap();
        config_set(dir.path(), "custom.a", Value::from(1)).unwrap();
        config_set(dir.path(), "custom.b", Value::from(2)).unwrap();
        let result = config_get_with_global_override(dir.path(), Some("custom.a"), None).unwrap();
        assert_eq!(result.config, Value::from(1));
        let result = config_get_with_global_override(dir.path(), Some("custom.b"), None).unwrap();
        assert_eq!(result.config, Value::from(2));
    }

    #[test]
    fn write_is_atomic_no_leftover_temp_file() {
        let dir = tempdir().unwrap();
        config_set(dir.path(), "theme", Value::from("dark")).unwrap();
        assert!(!dir
            .path()
            .join(".flint")
            .join("config.json.flint-tmp")
            .exists());
        assert!(dir.path().join(".flint").join("config.json").exists());
    }

    #[test]
    fn config_merge_workspace_overrides_global_field() {
        let dir = tempdir().unwrap();
        let global_dir = tempdir().unwrap();
        let global_path = global_dir.path().join("config.json");
        write_json(&global_path, &serde_json::json!({"theme": "light"}));

        config_set(dir.path(), "theme", Value::from("dark")).unwrap();

        let result =
            config_get_with_global_override(dir.path(), None, Some(global_path.as_path())).unwrap();
        assert_eq!(result.config["theme"], Value::from("dark"));
        assert_eq!(result.origins.get("theme"), Some(&ConfigOrigin::Workspace));
    }

    #[test]
    fn config_merge_falls_back_to_global_when_workspace_silent() {
        let dir = tempdir().unwrap();
        let global_dir = tempdir().unwrap();
        let global_path = global_dir.path().join("config.json");
        write_json(&global_path, &serde_json::json!({"theme": "light"}));

        // Workspace overrides an unrelated field only.
        config_set(dir.path(), "editor.tabSize", Value::from(4)).unwrap();

        let result =
            config_get_with_global_override(dir.path(), None, Some(global_path.as_path())).unwrap();
        assert_eq!(result.config["theme"], Value::from("light"));
        assert!(result.origins.get("theme").is_none());
        assert_eq!(
            result.origins.get("editor.tabSize"),
            Some(&ConfigOrigin::Workspace)
        );
    }

    #[test]
    fn unknown_top_level_and_nested_key_roundtrip() {
        let dir = tempdir().unwrap();
        let path = dir.path().join(".flint").join("config.json");
        let mut base = serde_json::to_value(FlintConfig::default()).unwrap();
        base["customTopLevel"] = Value::from("hello");
        base["editor"]["customNested"] = Value::from(42);
        write_json(&path, &base);

        // Unrelated config_set call.
        config_set(dir.path(), "theme", Value::from("dark")).unwrap();

        let result = config_get_with_global_override(dir.path(), None, None).unwrap();
        assert_eq!(result.config["customTopLevel"], Value::from("hello"));
        assert_eq!(result.config["editor"]["customNested"], Value::from(42));
        assert_eq!(result.config["theme"], Value::from("dark"));
    }

    #[test]
    fn invalid_json_falls_back_to_defaults_with_notice() {
        let dir = tempdir().unwrap();
        let path = dir.path().join(".flint").join("config.json");
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, "{ not valid json").unwrap();

        let result = config_get_with_global_override(dir.path(), None, None).unwrap();
        assert!(result.notice.is_some());
        assert_eq!(result.config["theme"], Value::from("system"));
    }

    #[test]
    fn invalid_field_type_falls_back_to_defaults_with_notice() {
        let dir = tempdir().unwrap();
        let path = dir.path().join(".flint").join("config.json");
        let mut base = serde_json::to_value(FlintConfig::default()).unwrap();
        base["editor"]["fontSize"] = Value::from("big");
        write_json(&path, &base);

        let result = config_get_with_global_override(dir.path(), None, None).unwrap();
        assert!(result.notice.is_some());
        assert_eq!(result.config["editor"]["fontSize"], Value::from(14));
    }

    #[test]
    fn unknown_version_falls_back_to_defaults_with_notice() {
        let dir = tempdir().unwrap();
        let path = dir.path().join(".flint").join("config.json");
        let mut base = serde_json::to_value(FlintConfig::default()).unwrap();
        base["version"] = Value::from(99);
        write_json(&path, &base);

        let result = config_get_with_global_override(dir.path(), None, None).unwrap();
        assert!(result.notice.is_some());
        assert_eq!(result.config["version"], Value::from(1));
    }

    #[test]
    fn global_broken_editor_block_does_not_lose_last_workspace_data() {
        // Global file is used raw (Value) by get_last_workspace/save_last_workspace, and typed
        // (FlintConfig) by config_get's merge path — a broken `editor` block in the global file
        // must fall back to defaults for the §12 merge without touching those raw fields, since
        // they live in the same file but are read through a completely separate function.
        let dir = tempdir().unwrap();
        let global_dir = tempdir().unwrap();
        let global_path = global_dir.path().join("config.json");
        write_json(
            &global_path,
            &serde_json::json!({
                "lastWorkspace": "/some/path",
                "recentWorkspaces": ["/some/path"],
                "editor": {"fontSize": "not-a-number"}
            }),
        );

        let result =
            config_get_with_global_override(dir.path(), None, Some(global_path.as_path())).unwrap();
        assert!(result.notice.is_some());
        assert_eq!(result.config["editor"]["fontSize"], Value::from(14));

        // The raw file on disk is untouched (config_get never writes the global file), so the
        // raw lastWorkspace/recentWorkspaces fields are still there for get_last_workspace-style
        // readers.
        let raw: Value = serde_json::from_str(&fs::read_to_string(&global_path).unwrap()).unwrap();
        assert_eq!(raw["lastWorkspace"], Value::from("/some/path"));
    }

    #[test]
    fn config_reset_removes_workspace_override_falls_back_to_global() {
        let dir = tempdir().unwrap();
        let global_dir = tempdir().unwrap();
        let global_path = global_dir.path().join("config.json");
        write_json(&global_path, &serde_json::json!({"theme": "light"}));

        config_set(dir.path(), "theme", Value::from("dark")).unwrap();
        config_reset(dir.path(), "theme").unwrap();

        let result =
            config_get_with_global_override(dir.path(), None, Some(global_path.as_path())).unwrap();
        assert_eq!(result.config["theme"], Value::from("light"));
        assert!(result.origins.get("theme").is_none());
    }

    #[test]
    fn config_reset_missing_override_is_noop() {
        let dir = tempdir().unwrap();
        // No prior override at all — should not error.
        config_reset(dir.path(), "theme").unwrap();
    }

    #[test]
    fn ignore_pattern_validation_reports_per_line_errors() {
        let lines = vec![
            "node_modules/**".to_string(),
            "".to_string(),
            "[unbalanced".to_string(),
        ];
        let results = validate_ignore_patterns(&lines);
        assert_eq!(results.len(), 3);
        assert!(results[0].is_none());
        assert!(results[1].is_none());
        assert!(results[2].is_some());
    }
}
