//! MCP tool handlers (M10.21). Every handler here is a thin wrapper around the exact same
//! `flint-core` functions (and the same suppressed-write / incremental-index bookkeeping) the
//! Tauri IPC commands in `lib.rs` use — no parallel filesystem path exists for MCP clients.

use flint_core::{
    build_workspace_tree, config_get, create_folder, create_note, delete_folder, insert_link,
    links_outgoing, patch_section, read_note, rename_path, set_front_matter_fields,
    write_note_atomic, ContentSearchOptions, Fingerprint, Index, LinkLocation, NoteError, SafePath,
};
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::fmt;
use std::path::Path;
use std::sync::{Arc, Mutex, RwLock};
use tauri::{AppHandle, Emitter};

use crate::{NoteEventPayload, SuppressedWrite};

pub struct ToolCtx<'a> {
    pub root: &'a Path,
    pub index: &'a Arc<RwLock<Index>>,
    pub suppressed_writes: &'a Arc<Mutex<HashMap<String, SuppressedWrite>>>,
    pub app_handle: &'a AppHandle,
}

/// Tell the running GUI a note changed, the same way the filesystem watcher would for an
/// external edit — necessary because a suppressed write (which every MCP write records, to stop
/// the watcher double-processing its own write) means the watcher itself stays silent, and unlike
/// an IPC command invoked from the frontend, no caller is already sitting on the result to
/// refresh the tree/stats itself.
fn emit_note_event(ctx: &ToolCtx, event: &str, path: &str) {
    let _ = ctx.app_handle.emit(
        event,
        NoteEventPayload {
            path: path.to_string(),
        },
    );
}

/// A tool call's error result, surfaced as MCP tool error content (`isError: true`) — never a
/// silently swallowed failure. `to_string()` is the exact text handed back to the calling agent,
/// so a conflict is rendered as structured JSON the agent can parse and act on (M10.21's "three
/// named recovery options" requirement), while every other error is a plain message.
pub struct ToolCallError(String);

impl fmt::Display for ToolCallError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

fn plain_error(message: impl Into<String>) -> ToolCallError {
    ToolCallError(message.into())
}

/// Map a `NoteError` into tool-call error content, giving `Conflict` its own structured JSON
/// shape (fingerprint mismatch + the three human-banner recovery options, machine-readable) so
/// the calling agent can re-read and retry instead of the write silently overwriting a concurrent
/// edit (SPEC §10.3, M10.21).
fn map_note_error(e: NoteError) -> ToolCallError {
    if let NoteError::Conflict { expected, actual } = &e {
        let payload = json!({
            "error": "conflict",
            "expected_fingerprint": expected,
            "actual_fingerprint": actual,
            "options": ["keep_your_version", "load_disk_version", "show_differences"],
        });
        return ToolCallError(payload.to_string());
    }
    plain_error(e.to_string())
}

fn resolve(root: &Path, path: &str) -> Result<SafePath, ToolCallError> {
    SafePath::resolve(root, path).map_err(|e| plain_error(e.to_string()))
}

