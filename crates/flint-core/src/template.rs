//! Note template engine and `.flint/templates/` discovery (M10.26), built on Tera (M10.29).
//!
//! Pure logic, no Tera-host dependency: [`render_template`] renders a template body with the
//! `tera` crate (Jinja-like syntax — `{{ title | kebab }}`, `{{ date(offset="+1w") }}`,
//! `{% for %}`, `{% if var.x == "y" %}`, `{% set %}`), with autoescape off. Any syntax/render
//! error returns the body unchanged plus a warning ([`render_template_checked`]).
//! `list_templates` enumerates the plain `.md` files a workspace keeps under
//! `.flint/templates/` — a workspace-portable directory, not hidden inside `.flint.db`, so
//! templates travel with the notes. [`resolve_variables`] implements the explicit > folder >
//! global > schema-default precedence chain (M10.27 Journey C) independent of any IPC/State.

use crate::template_gen::{
    apply_transform, format_path, iso_week_label, quarter_label, shift_date, uuid_v4, weekday_name,
    Pattern,
};
use chrono::{DateTime, Datelike, Local, Timelike};
use std::collections::HashMap;
use std::path::Path;
use std::sync::Arc;

/// The subdirectory (workspace-relative) that holds template files.
pub const TEMPLATES_DIR: &str = ".flint/templates";

/// Persistent counter state behind the sequence generators (M10.27). Implemented over `.flint.db`
/// by [`crate::config::RedbSequenceStore`]; the renderer itself stays pure.
pub trait SequenceStore: Send + Sync {
    /// Atomically advance the counter-path stored under `key`: increment level `bump` (0-based)
    /// and reset deeper levels to 1 (see [`crate::template_gen::advance_path`]). Returns the new
    /// path, or `None` if the store could not be read/written.
    fn advance(&self, key: &str, levels: usize, bump: usize) -> Option<Vec<u64>>;
}

/// Read-only cross-note lookups (M10.27), implemented by the host over its index and the existing
/// title / front-matter readers. Paths are workspace-relative POSIX.
pub trait NoteLookup: Send + Sync {
    fn title(&self, path: &str) -> Option<String>;
    fn frontmatter(&self, path: &str, key: &str) -> Option<String>;
    fn workspace_name(&self) -> String;
}

/// Everything a template placeholder can reference when rendering a new note's initial content.
#[derive(Clone)]
pub struct TemplateContext {
    /// The new note's title (derived from its filename stem unless overridden by the caller).
    pub title: String,
    /// The new note's workspace-relative POSIX path.
    pub path: String,
    /// The moment the note is being created, used by `date()`/`time()` and the `now` variable.
    pub now: DateTime<Local>,
    /// Resolved `var.name` values (M10.27) — already precedence-resolved by
    /// [`resolve_variables`]; the renderer never itself consults folder/global scope.
    pub variables: HashMap<String, String>,
    /// Template path (relative to `.flint/templates/`) — the scope of `seq`/`nestseq` counters.
    pub template: Option<String>,
    /// Counter store; `None` makes `seq`/`nestseq`/`regexseq` raise a render error (→ fallback).
    pub sequences: Option<Arc<dyn SequenceStore>>,
    /// Cross-note lookups; `None` makes the lookup functions raise a render error (→ fallback).
    pub lookup: Option<Arc<dyn NoteLookup>>,
}

impl std::fmt::Debug for TemplateContext {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("TemplateContext")
            .field("title", &self.title)
            .field("path", &self.path)
            .field("now", &self.now)
            .field("variables", &self.variables)
            .field("template", &self.template)
            .finish_non_exhaustive()
    }
}

impl TemplateContext {
    pub fn new(title: impl Into<String>, path: impl Into<String>) -> Self {
        Self {
            title: title.into(),
            path: path.into(),
            now: Local::now(),
            variables: HashMap::new(),
            template: None,
            sequences: None,
            lookup: None,
        }
    }

    pub fn with_variables(mut self, variables: HashMap<String, String>) -> Self {
        self.variables = variables;
        self
    }

    pub fn with_template(mut self, template: Option<String>) -> Self {
        self.template = template;
        self
    }

    pub fn with_sequences(mut self, store: Arc<dyn SequenceStore>) -> Self {
        self.sequences = Some(store);
        self
    }

    pub fn with_lookup(mut self, lookup: Arc<dyn NoteLookup>) -> Self {
        self.lookup = Some(lookup);
        self
    }

    fn folder(&self) -> &str {
        self.path.rsplit_once('/').map(|(d, _)| d).unwrap_or("")
    }
}

/// The kind of value a declared template variable holds (M10.27). Serialized lowercase to match
/// the plan's JSON-string front-matter encoding (`"type":"text"`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TemplateVariableKind {
    Text,
    Date,
    Choice,
    Bool,
}

/// One declared template variable (M10.27): name, type, default, whether it blocks note creation
/// when left blank, and (for `Choice`) its option list. (De)serialized as a single JSON-string
/// front-matter field (`templateVariables`) via [`crate::parse_front_matter`]/
/// [`crate::set_front_matter_fields`] — deliberately not a new file format.
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TemplateVariableDef {
    pub name: String,
    pub kind: TemplateVariableKind,
    #[serde(default)]
    pub default: String,
    #[serde(default)]
    pub required: bool,
    #[serde(default)]
    pub options: Vec<String>,
}

/// The front-matter field name a template's declared variable schema is stored under.
pub const TEMPLATE_VARIABLES_FIELD: &str = "templateVariables";

