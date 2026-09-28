//! Flint configuration: global defaults + per-workspace overrides (SPEC §11/§12, M10.1; storage
//! moved to an embedded database in M10.21).
//!
//! The global side is still a plain JSON file (OS config dir, `lastWorkspace`/`recentWorkspaces`
//! plus any global §12 defaults a user sets) — M10.21 didn't touch it, since it was never inside
//! a workspace's `.flint/` folder or workspace root. The *workspace* side used to be a single
//! `<workspace>/.flint/config.json` file; as of M10.21 it's `<workspace-root>/.flint.db`, an
//! embedded database (via `redb`, a pure-Rust engine — this is not SQLite, despite the
//! extension), one row per dotted config key in a `config` table (plus a separate `mcp_auth`
//! table for the local MCP server's optional bearer-token state, since a generated secret isn't
//! really a user-edited "config" field the same way `theme` or `editor.fontSize` are).
//!
//! Reading a "merged" config means: load both sides (falling back to `FlintConfig::default()` per
//! side if it's missing, malformed, or mistyped — bad data never blocks startup), then deep-merge
//! the workspace `Value` over the global `Value` field-by-field, recording which dotted paths came
//! from the workspace side in an `origins` map (a path absent from `origins` is implicitly a
//! global default) so the UI can show "workspace override" vs "global default" badges.
//! `config_get`/`config_set`/`config_reset`'s public contract is unchanged from before M10.21 —
//! only the workspace side's on-disk representation moved.

use crate::NoteError;
use redb::{Database, ReadableTable, TableDefinition};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

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

/// Which link syntax the editor's link-insertion commands (command palette, `[` autocomplete,
/// drag-and-drop note linking) produce. Forced to `Markdown` whenever [`MarkdownConfig::wikilinks`]
/// is off — see [`MarkdownConfig::effective_new_link_syntax`] (M10.23).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum NewLinkSyntax {
    #[default]
    Markdown,
    Wikilink,
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
    /// Second, opt-in link syntax: `[[target]]`, `[[target|alias]]`, `[[target#heading]]`,
    /// `![[target]]` (M10.23). Off by default — `[[...]]` is inert literal text until enabled.
    #[serde(default)]
    pub wikilinks: bool,
    /// Which syntax new links are inserted as. See [`NewLinkSyntax`] and
    /// [`MarkdownConfig::effective_new_link_syntax`] — this raw field may still say `Wikilink`
    /// while `wikilinks` is off; callers must go through the effective accessor.
    #[serde(default)]
    pub new_link_syntax: NewLinkSyntax,
    #[serde(flatten)]
    pub extra: serde_json::Map<String, Value>,
}

impl MarkdownConfig {
    /// `new_link_syntax`, forced to `Markdown` when `wikilinks` is off (M10.23) — wikilink
    /// *insertion* cannot be enabled while wikilink *parsing* is off, since that combination would
    /// insert dead text. Every consumer of "which syntax should a new link use" must call this
    /// rather than reading `new_link_syntax` directly.
    pub fn effective_new_link_syntax(&self) -> NewLinkSyntax {
        if self.wikilinks {
            self.new_link_syntax
        } else {
            NewLinkSyntax::Markdown
        }
    }
}