/// Tool definitions advertised to `tools/list`, split by capability per the M10.21 prompt.
pub fn list_tools() -> Vec<Value> {
    vec![
        tool_def(
            "workspace_tree",
            "List the workspace's file tree.",
            json!({ "type": "object", "properties": {} }),
        ),
        tool_def(
            "workspace_stats",
            "Get live workspace statistics (note count, link count, etc.) from the in-memory index.",
            json!({ "type": "object", "properties": {} }),
        ),
        tool_def(
            "note_read",
            "Read a note's content, metadata, and fingerprint (needed for conflict-safe writes).",
            json!({
                "type": "object",
                "properties": { "path": { "type": "string" } },
                "required": ["path"]
            }),
        ),
        tool_def(
            "note_render",
            "Render a note's Markdown to sanitized HTML plus its heading outline.",
            json!({
                "type": "object",
                "properties": {
                    "path": { "type": "string" },
                    "theme": { "type": "string" }
                },
                "required": ["path"]
            }),
        ),
        tool_def(
            "links_outgoing",
            "List a note's outgoing links.",
            json!({
                "type": "object",
                "properties": { "path": { "type": "string" } },
                "required": ["path"]
            }),
        ),
        tool_def(
            "links_backlinks",
            "List backlinks pointing at a note, from the in-memory index.",
            json!({
                "type": "object",
                "properties": { "path": { "type": "string" } },
                "required": ["path"]
            }),
        ),
        tool_def(
            "search_names",
            "Fuzzy-search note titles and paths.",
            json!({
                "type": "object",
                "properties": {
                    "query": { "type": "string" },
                    "limit": { "type": "integer" }
                },
                "required": ["query"]
            }),
        ),
        tool_def(
            "search_content",
            "Search note content across the workspace.",
            json!({
                "type": "object",
                "properties": {
                    "query": { "type": "string" },
                    "case_sensitive": { "type": "boolean" },
                    "whole_word": { "type": "boolean" },
                    "is_regex": { "type": "boolean" }
                },
                "required": ["query"]
            }),
        ),
        tool_def(
            "config_get",
            "Read a dotted-path config key (or the full merged config if omitted).",
            json!({
                "type": "object",
                "properties": { "key": { "type": "string" } }
            }),
        ),
        tool_def(
            "note_create",
            "Create a new note at a workspace-relative path.",
            json!({
                "type": "object",
                "properties": {
                    "path": { "type": "string" },
                    "template": { "type": "string" }
                },
                "required": ["path"]
            }),
        ),
        tool_def(
            "frontmatter_set",
            "Add, edit, or delete front-matter fields on a note without disturbing untouched keys or the body.",
            json!({
                "type": "object",
                "properties": {
                    "path": { "type": "string" },
                    "fields": {
                        "type": "array",
                        "items": { "type": "array", "items": { "type": "string" }, "minItems": 2, "maxItems": 2 }
                    },
                    "fingerprint": { "type": "object" }
                },
                "required": ["path", "fields"]
            }),
        ),
        tool_def(
            "note_rename",
            "Move/rename a note or folder, rewriting relative links by default.",
            json!({
                "type": "object",
                "properties": {
                    "from": { "type": "string" },
                    "to": { "type": "string" },
                    "rewrite_links": { "type": "boolean" }
                },
                "required": ["from", "to"]
            }),
        ),
        tool_def(
            "folder_create",
            "Create a folder inside the workspace.",
            json!({
                "type": "object",
                "properties": { "path": { "type": "string" } },
                "required": ["path"]
            }),
        ),
        tool_def(
            "folder_delete",
            "Delete a folder (to OS trash by default).",
            json!({
                "type": "object",
                "properties": {
                    "path": { "type": "string" },
                    "permanent": { "type": "boolean" }
                },
                "required": ["path"]
            }),
        ),
        tool_def(
            "note_patch_section",
            "Replace one section's body Markdown (by heading path) without touching the heading itself or any other section.",
            json!({
                "type": "object",
                "properties": {
                    "path": { "type": "string" },
                    "heading_path": { "type": "array", "items": { "type": "string" } },
                    "new_body": { "type": "string" },
                    "fingerprint": { "type": "object" }
                },
                "required": ["path", "heading_path", "new_body"]
            }),
        ),
        tool_def(
            "note_insert_link",
            "Insert a Markdown inline link to another note, either at a given line or appended to a 'Related' section (created if absent).",
            json!({
                "type": "object",
                "properties": {
                    "path": { "type": "string" },
                    "target_path": { "type": "string" },
                    "link_text": { "type": "string" },
                    "after_line": { "type": "integer" },
                    "fingerprint": { "type": "object" }
                },
                "required": ["path", "target_path"]
            }),
        ),
    ]
}

fn tool_def(name: &str, description: &str, input_schema: Value) -> Value {
    json!({ "name": name, "description": description, "inputSchema": input_schema })
}