/// Serialize a variable schema to the JSON string stored in the `templateVariables` front-matter
/// field. Never fails in practice (the shape is always serializable); falls back to `"[]"` rather
/// than panicking if it somehow did.
pub fn serialize_template_variables(vars: &[TemplateVariableDef]) -> String {
    serde_json::to_string(vars).unwrap_or_else(|_| "[]".to_string())
}

/// Parse a `templateVariables` front-matter raw value back into a variable schema. Lenient: a
/// missing, empty, or malformed value yields an empty schema rather than an error — a template
/// with no declared variables (or one hand-edited into a broken state) still renders and opens.
pub fn parse_template_variables(raw: &str) -> Vec<TemplateVariableDef> {
    let trimmed = raw.trim().trim_matches('"');
    if trimmed.is_empty() {
        return Vec::new();
    }
    // Front matter round-trips a quoted scalar with escaped inner quotes (`\"`) when the value
    // itself is a JSON string; unescape that one common case before parsing.
    let unescaped = trimmed.replace("\\\"", "\"");
    serde_json::from_str(&unescaped)
        .or_else(|_| serde_json::from_str(trimmed))
        .unwrap_or_default()
}

/// Resolve every declared variable's effective value against the M10.27 Journey C precedence
/// chain (highest wins): `explicit` (typed into the New Note modal) > `folder_scope` (nearest
/// ancestor folder) > `global_scope` (Settings → Templates → Variables) > the variable's own
/// schema `default` > blank. Pure and independent of any IPC/State — callers resolve
/// `folder_scope` (nearest-ancestor-wins across `.flint.db` rows) before calling this.
pub fn resolve_variables(
    template_vars: &[TemplateVariableDef],
    explicit: &HashMap<String, String>,
    folder_scope: &HashMap<String, String>,
    global_scope: &HashMap<String, String>,
) -> HashMap<String, String> {
    let mut out = HashMap::with_capacity(template_vars.len());
    for def in template_vars {
        let value = explicit
            .get(&def.name)
            .or_else(|| folder_scope.get(&def.name))
            .or_else(|| global_scope.get(&def.name))
            .cloned()
            .unwrap_or_else(|| def.default.clone());
        out.insert(def.name.clone(), value);
    }
    out
}

/// Names of every `required` variable whose resolved value (from [`resolve_variables`]) is blank
/// — used to block note creation with a visible message rather than silently proceeding (Journey
/// B: "a required-but-still-empty field blocks Create").
pub fn missing_required_variables(
    template_vars: &[TemplateVariableDef],
    resolved: &HashMap<String, String>,
) -> Vec<String> {
    template_vars
        .iter()
        .filter(|def| def.required)
        .filter(|def| {
            resolved
                .get(&def.name)
                .map(|v| v.trim().is_empty())
                .unwrap_or(true)
        })
        .map(|def| def.name.clone())
        .collect()
}

/// Metadata for one discovered template file, as returned to the note-create picker and the
/// daily-notes config dropdown.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TemplateMeta {
    /// Display name (the file stem, e.g. `daily` for `daily.md`).
    pub name: String,
    /// Path relative to `.flint/templates/`, POSIX-style — this is what `note_create`'s
    /// `template` argument and `dailyNotes.template` config both expect.
    pub path: String,
}

/// Default date format used by a bare `{{date}}` placeholder (no `:FORMAT` modifier).
const DEFAULT_DATE_TOKENS: &str = "YYYY-MM-DD";

/// Translate a subset of common date-token letters (`YYYY`, `MM`, `DD`, `HH`, `mm`, `ss`) into
/// their zero-padded values from `now`. Any character that isn't part of a recognized token
/// (including separators like `-`, `_`, `/`, or an unrecognized letter run) passes through
/// unchanged — this deliberately never panics or errors, matching `render_template`'s "unknown
/// placeholders are left verbatim" contract extended down to unknown format tokens.
fn format_date_tokens(now: &DateTime<Local>, tokens: &str) -> String {
    let chars: Vec<char> = tokens.chars().collect();
    let mut out = String::with_capacity(tokens.len());
    let mut i = 0;
    let starts_with = |i: usize, needle: &str| -> bool {
        let needle_chars: Vec<char> = needle.chars().collect();
        i + needle_chars.len() <= chars.len()
            && chars[i..i + needle_chars.len()] == needle_chars[..]
    };

    while i < chars.len() {
        if starts_with(i, "YYYY") {
            out.push_str(&format!("{:04}", now.year()));
            i += 4;
        } else if starts_with(i, "MM") {
            out.push_str(&format!("{:02}", now.month()));
            i += 2;
        } else if starts_with(i, "DD") {
            out.push_str(&format!("{:02}", now.day()));
            i += 2;
        } else if starts_with(i, "HH") {
            out.push_str(&format!("{:02}", now.hour()));
            i += 2;
        } else if starts_with(i, "mm") {
            out.push_str(&format!("{:02}", now.minute()));
            i += 2;
        } else if starts_with(i, "ss") {
            out.push_str(&format!("{:02}", now.second()));
            i += 2;
        } else {
            out.push(chars[i]);
            i += 1;
        }
    }
    out
}

/// Relative POSIX path from directory `from_dir` to file `to` (both workspace-relative).
fn relative_path(from_dir: &str, to: &str) -> String {
    let from: Vec<&str> = from_dir.split('/').filter(|s| !s.is_empty()).collect();
    let target: Vec<&str> = to.split('/').filter(|s| !s.is_empty()).collect();
    let common = from
        .iter()
        .zip(target.iter())
        .take_while(|(a, b)| a == b)
        .count()
        .min(target.len().saturating_sub(1));
    let mut parts: Vec<&str> = vec![".."; from.len() - common];
    parts.extend(&target[common..]);
    parts.join("/")
}