impl Default for MarkdownConfig {
    fn default() -> Self {
        Self {
            math: true,
            tables: true,
            footnotes: true,
            smart_punctuation: true,
            wikilinks: false,
            new_link_syntax: NewLinkSyntax::Markdown,
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
    /// Whether renaming a tag also rewrites inline `#tag` occurrences across the workspace, on
    /// top of the front-matter `tags:` entries a tag rename always rewrites (SPEC/M10.25).
    #[serde(default)]
    pub rewrite_tags_on_rename: bool,
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
            rewrite_tags_on_rename: true,
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

/// Local MCP server settings (M10.21). Off by default: this is new, opt-in surface area, not
/// the "no network requests" outbound invariant (SPEC §10.3.5) — the server only accepts local,
/// loopback-only inbound connections and never initiates outbound requests.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpConfig {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default)]
    pub port: Option<u16>,
    /// Require a bearer token on every MCP request (M10.21 change: off by default — the token
    /// itself is never a config field, it's generated/rotated from the app's Settings UI and
    /// persisted separately in `.flint.db`'s `mcp_auth` table, see [`get_mcp_token`]).
    #[serde(default)]
    pub require_auth: bool,
    #[serde(flatten)]
    pub extra: serde_json::Map<String, Value>,
}

/// Default fixed port the MCP server tries first before falling back to an ephemeral one.
pub const DEFAULT_MCP_PORT: u16 = 4870;

impl Default for McpConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            port: None,
            require_auth: false,
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
    pub mcp: McpConfig,
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
            mcp: McpConfig::default(),
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

/// Load `path` (the *global* config file — the workspace side uses
/// [`read_workspace_config_value`] instead, since M10.21) into a raw `Value` for merge purposes,
/// preserving only the keys actually present in the file (unlike `load_typed_or_default`, which
/// fills in every §12 default). Falls back to an empty object (i.e. "this file contributes
/// nothing") with a notice on any read/parse/version/type failure — the whole file is discarded
/// rather than partially trusted, since we can't tell which of its fields are the ones that are
/// wrong once merged.
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
// Per-workspace storage: `.flint.db`, an embedded database via `redb` (M10.21)
// ---------------------------------------------------------------------------------------------

/// The `config` table: one row per dotted config key (`theme`, `editor.fontSize`, `mcp.enabled`,
/// ...), value is that key's JSON-serialized `Value`.
const CONFIG_TABLE: TableDefinition<&str, &str> = TableDefinition::new("config");

/// The `mcp_auth` table: a single row (key `"token"`) holding the local MCP server's optional
/// bearer-token record, JSON-serialized. Kept separate from `config` because a generated secret
/// isn't a user-edited setting the same way the rest of `FlintConfig` is.
const MCP_AUTH_TABLE: TableDefinition<&str, &str> = TableDefinition::new("mcp_auth");
const MCP_AUTH_TOKEN_KEY: &str = "token";

/// The local MCP server's persisted bearer-token state (M10.21). Generated/rotated only from the
/// app's Settings UI — never automatically at launch — so it survives restarts.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct McpTokenRecord {
    pub token: String,
    pub created_at_ms: u64,
    pub rotated_at_ms: u64,
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn db_path(root: &Path) -> PathBuf {
    root.join(".flint.db")
}

fn open_db(root: &Path) -> Result<Database, NoteError> {
    Database::create(db_path(root)).map_err(|e| NoteError::Io(e.to_string()))
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

/// Read every row of the workspace `config` table and rebuild the nested `Value` tree
/// `deep_merge` expects — the same shape the old `.flint/config.json` file used to produce:
/// only keys actually present as rows, nothing filled in from defaults. A missing db or a db with
/// no `config` table yet (a fresh workspace) is "no rows", not an error.
///
/// A row whose stored text isn't valid JSON is skipped (with a notice) rather than discarding
/// everything — corruption in one key no longer has to take down the whole config the way a
/// malformed *file* used to. The reconstructed tree is still validated as a whole afterward (a
/// `version` mismatch, or any field with the wrong type once merged, discards the *entire* tree
/// back to defaults with a notice) — that whole-tree gate is unchanged from before M10.21.
fn read_workspace_config_value(root: &Path) -> (Value, Option<ConfigNotice>) {
    let empty = || Value::Object(serde_json::Map::new());
    let path_str = db_path(root).display().to_string();
    let notice_at = |field: &str, message: String| {
        Some(ConfigLoadError {
            path: path_str.clone(),
            field: field.to_string(),
            message,
        })
    };

    let db = match open_db(root) {
        Ok(db) => db,
        Err(e) => return (empty(), notice_at("<open>", e.to_string())),
    };
    let read_txn = match db.begin_read() {
        Ok(txn) => txn,
        Err(e) => return (empty(), notice_at("<read>", e.to_string())),
    };
    let table = match read_txn.open_table(CONFIG_TABLE) {
        Ok(table) => table,
        Err(redb::TableError::TableDoesNotExist(_)) => return (empty(), None),
        Err(e) => return (empty(), notice_at("<open-table>", e.to_string())),
    };

    let mut root_value = empty();
    let mut notice = None;
    let iter = match table.iter() {
        Ok(iter) => iter,
        Err(e) => return (empty(), notice_at("<iter>", e.to_string())),
    };
    for entry in iter {
        let (key_guard, value_guard) = match entry {
            Ok(pair) => pair,
            Err(e) => {
                notice = notice_at("<row>", e.to_string());
                continue;
            }
        };
        let key = key_guard.value().to_string();
        match serde_json::from_str::<Value>(value_guard.value()) {
            Ok(value) => set_dotted_path(&mut root_value, &key, value),
            Err(e) => notice = notice_at(&key, e.to_string()),
        }
    }

    if let Some(version) = root_value.get("version") {
        if version.as_u64() != Some(CURRENT_CONFIG_VERSION as u64) {
            return (
                empty(),
                notice_at(
                    "version",
                    format!("unsupported config version: {}", version),
                ),
            );
        }
    }

    if let Err(e) = serde_json::from_value::<FlintConfig>(root_value.clone()) {
        return (
            empty(),
            notice_at(
                e.to_string().split('`').nth(1).unwrap_or("<value>"),
                e.to_string(),
            ),
        );
    }

    (root_value, notice)
}

/// Ensure `<workspace-root>/.flint.db` exists and its `config` table has at least the full set
/// of top-level default fields (matching the fidelity of the old `bootstrap_workspace`, which
/// eagerly wrote every §12 default into a fresh `.flint/config.json`) — a no-op if the table
/// already has rows. Called once per workspace open (M10.21).
pub fn bootstrap_workspace_db(root: &Path) -> Result<PathBuf, NoteError> {
    let path = db_path(root);
    let db = open_db(root)?;

    let has_rows = {
        let read_txn = db.begin_read().map_err(|e| NoteError::Io(e.to_string()))?;
        match read_txn.open_table(CONFIG_TABLE) {
            Ok(table) => table
                .iter()
                .map_err(|e| NoteError::Io(e.to_string()))?
                .next()
                .is_some(),
            Err(redb::TableError::TableDoesNotExist(_)) => false,
            Err(e) => return Err(NoteError::Io(e.to_string())),
        }
    };

    if !has_rows {
        let default_value = serde_json::to_value(FlintConfig::default())
            .map_err(|e| NoteError::Io(e.to_string()))?;
        if let Some(obj) = default_value.as_object() {
            let write_txn = db.begin_write().map_err(|e| NoteError::Io(e.to_string()))?;
            {
                let mut table = write_txn
                    .open_table(CONFIG_TABLE)
                    .map_err(|e| NoteError::Io(e.to_string()))?;
                for (key, value) in obj {
                    let raw =
                        serde_json::to_string(value).map_err(|e| NoteError::Io(e.to_string()))?;
                    table
                        .insert(key.as_str(), raw.as_str())
                        .map_err(|e| NoteError::Io(e.to_string()))?;
                }
            }
            write_txn
                .commit()
                .map_err(|e| NoteError::Io(e.to_string()))?;
        }
    }

    Ok(path)
}

/// Write a single dotted-path config key as one row. Simpler than the old file-based
/// read-modify-write-whole-file dance: each key is an independent row, so setting one never
/// touches any other.
pub fn config_set(root: &Path, key: &str, value: Value) -> Result<(), NoteError> {
    let db = open_db(root)?;
    let raw = serde_json::to_string(&value).map_err(|e| NoteError::Io(e.to_string()))?;
    let write_txn = db.begin_write().map_err(|e| NoteError::Io(e.to_string()))?;
    {
        let mut table = write_txn
            .open_table(CONFIG_TABLE)
            .map_err(|e| NoteError::Io(e.to_string()))?;
        table
            .insert(key, raw.as_str())
            .map_err(|e| NoteError::Io(e.to_string()))?;
    }
    write_txn
        .commit()
        .map_err(|e| NoteError::Io(e.to_string()))?;
    Ok(())
}

/// Delete a dotted-path key's row, plus any row nested under it (resetting `"editor"` also
/// removes `"editor.fontSize"` etc.), falling back to the global default. A no-op if nothing
/// matched.
pub fn config_reset(root: &Path, key: &str) -> Result<(), NoteError> {
    let db = open_db(root)?;
    let write_txn = db.begin_write().map_err(|e| NoteError::Io(e.to_string()))?;
    {
        let mut table = write_txn
            .open_table(CONFIG_TABLE)
            .map_err(|e| NoteError::Io(e.to_string()))?;
        let prefix = format!("{key}.");
        let mut to_remove = Vec::new();
        for entry in table.iter().map_err(|e| NoteError::Io(e.to_string()))? {
            let (k, _) = entry.map_err(|e| NoteError::Io(e.to_string()))?;
            let k = k.value().to_string();
            if k == key || k.starts_with(&prefix) {
                to_remove.push(k);
            }
        }
        for k in to_remove {
            table
                .remove(k.as_str())
                .map_err(|e| NoteError::Io(e.to_string()))?;
        }
    }
    write_txn
        .commit()
        .map_err(|e| NoteError::Io(e.to_string()))?;
    Ok(())
}

/// Read the local MCP server's persisted bearer-token record, if one has ever been generated.
/// `None` means auth (when required) is currently fail-closed — every request gets rejected until
/// [`set_mcp_token`] is called from the app's Settings UI.
pub fn get_mcp_token(root: &Path) -> Result<Option<McpTokenRecord>, NoteError> {
    let db = open_db(root)?;
    let read_txn = db.begin_read().map_err(|e| NoteError::Io(e.to_string()))?;
    let table = match read_txn.open_table(MCP_AUTH_TABLE) {
        Ok(table) => table,
        Err(redb::TableError::TableDoesNotExist(_)) => return Ok(None),
        Err(e) => return Err(NoteError::Io(e.to_string())),
    };
    let Some(raw) = table
        .get(MCP_AUTH_TOKEN_KEY)
        .map_err(|e| NoteError::Io(e.to_string()))?
    else {
        return Ok(None);
    };
    serde_json::from_str(raw.value())
        .map(Some)
        .map_err(|e| NoteError::Io(e.to_string()))
}

/// Generate (or rotate — same operation) the local MCP server's bearer token, persisting a fresh
/// timestamped record and returning it. This is the only way a token is ever created; there is no
/// auto-generated-at-launch token anymore (M10.21 change).
pub fn set_mcp_token(root: &Path, token: &str) -> Result<McpTokenRecord, NoteError> {
    let existing = get_mcp_token(root)?;
    let now = now_ms();
    let record = McpTokenRecord {
        token: token.to_string(),
        created_at_ms: existing.map(|r| r.created_at_ms).unwrap_or(now),
        rotated_at_ms: now,
    };
    let raw = serde_json::to_string(&record).map_err(|e| NoteError::Io(e.to_string()))?;

    let db = open_db(root)?;
    let write_txn = db.begin_write().map_err(|e| NoteError::Io(e.to_string()))?;
    {
        let mut table = write_txn
            .open_table(MCP_AUTH_TABLE)
            .map_err(|e| NoteError::Io(e.to_string()))?;
        table
            .insert(MCP_AUTH_TOKEN_KEY, raw.as_str())
            .map_err(|e| NoteError::Io(e.to_string()))?;
    }
    write_txn
        .commit()
        .map_err(|e| NoteError::Io(e.to_string()))?;
    Ok(record)
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
    let (workspace_raw, workspace_notice) = read_workspace_config_value(root);
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

    /// Insert one row directly into `.flint.db`'s `config` table, bypassing `config_set`'s
    /// JSON-encoding — used to simulate a corrupted/malformed row for the "falls back to
    /// defaults with a notice" tests below.
    fn insert_raw_config_row(root: &Path, key: &str, raw: &str) {
        let db = open_db(root).unwrap();
        let write_txn = db.begin_write().unwrap();
        {
            let mut table = write_txn.open_table(CONFIG_TABLE).unwrap();
            table.insert(key, raw).unwrap();
        }
        write_txn.commit().unwrap();
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
    fn write_persists_to_flint_db_and_creates_no_flint_dir() {
        let dir = tempdir().unwrap();
        config_set(dir.path(), "theme", Value::from("dark")).unwrap();
        assert!(dir.path().join(".flint.db").exists());
        assert!(!dir.path().join(".flint").exists());
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
        assert!(!result.origins.contains_key("theme"));
        assert_eq!(
            result.origins.get("editor.tabSize"),
            Some(&ConfigOrigin::Workspace)
        );
    }

    #[test]
    fn unknown_top_level_and_nested_key_roundtrip() {
        let dir = tempdir().unwrap();
        config_set(dir.path(), "customTopLevel", Value::from("hello")).unwrap();
        config_set(dir.path(), "editor.customNested", Value::from(42)).unwrap();

        // Unrelated config_set call.
        config_set(dir.path(), "theme", Value::from("dark")).unwrap();

        let result = config_get_with_global_override(dir.path(), None, None).unwrap();
        assert_eq!(result.config["customTopLevel"], Value::from("hello"));
        assert_eq!(result.config["editor"]["customNested"], Value::from(42));
        assert_eq!(result.config["theme"], Value::from("dark"));
    }

    #[test]
    fn invalid_json_row_is_skipped_with_notice_others_still_apply() {
        let dir = tempdir().unwrap();
        config_set(dir.path(), "editor.tabSize", Value::from(4)).unwrap();
        insert_raw_config_row(dir.path(), "theme", "{ not valid json");

        let result = config_get_with_global_override(dir.path(), None, None).unwrap();
        assert!(result.notice.is_some());
        // The corrupt "theme" row is skipped (falls back to its default), but the other,
        // validly-stored row is unaffected — per-row resilience, not a whole-tree discard.
        assert_eq!(result.config["theme"], Value::from("system"));
        assert_eq!(result.config["editor"]["tabSize"], Value::from(4));
    }

    #[test]
    fn invalid_field_type_falls_back_to_defaults_with_notice() {
        let dir = tempdir().unwrap();
        // A JSON string ("big") where `editor.fontSize` needs a number — parses fine as JSON,
        // but fails the whole-tree `FlintConfig` type-validation pass, so the entire
        // reconstructed tree (not just this row) is discarded.
        insert_raw_config_row(dir.path(), "editor.fontSize", "\"big\"");

        let result = config_get_with_global_override(dir.path(), None, None).unwrap();
        assert!(result.notice.is_some());
        assert_eq!(result.config["editor"]["fontSize"], Value::from(14));
    }

    #[test]
    fn unknown_version_falls_back_to_defaults_with_notice() {
        let dir = tempdir().unwrap();
        insert_raw_config_row(dir.path(), "version", "99");

        let result = config_get_with_global_override(dir.path(), None, None).unwrap();
        assert!(result.notice.is_some());
        assert_eq!(result.config["version"], Value::from(1));
    }

    #[test]
    fn mcp_token_round_trips_and_rotation_updates_timestamps() {
        let dir = tempdir().unwrap();
        assert_eq!(get_mcp_token(dir.path()).unwrap(), None);

        let first = set_mcp_token(dir.path(), "token-one").unwrap();
        assert_eq!(first.token, "token-one");
        assert_eq!(first.created_at_ms, first.rotated_at_ms);
        assert_eq!(get_mcp_token(dir.path()).unwrap(), Some(first.clone()));

        let second = set_mcp_token(dir.path(), "token-two").unwrap();
        assert_eq!(second.token, "token-two");
        assert_eq!(
            second.created_at_ms, first.created_at_ms,
            "rotating keeps the original creation timestamp"
        );
        assert_eq!(get_mcp_token(dir.path()).unwrap(), Some(second));
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
        assert!(!result.origins.contains_key("theme"));
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