pub fn call_tool(name: &str, arguments: Value, ctx: &ToolCtx) -> Result<Value, ToolCallError> {
    match name {
        "workspace_tree" => {
            let ignore = config_get(ctx.root, None)
                .ok()
                .and_then(|r| r.config.get("ignore").cloned())
                .and_then(|v| serde_json::from_value::<Vec<String>>(v).ok())
                .unwrap_or_default();
            let tree = build_workspace_tree(ctx.root, false, &ignore)
                .map_err(|e| plain_error(e.to_string()))?;
            Ok(json!(tree))
        }
        "workspace_stats" => {
            let lock = ctx.index.read().map_err(|e| plain_error(e.to_string()))?;
            Ok(json!(lock.get_stats()))
        }
        "note_read" => {
            #[derive(Deserialize)]
            struct Args {
                path: String,
            }
            let args: Args = parse_args(arguments)?;
            let safe = resolve(ctx.root, &args.path)?;
            let note = read_note(ctx.root, &safe).map_err(map_note_error)?;
            Ok(json!(note))
        }
        "note_render" => {
            #[derive(Deserialize)]
            struct Args {
                path: String,
                theme: Option<String>,
            }
            let args: Args = parse_args(arguments)?;
            let safe = resolve(ctx.root, &args.path)?;
            let note = read_note(ctx.root, &safe).map_err(map_note_error)?;
            let theme = args.theme.unwrap_or_else(|| "dark".to_string());
            let result = flint_core::render_note_markdown(
                &note.content,
                &theme,
                Some(ctx.root),
                Some(&args.path),
            );
            Ok(json!(result))
        }
        "links_outgoing" => {
            #[derive(Deserialize)]
            struct Args {
                path: String,
            }
            let args: Args = parse_args(arguments)?;
            let safe = resolve(ctx.root, &args.path)?;
            let links = links_outgoing(ctx.root, &safe, None).map_err(map_note_error)?;
            Ok(json!(links))
        }
        "links_backlinks" => {
            #[derive(Deserialize)]
            struct Args {
                path: String,
            }
            let args: Args = parse_args(arguments)?;
            let lock = ctx.index.read().map_err(|e| plain_error(e.to_string()))?;
            Ok(json!(lock.get_backlinks(&args.path)))
        }
        "search_names" => {
            #[derive(Deserialize)]
            struct Args {
                query: String,
                limit: Option<usize>,
            }
            let args: Args = parse_args(arguments)?;
            let lock = ctx.index.read().map_err(|e| plain_error(e.to_string()))?;
            Ok(json!(lock.search_names(&args.query, args.limit)))
        }
        "search_content" => {
            #[derive(Deserialize)]
            struct Args {
                query: String,
                #[serde(default)]
                case_sensitive: bool,
                #[serde(default)]
                whole_word: bool,
                #[serde(default)]
                is_regex: bool,
            }
            let args: Args = parse_args(arguments)?;
            let opts = ContentSearchOptions {
                case_sensitive: args.case_sensitive,
                whole_word: args.whole_word,
                is_regex: args.is_regex,
                ..Default::default()
            };
            let hits =
                flint_core::search_content(ctx.root, &args.query, &opts).map_err(plain_error)?;
            Ok(json!(hits))
        }
        "config_get" => {
            #[derive(Deserialize)]
            struct Args {
                #[serde(default)]
                key: Option<String>,
            }
            let args: Args = parse_args(arguments)?;
            let result = config_get(ctx.root, args.key.as_deref())
                .map_err(|e| plain_error(e.to_string()))?;
            Ok(json!(result))
        }
        "note_create" => {
            #[derive(Deserialize)]
            struct Args {
                path: String,
                template: Option<String>,
            }
            let args: Args = parse_args(arguments)?;
            let safe = resolve(ctx.root, &args.path)?;
            let posix = safe.to_posix_string();
            let meta =
                create_note(ctx.root, &safe, args.template.as_deref()).map_err(map_note_error)?;
            let content = args.template.as_deref().unwrap_or("");
            crate::record_suppressed_write(
                ctx.suppressed_writes,
                &posix,
                Some(flint_core::hash_bytes(content.as_bytes())),
            );
            if let Ok(mut lock) = ctx.index.write() {
                lock.insert_or_update_note(ctx.root, &safe, content);
            }
            emit_note_event(ctx, "note:created", &posix);
            Ok(json!(meta))
        }
        "frontmatter_set" => {
            #[derive(Deserialize)]
            struct Args {
                path: String,
                fields: Vec<(String, String)>,
                fingerprint: Option<Fingerprint>,
            }
            let args: Args = parse_args(arguments)?;
            let safe = resolve(ctx.root, &args.path)?;
            let posix = safe.to_posix_string();
            let current = read_note(ctx.root, &safe).map_err(map_note_error)?;
            let new_content = set_front_matter_fields(&current.content, &args.fields);
            let fp = write_note_atomic(ctx.root, &safe, &new_content, args.fingerprint.as_ref())
                .map_err(map_note_error)?;
            crate::record_suppressed_write(
                ctx.suppressed_writes,
                &posix,
                Some(fp.content_hash.clone()),
            );
            if let Ok(mut lock) = ctx.index.write() {
                lock.insert_or_update_note(ctx.root, &safe, &new_content);
            }
            emit_note_event(ctx, "note:changed", &posix);
            Ok(json!(fp))
        }
        "note_rename" => {
            #[derive(Deserialize)]
            struct Args {
                from: String,
                to: String,
                rewrite_links: Option<bool>,
            }
            let args: Args = parse_args(arguments)?;
            let from_safe = resolve(ctx.root, &args.from)?;
            let to_safe = resolve(ctx.root, &args.to)?;
            rename_path(ctx.root, &from_safe, &to_safe).map_err(map_note_error)?;
            crate::record_suppressed_write(
                ctx.suppressed_writes,
                &from_safe.to_posix_string(),
                None,
            );
            crate::record_suppressed_write(ctx.suppressed_writes, &to_safe.to_posix_string(), None);

            let do_rewrite = args.rewrite_links.unwrap_or(true);
            let mut links_updated = 0usize;
            if do_rewrite {
                let mut moved = HashMap::new();
                moved.insert(from_safe.to_posix_string(), to_safe.to_posix_string());
                if let Ok(summary) =
                    flint_core::rewrite_workspace_links_for_rename(ctx.root, &moved)
                {
                    links_updated = summary.links_updated;
                }
            }
            if let Ok(mut lock) = ctx.index.write() {
                lock.remove_note(Some(ctx.root), &from_safe.to_posix_string());
                if to_safe.as_path().is_file() {
                    if let Ok(content) = std::fs::read_to_string(to_safe.as_path()) {
                        lock.insert_or_update_note(ctx.root, &to_safe, &content);
                    }
                }
            }
            let _ = ctx.app_handle.emit(
                "note:renamed",
                crate::NoteRenamedPayload {
                    from: from_safe.to_posix_string(),
                    to: to_safe.to_posix_string(),
                },
            );
            Ok(json!({ "moved": true, "links_updated": links_updated }))
        }
        "folder_create" => {
            #[derive(Deserialize)]
            struct Args {
                path: String,
            }
            let args: Args = parse_args(arguments)?;
            let safe = resolve(ctx.root, &args.path)?;
            create_folder(ctx.root, &safe).map_err(map_note_error)?;
            emit_note_event(ctx, "note:created", &safe.to_posix_string());
            Ok(json!({ "created": true }))
        }
        "folder_delete" => {
            #[derive(Deserialize)]
            struct Args {
                path: String,
                permanent: Option<bool>,
            }
            let args: Args = parse_args(arguments)?;
            let safe = resolve(ctx.root, &args.path)?;
            delete_folder(ctx.root, &safe, args.permanent.unwrap_or(false))
                .map_err(map_note_error)?;
            emit_note_event(ctx, "note:removed", &safe.to_posix_string());
            Ok(json!({ "deleted": true }))
        }
        "note_patch_section" => {
            #[derive(Deserialize)]
            struct Args {
                path: String,
                heading_path: Vec<String>,
                new_body: String,
                fingerprint: Option<Fingerprint>,
            }
            let args: Args = parse_args(arguments)?;
            let safe = resolve(ctx.root, &args.path)?;
            let (fp, new_content) = patch_section(
                ctx.root,
                &safe,
                &args.heading_path,
                &args.new_body,
                args.fingerprint.as_ref(),
            )
            .map_err(map_note_error)?;
            crate::record_suppressed_write(
                ctx.suppressed_writes,
                &safe.to_posix_string(),
                Some(fp.content_hash.clone()),
            );
            if let Ok(mut lock) = ctx.index.write() {
                lock.insert_or_update_note(ctx.root, &safe, &new_content);
            }
            emit_note_event(ctx, "note:changed", &safe.to_posix_string());
            Ok(json!(fp))
        }
        "note_insert_link" => {
            #[derive(Deserialize)]
            struct Args {
                path: String,
                target_path: String,
                link_text: Option<String>,
                after_line: Option<usize>,
                fingerprint: Option<Fingerprint>,
            }
            let args: Args = parse_args(arguments)?;
            let safe = resolve(ctx.root, &args.path)?;
            let location = match args.after_line {
                Some(line) => LinkLocation::AfterLine { line },
                None => LinkLocation::Related,
            };
            let (fp, new_content) = insert_link(
                ctx.root,
                &safe,
                &args.target_path,
                args.link_text.as_deref(),
                location,
                args.fingerprint.as_ref(),
            )
            .map_err(map_note_error)?;
            crate::record_suppressed_write(
                ctx.suppressed_writes,
                &safe.to_posix_string(),
                Some(fp.content_hash.clone()),
            );
            if let Ok(mut lock) = ctx.index.write() {
                lock.insert_or_update_note(ctx.root, &safe, &new_content);
            }
            emit_note_event(ctx, "note:changed", &safe.to_posix_string());
            Ok(json!(fp))
        }
        other => Err(plain_error(format!("unknown tool: {other}"))),
    }
}

fn parse_args<T: serde::de::DeserializeOwned>(value: Value) -> Result<T, ToolCallError> {
    serde_json::from_value(value).map_err(|e| plain_error(format!("invalid arguments: {e}")))
}