// ---------------------------------------------------------------------------------------------
// Tera engine (M10.29)
// ---------------------------------------------------------------------------------------------

/// The result of a checked render: the output text plus, when the template could not be rendered,
/// a human-readable reason. On failure `text` is the original body, unchanged.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RenderOutcome {
    pub text: String,
    pub warning: Option<String>,
}

type Args = HashMap<String, tera::Value>;

fn arg_str(args: &Args, name: &str) -> Option<String> {
    args.get(name).and_then(|v| v.as_str()).map(str::to_string)
}

fn req_str(args: &Args, fn_name: &str, name: &str) -> tera::Result<String> {
    arg_str(args, name)
        .ok_or_else(|| tera::Error::msg(format!("`{fn_name}` needs a string `{name}` argument")))
}

fn req_uint(args: &Args, fn_name: &str, name: &str) -> tera::Result<usize> {
    args.get(name)
        .and_then(|v| v.as_u64())
        .map(|n| n as usize)
        .ok_or_else(|| tera::Error::msg(format!("`{fn_name}` needs a numeric `{name}` argument")))
}

/// Flatten a Tera error and its causes into one line.
fn error_chain(err: &tera::Error) -> String {
    use std::error::Error;
    let mut msg = err.to_string();
    let mut src = err.source();
    while let Some(e) = src {
        msg.push_str(": ");
        msg.push_str(&e.to_string());
        src = e.source();
    }
    msg
}

/// Register a string→string filter backed by [`apply_transform`]. `arg` names the (optional)
/// keyword argument passed through as the transform's single `:` argument.
fn register_text_filter(
    tera: &mut tera::Tera,
    name: &'static str,
    transform: &'static str,
    arg: Option<&'static str>,
) {
    tera.register_filter(
        name,
        move |value: &tera::Value, args: &Args| -> tera::Result<tera::Value> {
            let text = match value {
                tera::Value::String(s) => s.clone(),
                tera::Value::Null => String::new(),
                other => other.to_string(),
            };
            let arg_text = match arg {
                Some(a) => match args.get(a) {
                    Some(tera::Value::String(s)) => Some(s.clone()),
                    Some(v) if !v.is_null() => Some(v.to_string()),
                    _ => return Err(tera::Error::msg(format!("filter `{name}` needs `{a}=`"))),
                },
                None => None,
            };
            let argv: Vec<&str> = arg_text.iter().map(String::as_str).collect();
            Ok(tera::Value::String(apply_transform(
                transform, &argv, &text,
            )))
        },
    );
}

fn build_tera(ctx: &TemplateContext) -> tera::Tera {
    let mut tera = tera::Tera::default();
    tera.autoescape_on(vec![]);

    // Filters. `upper`/`lower`/`trim`/`replace`/`default` stay Tera's built-ins; the rest reuse
    // `template_gen::apply_transform` so behaviour matches the M10.27 helper table.
    for (name, transform) in [
        ("slugify", "slug"),
        ("kebab", "kebab"),
        ("snake", "snake"),
        ("titlecase", "titlecase"),
        ("capitalize", "capitalize"),
        ("initials", "initials"),
        ("wordcount", "wordcount"),
        ("charcount", "charcount"),
    ] {
        register_text_filter(&mut tera, name, transform, None);
    }
    register_text_filter(&mut tera, "pad", "pad", Some("width"));
    // Overrides Tera's built-in `truncate`, which appends an ellipsis.
    register_text_filter(&mut tera, "truncate", "truncate", Some("length"));

    // Date functions.
    let now = ctx.now;
    let shifted = move |args: &Args| -> tera::Result<DateTime<Local>> {
        match arg_str(args, "offset") {
            Some(o) if !o.is_empty() => shift_date(now, &o)
                .ok_or_else(|| tera::Error::msg(format!("unusable date offset `{o}`"))),
            _ => Ok(now),
        }
    };
    tera.register_function("date", move |args: &Args| {
        let fmt = arg_str(args, "fmt").unwrap_or_else(|| DEFAULT_DATE_TOKENS.to_string());
        Ok(format_date_tokens(&shifted(args)?, &fmt).into())
    });
    tera.register_function("time", move |args: &Args| {
        let fmt = arg_str(args, "fmt").unwrap_or_else(|| "HH:mm".to_string());
        Ok(format_date_tokens(&now, &fmt).into())
    });
    tera.register_function("weekday", move |args: &Args| {
        Ok(weekday_name(&shifted(args)?).into())
    });
    tera.register_function("quarter", move |args: &Args| {
        Ok(quarter_label(&shifted(args)?).into())
    });
    tera.register_function("isoweek", move |args: &Args| {
        Ok(iso_week_label(&shifted(args)?).into())
    });
    tera.register_function("uuid", |_: &Args| Ok(uuid_v4().into()));
    tera.register_function("regex", |args: &Args| {
        let pattern = req_str(args, "regex", "pattern")?;
        Pattern::parse(&pattern)
            .map(|p| p.generate().into())
            .ok_or_else(|| tera::Error::msg(format!("unsupported regex pattern `{pattern}`")))
    });

    // Path / lookup functions.
    let folder = ctx.folder().to_string();
    let parent = folder.rsplit('/').next().unwrap_or("").to_string();
    tera.register_function("parentfolder", move |_: &Args| Ok(parent.clone().into()));
    let lookup = ctx.lookup.clone();
    tera.register_function("workspacename", {
        let lookup = lookup.clone();
        move |_: &Args| match &lookup {
            Some(l) => Ok(l.workspace_name().into()),
            None => Err(tera::Error::msg("`workspacename` needs a workspace")),
        }
    });
    tera.register_function("relativepath", {
        let folder = folder.clone();
        move |args: &Args| {
            let to = req_str(args, "relativepath", "to")?;
            Ok(relative_path(&folder, to.trim()).into())
        }
    });
    tera.register_function("linkto", {
        let (lookup, folder) = (lookup.clone(), folder.clone());
        move |args: &Args| {
            let target = req_str(args, "linkto", "path")?;
            let target = target.trim();
            let l = lookup
                .as_ref()
                .ok_or_else(|| tera::Error::msg("`linkto` needs a workspace"))?;
            let title = l
                .title(target)
                .ok_or_else(|| tera::Error::msg(format!("no note at `{target}`")))?;
            Ok(format!("[{title}]({})", relative_path(&folder, target)).into())
        }
    });
    tera.register_function("frontmatter", {
        let lookup = lookup.clone();
        move |args: &Args| {
            let path = req_str(args, "frontmatter", "path")?;
            let key = req_str(args, "frontmatter", "key")?;
            let l = lookup
                .as_ref()
                .ok_or_else(|| tera::Error::msg("`frontmatter` needs a workspace"))?;
            l.frontmatter(path.trim(), key.trim())
                .map(Into::into)
                .ok_or_else(|| tera::Error::msg(format!("no `{key}` field in `{path}`")))
        }
    });

    // Stateful sequence functions. Each validates its arguments *before* touching the store, so a
    // rejected call never consumes a number.
    let scope = ctx.template.clone().unwrap_or_default();
    let store = ctx.sequences.clone();
    let no_store = || tera::Error::msg("sequences are unavailable here (no counter store)");
    tera.register_function("seq", {
        let (store, scope, folder) = (store.clone(), scope.clone(), folder.clone());
        move |args: &Args| {
            let prefix = req_str(args, "seq", "prefix")?;
            let width = args.get("width").and_then(|v| v.as_u64()).unwrap_or(0) as usize;
            let folder_scoped = args
                .get("folder")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            let key = if folder_scoped {
                format!("seq:{scope}@{folder}:{prefix}")
            } else {
                format!("seq:{scope}:{prefix}")
            };
            let store = store.as_ref().ok_or_else(no_store)?;
            let n = store
                .advance(&key, 1, 0)
                .and_then(|p| p.first().copied())
                .ok_or_else(|| tera::Error::msg("could not advance the counter"))?;
            Ok(format!("{prefix}{n:0width$}").into())
        }
    });
    tera.register_function("nestseq", {
        let (store, scope) = (store.clone(), scope.clone());
        move |args: &Args| {
            let levels = req_uint(args, "nestseq", "levels")?;
            if !(1..=8).contains(&levels) {
                return Err(tera::Error::msg("`nestseq` levels must be 1–8"));
            }
            // `bump` is the 1-based level to increment (default: the last).
            let bump = match args.get("bump") {
                Some(_) => req_uint(args, "nestseq", "bump")?
                    .checked_sub(1)
                    .ok_or_else(|| tera::Error::msg("`nestseq` bump is 1-based"))?,
                None => levels - 1,
            };
            if bump >= levels {
                return Err(tera::Error::msg("`nestseq` bump exceeds levels"));
            }
            let store = store.as_ref().ok_or_else(no_store)?;
            let path = store
                .advance(&format!("nestseq:{scope}:{levels}"), levels, bump)
                .ok_or_else(|| tera::Error::msg("could not advance the counter"))?;
            Ok(format_path(&path).into())
        }
    });
    tera.register_function("regexseq", {
        let (store, scope) = (store, scope);
        move |args: &Args| {
            let pattern = req_str(args, "regexseq", "pattern")?;
            let parsed = Pattern::parse(&pattern).ok_or_else(|| {
                tera::Error::msg(format!("unsupported regex pattern `{pattern}`"))
            })?;
            let store = store.as_ref().ok_or_else(no_store)?;
            let n = store
                .advance(&format!("regexseq:{scope}:{pattern}"), 1, 0)
                .and_then(|p| p.first().copied())
                .ok_or_else(|| tera::Error::msg("could not advance the counter"))?;
            parsed
                .sequence(n)
                .map(Into::into)
                .ok_or_else(|| tera::Error::msg("regexseq counter overflowed its pattern"))
        }
    });

    tera
}

fn build_context(ctx: &TemplateContext) -> tera::Context {
    let mut c = tera::Context::new();
    c.insert("title", &ctx.title);
    c.insert("path", &ctx.path);
    c.insert("folder", ctx.folder());
    c.insert("var", &ctx.variables);
    c.insert(
        "now",
        &serde_json::json!({
            "year": ctx.now.year(),
            "month": ctx.now.month(),
            "day": ctx.now.day(),
            "hour": ctx.now.hour(),
            "minute": ctx.now.minute(),
            "second": ctx.now.second(),
            "date": format_date_tokens(&ctx.now, DEFAULT_DATE_TOKENS),
        }),
    );
    c
}

/// Render `body` against `ctx` with Tera (Jinja-like: `{{ expr }}`, `{% for %}`, `{% if %}`,
/// `{% set %}`, `{# comments #}`, filters via `|`). Autoescape is off (Markdown, not HTML). On any
/// syntax or render error the original body is returned unchanged with a warning — a typo never
/// blocks note creation or drops content, and never panics.
pub fn render_template_checked(body: &str, ctx: &TemplateContext) -> RenderOutcome {
    let mut tera = build_tera(ctx);
    match tera.render_str(body, &build_context(ctx)) {
        Ok(text) => RenderOutcome {
            text,
            warning: None,
        },
        Err(e) => RenderOutcome {
            text: body.to_string(),
            warning: Some(error_chain(&e)),
        },
    }
}

/// [`render_template_checked`] without the warning, for callers with nowhere to show one.
pub fn render_template(body: &str, ctx: &TemplateContext) -> String {
    render_template_checked(body, ctx).text
}

/// Enumerate every `.md`/`.markdown` file under `<workspace-root>/.flint/templates/`, recursively,
/// sorted by display name. Returns an empty list (never an error) when the directory doesn't exist
/// yet — a fresh or template-less workspace is a normal, designed-for empty state, not a failure.
pub fn list_templates(root: &Path) -> Vec<TemplateMeta> {
    let base = root.join(TEMPLATES_DIR);
    if !base.is_dir() {
        return Vec::new();
    }

    let mut out = Vec::new();
    collect_templates(&base, &base, &mut out);
    out.sort_by_key(|a| a.name.to_lowercase());
    out
}

fn collect_templates(base: &Path, dir: &Path, out: &mut Vec<TemplateMeta>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            collect_templates(base, &path, out);
            continue;
        }
        if !crate::is_note_path(&path) {
            continue;
        }
        let Ok(rel) = path.strip_prefix(base) else {
            continue;
        };
        let rel_posix = crate::to_posix_path(rel);
        let name = path
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or(&rel_posix)
            .to_string();
        out.push(TemplateMeta {
            name,
            path: rel_posix,
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;
    use tempfile::tempdir;

    fn ctx_at(y: i32, mo: u32, d: u32, h: u32, mi: u32, s: u32) -> TemplateContext {
        TemplateContext {
            title: "My Title".to_string(),
            path: "folder/note.md".to_string(),
            now: Local.with_ymd_and_hms(y, mo, d, h, mi, s).unwrap(),
            ..TemplateContext::new("", "")
        }
    }

    fn def(
        name: &str,
        kind: TemplateVariableKind,
        default: &str,
        required: bool,
    ) -> TemplateVariableDef {
        TemplateVariableDef {
            name: name.to_string(),
            kind,
            default: default.to_string(),
            required,
            options: Vec::new(),
        }
    }

    #[test]
    fn empty_template_renders_empty() {
        assert_eq!(render_template("", &ctx_at(2026, 9, 28, 8, 5, 0)), "");
    }

    #[test]
    fn template_with_no_placeholders_is_unchanged() {
        let body = "# Just a heading\n\nSome body text.\n";
        assert_eq!(render_template(body, &ctx_at(2026, 9, 28, 8, 5, 0)), body);
    }

    #[test]
    fn title_and_path_substitute() {
        let out = render_template(
            "# {{ title }}\n\nSaved at {{ path }}\n",
            &ctx_at(2026, 9, 28, 8, 5, 0),
        );
        assert_eq!(out, "# My Title\n\nSaved at folder/note.md\n");
    }

    #[test]
    fn repeated_placeholder_substitutes_every_occurrence() {
        let out = render_template("{{ title }} / {{ title }}", &ctx_at(2026, 9, 28, 8, 5, 0));
        assert_eq!(out, "My Title / My Title");
    }

    #[test]
    fn bare_date_uses_default_format() {
        let out = render_template("{{ date() }}", &ctx_at(2026, 1, 5, 8, 5, 0));
        assert_eq!(out, "2026-01-05");
    }

    #[test]
    fn custom_date_format_applies() {
        let out = render_template(
            "{{ date(fmt=\"DD/MM/YYYY\") }}",
            &ctx_at(2026, 1, 5, 8, 5, 0),
        );
        assert_eq!(out, "05/01/2026");
    }

    #[test]
    fn time_placeholder_renders_zero_padded() {
        let out = render_template("{{ time() }}", &ctx_at(2026, 1, 5, 8, 5, 9));
        assert_eq!(out, "08:05");
    }

    #[test]
    fn unknown_variable_falls_back_with_warning() {
        let out = render_template_checked("{{ nope }}", &ctx_at(2026, 9, 28, 8, 5, 0));
        assert_eq!(out.text, "{{ nope }}");
        assert!(out.warning.is_some());
    }

    #[test]
    fn malformed_template_falls_back_with_warning() {
        let body = "{{ }} {{ date";
        let out = render_template_checked(body, &ctx_at(2026, 9, 28, 8, 5, 0));
        assert_eq!(out.text, body);
        assert!(out.warning.is_some());
    }

    #[test]
    fn unrecognized_date_token_passes_through() {
        let out = render_template(r#"{{ date(fmt="QQQQ") }}"#, &ctx_at(2026, 9, 28, 8, 5, 0));
        assert_eq!(out, "QQQQ");
    }

    #[test]
    fn list_templates_empty_dir_returns_empty() {
        let dir = tempdir().unwrap();
        assert_eq!(list_templates(dir.path()), Vec::new());
    }

    #[test]
    fn slug_pipe_transforms_title() {
        let mut ctx = ctx_at(2026, 9, 28, 8, 5, 0);
        ctx.title = "My Cool Title!".to_string();
        assert_eq!(
            render_template("{{ title | slugify }}", &ctx),
            "my-cool-title"
        );
    }

    #[test]
    fn upper_and_lower_pipes() {
        let ctx = ctx_at(2026, 9, 28, 8, 5, 0);
        assert_eq!(render_template("{{ title | upper }}", &ctx), "MY TITLE");
        assert_eq!(render_template("{{ title | lower }}", &ctx), "my title");
    }

    #[test]
    fn chained_pipes_apply_in_order() {
        let mut ctx = ctx_at(2026, 9, 28, 8, 5, 0);
        ctx.title = "  Hello World  ".to_string();
        assert_eq!(
            render_template("{{ title | trim | slugify }}", &ctx),
            "hello-world"
        );
    }

    #[test]
    fn date_offset_adds_days() {
        let ctx = ctx_at(2026, 1, 5, 8, 5, 0);
        assert_eq!(
            render_template("{{ date(offset=\"+7\") }}", &ctx),
            "2026-01-12"
        );
        assert_eq!(
            render_template("{{ date(offset=\"-5\") }}", &ctx),
            "2025-12-31"
        );
    }

    #[test]
    fn var_placeholder_substitutes_from_context() {
        let mut ctx = ctx_at(2026, 9, 28, 8, 5, 0);
        ctx.variables
            .insert("project".to_string(), "Flint".to_string());
        assert_eq!(render_template("{{ var.project }}", &ctx), "Flint");
    }

    #[test]
    fn var_missing_from_context_falls_back() {
        let ctx = ctx_at(2026, 9, 28, 8, 5, 0);
        let out = render_template_checked("{{ var.unknown }}", &ctx);
        assert_eq!(out.text, "{{ var.unknown }}");
        assert!(out.warning.is_some());
        assert_eq!(
            render_template(r#"{{ var.unknown | default(value="none") }}"#, &ctx),
            "none"
        );
    }

    #[test]
    fn var_placeholder_with_pipe() {
        let mut ctx = ctx_at(2026, 9, 28, 8, 5, 0);
        ctx.variables
            .insert("project".to_string(), "Acme Corp".to_string());
        assert_eq!(
            render_template("{{ var.project | slugify }}", &ctx),
            "acme-corp"
        );
    }

    #[test]
    fn template_variables_round_trip_through_json_string() {
        let vars = vec![
            def("project", TemplateVariableKind::Text, "", true),
            def("priority", TemplateVariableKind::Choice, "Low", false),
        ];
        let raw = serialize_template_variables(&vars);
        let parsed = parse_template_variables(&raw);
        assert_eq!(parsed, vars);
    }

    #[test]
    fn parse_template_variables_malformed_yields_empty() {
        assert_eq!(parse_template_variables("not json"), Vec::new());
        assert_eq!(parse_template_variables(""), Vec::new());
    }

    #[test]
    fn resolve_variables_precedence_explicit_wins() {
        let vars = vec![def(
            "author",
            TemplateVariableKind::Text,
            "schema-default",
            false,
        )];
        let explicit = HashMap::from([("author".to_string(), "explicit-val".to_string())]);
        let folder = HashMap::from([("author".to_string(), "folder-val".to_string())]);
        let global = HashMap::from([("author".to_string(), "global-val".to_string())]);
        let out = resolve_variables(&vars, &explicit, &folder, &global);
        assert_eq!(out.get("author").unwrap(), "explicit-val");
    }

    #[test]
    fn resolve_variables_precedence_folder_over_global() {
        let vars = vec![def(
            "author",
            TemplateVariableKind::Text,
            "schema-default",
            false,
        )];
        let explicit = HashMap::new();
        let folder = HashMap::from([("author".to_string(), "folder-val".to_string())]);
        let global = HashMap::from([("author".to_string(), "global-val".to_string())]);
        let out = resolve_variables(&vars, &explicit, &folder, &global);
        assert_eq!(out.get("author").unwrap(), "folder-val");
    }

    #[test]
    fn resolve_variables_precedence_global_over_default() {
        let vars = vec![def(
            "author",
            TemplateVariableKind::Text,
            "schema-default",
            false,
        )];
        let explicit = HashMap::new();
        let folder = HashMap::new();
        let global = HashMap::from([("author".to_string(), "global-val".to_string())]);
        let out = resolve_variables(&vars, &explicit, &folder, &global);
        assert_eq!(out.get("author").unwrap(), "global-val");
    }

    #[test]
    fn resolve_variables_falls_back_to_schema_default() {
        let vars = vec![def(
            "author",
            TemplateVariableKind::Text,
            "schema-default",
            false,
        )];
        let out = resolve_variables(&vars, &HashMap::new(), &HashMap::new(), &HashMap::new());
        assert_eq!(out.get("author").unwrap(), "schema-default");
    }

    #[test]
    fn missing_required_variables_reports_blank_required_fields() {
        let vars = vec![
            def("project", TemplateVariableKind::Text, "", true),
            def("optional", TemplateVariableKind::Text, "", false),
        ];
        let resolved = resolve_variables(&vars, &HashMap::new(), &HashMap::new(), &HashMap::new());
        let missing = missing_required_variables(&vars, &resolved);
        assert_eq!(missing, vec!["project".to_string()]);
    }

    #[test]
    fn missing_required_variables_empty_when_all_filled() {
        let vars = vec![def("project", TemplateVariableKind::Text, "", true)];
        let explicit = HashMap::from([("project".to_string(), "Flint".to_string())]);
        let resolved = resolve_variables(&vars, &explicit, &HashMap::new(), &HashMap::new());
        assert!(missing_required_variables(&vars, &resolved).is_empty());
    }

    #[test]
    fn list_templates_finds_nested_md_files_sorted() {
        let dir = tempdir().unwrap();
        let templates = dir.path().join(".flint/templates");
        std::fs::create_dir_all(templates.join("sub")).unwrap();
        std::fs::write(templates.join("zeta.md"), "# {{ title }}").unwrap();
        std::fs::write(templates.join("sub/alpha.md"), "# {{ title }}").unwrap();
        std::fs::write(templates.join("ignore.txt"), "nope").unwrap();

        let found = list_templates(dir.path());
        assert_eq!(found.len(), 2);
        assert_eq!(found[0].name, "alpha");
        assert_eq!(found[0].path, "sub/alpha.md");
        assert_eq!(found[1].name, "zeta");
        assert_eq!(found[1].path, "zeta.md");
    }

    struct FakeLookup;
    impl NoteLookup for FakeLookup {
        fn title(&self, path: &str) -> Option<String> {
            (path == "notes/a.md").then(|| "Alpha".to_string())
        }
        fn frontmatter(&self, path: &str, key: &str) -> Option<String> {
            (path == "notes/a.md" && key == "status").then(|| "draft".to_string())
        }
        fn workspace_name(&self) -> String {
            "ws".to_string()
        }
    }

    fn seq_ctx(dir: &Path) -> TemplateContext {
        ctx_at(2026, 9, 28, 8, 5, 0)
            .with_template(Some("proj.md".to_string()))
            .with_sequences(Arc::new(crate::config::RedbSequenceStore::new(dir)))
            .with_lookup(Arc::new(FakeLookup))
    }

    #[test]
    fn new_pipes_via_render() {
        let ctx = ctx_at(2026, 9, 28, 8, 5, 0);
        assert_eq!(
            render_template("{{ title | truncate(length=2) }}", &ctx),
            "My"
        );
        assert_eq!(
            render_template("{{ title | replace(from=\"My\", to=\"Your\") }}", &ctx),
            "Your Title"
        );
        assert_eq!(
            render_template("{{ title | kebab | upper }}", &ctx),
            "MY-TITLE"
        );
        assert_eq!(
            render_template(r#"{{ var.x | default(value="none") }}"#, &ctx),
            "none"
        );
    }

    #[test]
    fn date_units_and_calendar() {
        let ctx = ctx_at(2026, 1, 31, 8, 5, 0);
        assert_eq!(
            render_template("{{ date(offset=\"+2w\") }}", &ctx),
            "2026-02-14"
        );
        assert_eq!(
            render_template("{{ date(offset=\"-1mo\") }}", &ctx),
            "2025-12-31"
        );
        assert_eq!(
            render_template("{{ weekday() }} {{ quarter() }} {{ isoweek() }}", &ctx),
            "Saturday Q1 W05"
        );
        let bad = render_template_checked(r#"{{ date(offset="+1zz") }}"#, &ctx);
        assert_eq!(bad.text, r#"{{ date(offset="+1zz") }}"#);
        assert!(bad.warning.is_some());
    }

    #[test]
    fn seq_persists_across_restart_and_notes() {
        let dir = tempdir().unwrap();
        let body = r#"{{ seq(prefix="T", width=4) }}"#;
        assert_eq!(render_template(body, &seq_ctx(dir.path())), "T0001");
        assert_eq!(render_template(body, &seq_ctx(dir.path())), "T0002");
        // "Restart": brand-new store/context over the same .flint.db.
        assert_eq!(render_template(body, &seq_ctx(dir.path())), "T0003");
        // Different template scope is independent.
        let other = seq_ctx(dir.path()).with_template(Some("other.md".into()));
        assert_eq!(render_template(body, &other), "T0001");
    }

    #[test]
    fn seq_folder_scope_is_separate() {
        let dir = tempdir().unwrap();
        let mut a = seq_ctx(dir.path());
        a.path = "one/x.md".into();
        let mut b = seq_ctx(dir.path());
        b.path = "two/x.md".into();
        assert_eq!(
            render_template(r#"{{ seq(prefix="F", width=2, folder=true) }}"#, &a),
            "F01"
        );
        assert_eq!(
            render_template(r#"{{ seq(prefix="F", width=2, folder=true) }}"#, &a),
            "F02"
        );
        assert_eq!(
            render_template(r#"{{ seq(prefix="F", width=2, folder=true) }}"#, &b),
            "F01"
        );
    }

    #[test]
    fn nestseq_resets_children_and_survives_restart() {
        let dir = tempdir().unwrap();
        let r = |b: &str| render_template(b, &seq_ctx(dir.path()));
        assert_eq!(r("T{{ nestseq(levels=3) }}"), "T01.01.01");
        assert_eq!(r("T{{ nestseq(levels=3) }}"), "T01.01.02");
        assert_eq!(r("{{ nestseq(levels=3, bump=2) }}"), "01.02.01");
        assert_eq!(r("{{ nestseq(levels=3) }}"), "01.02.02");
        assert_eq!(r("{{ nestseq(levels=3, bump=1) }}"), "02.01.01");
        assert_eq!(r("{{ nestseq(levels=9) }}"), "{{ nestseq(levels=9) }}");
    }

    #[test]
    fn regexseq_increments_and_regex_matches() {
        let dir = tempdir().unwrap();
        let r = |b: &str| render_template(b, &seq_ctx(dir.path()));
        assert_eq!(r(r#"{{ regexseq(pattern="REQ-\d{3}") }}"#), "REQ-001");
        assert_eq!(r(r#"{{ regexseq(pattern="REQ-\d{3}") }}"#), "REQ-002");
        let out = r(r#"{{ regex(pattern="[A-Z]{2}-\d{3}") }}"#);
        assert!(
            regex::Regex::new(r"^[A-Z]{2}-\d{3}$")
                .unwrap()
                .is_match(&out),
            "{out}"
        );
        assert_eq!(
            r(r#"{{ regex(pattern="a+") }}"#),
            r#"{{ regex(pattern="a+") }}"#
        );
    }

    #[test]
    fn sequences_without_store_fall_back() {
        let ctx = ctx_at(2026, 9, 28, 8, 5, 0);
        let body = r#"{{ seq(prefix="T", width=4) }}"#;
        let out = render_template_checked(body, &ctx);
        assert_eq!(out.text, body);
        assert!(out.warning.is_some());
        assert_eq!(
            render_template("{{ nestseq(levels=3) }}", &ctx),
            "{{ nestseq(levels=3) }}"
        );
    }

    #[test]
    fn lookups() {
        let dir = tempdir().unwrap();
        let mut ctx = seq_ctx(dir.path());
        ctx.path = "projects/x/new.md".into();
        assert_eq!(render_template("{{ parentfolder() }}", &ctx), "x");
        assert_eq!(render_template("{{ workspacename() }}", &ctx), "ws");
        assert_eq!(
            render_template(r#"{{ relativepath(to="notes/a.md") }}"#, &ctx),
            "../../notes/a.md"
        );
        assert_eq!(
            render_template(r#"{{ linkto(path="notes/a.md") }}"#, &ctx),
            "[Alpha](../../notes/a.md)"
        );
        assert_eq!(
            render_template(r#"{{ linkto(path="nope.md") }}"#, &ctx),
            r#"{{ linkto(path="nope.md") }}"#
        );
        assert_eq!(
            render_template(
                r#"{{ frontmatter(path="notes/a.md", key="status") }}"#,
                &ctx
            ),
            "draft"
        );
        assert_eq!(render_template("{{ uuid() }}", &ctx).len(), 36);
        let bare = ctx_at(2026, 9, 28, 8, 5, 0);
        assert_eq!(
            render_template("{{ workspacename() }}", &bare),
            "{{ workspacename() }}"
        );
    }

    #[test]
    fn for_loop_with_seq_is_monotonic() {
        let dir = tempdir().unwrap();
        let body = r#"{% for i in range(end=3) %}{{ seq(prefix="T", width=3) }} {% endfor %}"#;
        assert_eq!(
            render_template(body, &seq_ctx(dir.path())),
            "T001 T002 T003 "
        );
        assert_eq!(
            render_template(body, &seq_ctx(dir.path())),
            "T004 T005 T006 "
        );
    }

    #[test]
    fn if_on_declared_variable_and_set_and_comment() {
        let mut ctx = ctx_at(2026, 9, 28, 8, 5, 0);
        ctx.variables.insert("priority".into(), "High".into());
        let body = r#"{# hidden #}{% set who = "me" %}{% if var.priority == "High" %}urgent {{ who }}{% else %}later{% endif %}"#;
        assert_eq!(render_template(body, &ctx), "urgent me");
        ctx.variables.insert("priority".into(), "Low".into());
        assert_eq!(render_template(body, &ctx), "later");
    }

    #[test]
    fn autoescape_is_off() {
        let mut ctx = ctx_at(2026, 9, 28, 8, 5, 0);
        ctx.title = "a < b & c".into();
        assert_eq!(render_template("{{ title }}", &ctx), "a < b & c");
    }

    #[test]
    fn unknown_filter_and_function_fall_back() {
        let ctx = ctx_at(2026, 9, 28, 8, 5, 0);
        for body in ["{{ title | nofilter }}", "{{ nofunc() }}", "{% for %}"] {
            let out = render_template_checked(body, &ctx);
            assert_eq!(out.text, body);
            assert!(out.warning.is_some(), "{body}");
        }
    }

    #[test]
    fn failed_render_does_not_consume_counter() {
        let dir = tempdir().unwrap();
        // The bad call comes after a good `seq`: the whole render falls back, but a later clean
        // render must still see the counter only where a render succeeded far enough to advance.
        let bad = render_template_checked(r#"{{ nestseq(levels=9) }}"#, &seq_ctx(dir.path()));
        assert!(bad.warning.is_some());
        assert_eq!(
            render_template("{{ nestseq(levels=3) }}", &seq_ctx(dir.path())),
            "01.01.01"
        );
    }

    #[test]
    fn path_pattern_seq_without_store_keeps_raw_pattern() {
        let dir = tempdir().unwrap();
        // Path-pattern renders attach no store, so the counter must not move.
        let path_ctx = ctx_at(2026, 9, 28, 8, 5, 0).with_template(Some("proj.md".into()));
        let pat = r#"daily/{{ seq(prefix="T") }}.md"#;
        let out = render_template_checked(pat, &path_ctx);
        assert_eq!(out.text, pat);
        assert!(out.warning.is_some());
        assert_eq!(
            render_template(r#"{{ seq(prefix="T") }}"#, &seq_ctx(dir.path())),
            "T1"
        );
    }

    #[test]
    fn nestseq_survives_restart_via_tera() {
        let dir = tempdir().unwrap();
        assert_eq!(
            render_template("{{ nestseq(levels=2) }}", &seq_ctx(dir.path())),
            "01.01"
        );
        assert_eq!(
            render_template("{{ nestseq(levels=2) }}", &seq_ctx(dir.path())),
            "01.02"
        );
    }

    #[test]
    fn filters_pad_wordcount_initials() {
        let ctx = ctx_at(2026, 9, 28, 8, 5, 0);
        assert_eq!(render_template("{{ 7 | pad(width=3) }}", &ctx), "007");
        assert_eq!(render_template("{{ title | wordcount }}", &ctx), "2");
        assert_eq!(render_template("{{ title | initials }}", &ctx), "MT");
        assert_eq!(render_template("{{ title | snake }}", &ctx), "my_title");
    }
}
