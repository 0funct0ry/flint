//! Note template engine and `.flint/templates/` discovery (M10.26), extended with user variables
//! and pipe transforms (M10.27).
//!
//! Pure logic, no Tauri dependency: `render_template` substitutes `{{date}}`, `{{date:FORMAT}}`,
//! `{{date+N:FORMAT}}` (date-math), `{{time}}`, `{{title}}`, `{{path}}`, and `{{var:name}}`
//! (user-declared template variable) placeholders in a template body, each optionally piped
//! through a small fixed helper table (`{{title|slug}}`, chainable: `{{title|slug|upper}}`).
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
    /// The moment the note is being created, used for `{{date}}`/`{{date:FORMAT}}`/`{{time}}`.
    pub now: DateTime<Local>,
    /// Resolved `{{var:name}}` values (M10.27) — already precedence-resolved by
    /// [`resolve_variables`]; the renderer never itself consults folder/global scope.
    pub variables: HashMap<String, String>,
    /// Template path (relative to `.flint/templates/`) — the scope of `seq`/`nestseq` counters.
    pub template: Option<String>,
    /// Counter store; `None` leaves `seq`/`nestseq`/`regexseq` placeholders verbatim.
    pub sequences: Option<Arc<dyn SequenceStore>>,
    /// Cross-note lookups; `None` leaves the lookup placeholders verbatim.
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

fn eval_placeholder(
    name: &str,
    offset: Option<&str>,
    modifier: Option<&str>,
    ctx: &TemplateContext,
) -> Option<String> {
    let dated = |ctx: &TemplateContext| -> Option<DateTime<Local>> {
        match offset {
            Some(o) => shift_date(ctx.now, o),
            None => Some(ctx.now),
        }
    };
    // Only the date-family names accept an offset.
    if offset.is_some() && !matches!(name, "date" | "weekday" | "quarter" | "isoweek") {
        return None;
    }
    let scope = ctx.template.as_deref().unwrap_or("");
    match name {
        "date" => Some(format_date_tokens(
            &dated(ctx)?,
            modifier.unwrap_or(DEFAULT_DATE_TOKENS),
        )),
        "time" => Some(format_date_tokens(&ctx.now, "HH:mm")),
        "weekday" => Some(weekday_name(&dated(ctx)?).to_string()),
        "quarter" => Some(quarter_label(&dated(ctx)?)),
        "isoweek" => Some(iso_week_label(&dated(ctx)?)),
        "title" => Some(ctx.title.clone()),
        "path" => Some(ctx.path.clone()),
        "var" => modifier.and_then(|v| ctx.variables.get(v).cloned()),
        "uuid" => Some(uuid_v4()),
        "parentfolder" => Some(ctx.folder().rsplit('/').next().unwrap_or("").to_string()),
        "workspacename" => Some(ctx.lookup.as_ref()?.workspace_name()),
        "relativepath" => Some(relative_path(ctx.folder(), modifier?.trim())),
        "linkto" => {
            let target = modifier?.trim();
            let title = ctx.lookup.as_ref()?.title(target)?;
            Some(format!(
                "[{title}]({})",
                relative_path(ctx.folder(), target)
            ))
        }
        "frontmatter" => {
            let (target, key) = modifier?.split_once('#')?;
            ctx.lookup.as_ref()?.frontmatter(target.trim(), key.trim())
        }
        "regex" => Some(Pattern::parse(modifier?)?.generate()),
        "regexseq" => {
            let pattern = modifier?;
            let parsed = Pattern::parse(pattern)?;
            let store = ctx.sequences.as_ref()?;
            let path = store.advance(&format!("regexseq:{scope}:{pattern}"), 1, 0)?;
            parsed.sequence(*path.first()?)
        }
        // `{{seq:PREFIX[:WIDTH[:folder]]}}`
        "seq" => {
            let mut parts = modifier?.split(':');
            let prefix = parts.next()?;
            let width: usize = match parts.next() {
                Some(w) if !w.is_empty() => w.parse().ok()?,
                _ => 0,
            };
            let folder_scoped = match parts.next() {
                None => false,
                Some("folder") => true,
                Some(_) => return None,
            };
            let key = if folder_scoped {
                format!("seq:{scope}@{}:{prefix}", ctx.folder())
            } else {
                format!("seq:{scope}:{prefix}")
            };
            let n = *ctx.sequences.as_ref()?.advance(&key, 1, 0)?.first()?;
            Some(format!("{prefix}{n:0width$}"))
        }
        // `{{nestseq:LEVELS[:BUMP]}}` — BUMP is the 1-based level to increment (default: last).
        "nestseq" => {
            let mut parts = modifier?.split(':');
            let levels: usize = parts.next()?.trim().parse().ok()?;
            if !(1..=8).contains(&levels) {
                return None;
            }
            let bump: usize = match parts.next() {
                Some(b) => b.trim().parse::<usize>().ok()?.checked_sub(1)?,
                None => levels - 1,
            };
            if bump >= levels {
                return None;
            }
            let path = ctx.sequences.as_ref()?.advance(
                &format!("nestseq:{scope}:{levels}"),
                levels,
                bump,
            )?;
            Some(format_path(&path))
        }
        _ => None,
    }
}

/// Evaluate one `{{...}}` body (without the braces); `None` means "leave verbatim".
fn eval_span(inner: &str, ctx: &TemplateContext) -> Option<String> {
    let mut segments = inner.split('|');
    let head = segments.next()?.trim();
    let name_end = head
        .find(|c: char| !c.is_ascii_alphabetic())
        .unwrap_or(head.len());
    let name = &head[..name_end];
    if name.is_empty() {
        return None;
    }
    let mut rest = &head[name_end..];
    let mut offset = None;
    if rest.starts_with(['+', '-']) {
        let end = rest[1..]
            .find(|c: char| !c.is_ascii_alphanumeric())
            .map(|i| i + 1)
            .unwrap_or(rest.len());
        offset = Some(&rest[..end]);
        rest = &rest[end..];
    }
    let modifier = match rest {
        "" => None,
        r if r.starts_with(':') => Some(&r[1..]),
        _ => return None,
    };
    let mut value = eval_placeholder(name, offset, modifier, ctx)?;
    for seg in segments {
        let mut args = seg.split(':');
        let fn_name = args.next().unwrap_or("").trim();
        if fn_name.is_empty() || !fn_name.chars().all(|c| c.is_ascii_alphabetic()) {
            return None;
        }
        let args: Vec<&str> = args.collect();
        value = apply_transform(fn_name, &args, &value);
    }
    Some(value)
}

/// Render placeholders in `body` against `ctx`: `{{date}}`, `{{date:FORMAT}}`,
/// `{{date+N[d|w|mo|y]:FORMAT}}`, `{{time}}`, `{{weekday}}`, `{{quarter}}`, `{{isoweek}}`,
/// `{{title}}`, `{{path}}`, `{{var:name}}`, the sequence generators (`seq`, `nestseq`, `regex`,
/// `regexseq`), and the lookups (`parentfolder`, `relativepath`, `linkto`, `frontmatter`,
/// `workspacename`, `uuid`), each optionally chained through `|fn[:arg]` pipe transforms. Any other
/// `{{...}}` span (unknown name, unusable arguments, missing store/lookup, or malformed syntax) is
/// left in the output exactly as written: this function never panics and never drops content.
pub fn render_template(body: &str, ctx: &TemplateContext) -> String {
    let mut out = String::with_capacity(body.len());
    let mut rest = body;
    while let Some(start) = rest.find("{{") {
        out.push_str(&rest[..start]);
        let after = &rest[start + 2..];
        // Find the closing `}}`, tolerating balanced inner braces (`REQ-\d{3}`).
        let mut depth = 0usize;
        let mut close = None;
        let bytes = after.as_bytes();
        for (i, &b) in bytes.iter().enumerate() {
            match b {
                b'{' => depth += 1,
                b'}' if depth > 0 => depth -= 1,
                b'}' if bytes.get(i + 1) == Some(&b'}') => {
                    close = Some(i);
                    break;
                }
                _ => {}
            }
        }
        match close {
            Some(i) => {
                let inner = &after[..i];
                match eval_span(inner, ctx) {
                    Some(v) => out.push_str(&v),
                    None => out.push_str(&rest[start..start + 2 + i + 2]),
                }
                rest = &after[i + 2..];
            }
            None => {
                out.push_str("{{");
                rest = after;
            }
        }
    }
    out.push_str(rest);
    out
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
    out.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
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
            "# {{title}}\n\nSaved at {{path}}\n",
            &ctx_at(2026, 9, 28, 8, 5, 0),
        );
        assert_eq!(out, "# My Title\n\nSaved at folder/note.md\n");
    }

    #[test]
    fn repeated_placeholder_substitutes_every_occurrence() {
        let out = render_template("{{title}} / {{title}}", &ctx_at(2026, 9, 28, 8, 5, 0));
        assert_eq!(out, "My Title / My Title");
    }

    #[test]
    fn bare_date_uses_default_format() {
        let out = render_template("{{date}}", &ctx_at(2026, 1, 5, 8, 5, 0));
        assert_eq!(out, "2026-01-05");
    }

    #[test]
    fn custom_date_format_applies() {
        let out = render_template("{{date:DD/MM/YYYY}}", &ctx_at(2026, 1, 5, 8, 5, 0));
        assert_eq!(out, "05/01/2026");
    }

    #[test]
    fn time_placeholder_renders_zero_padded() {
        let out = render_template("{{time}}", &ctx_at(2026, 1, 5, 8, 5, 9));
        assert_eq!(out, "08:05");
    }

    #[test]
    fn unknown_placeholder_left_verbatim() {
        let out = render_template("{{nope}}", &ctx_at(2026, 9, 28, 8, 5, 0));
        assert_eq!(out, "{{nope}}");
    }

    #[test]
    fn malformed_placeholder_left_verbatim() {
        let out = render_template("{{ }} {{date", &ctx_at(2026, 9, 28, 8, 5, 0));
        assert_eq!(out, "{{ }} {{date");
    }

    #[test]
    fn unrecognized_date_token_passes_through() {
        let out = render_template("{{date:QQQQ}}", &ctx_at(2026, 9, 28, 8, 5, 0));
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
        assert_eq!(render_template("{{title|slug}}", &ctx), "my-cool-title");
    }

    #[test]
    fn upper_and_lower_pipes() {
        let ctx = ctx_at(2026, 9, 28, 8, 5, 0);
        assert_eq!(render_template("{{title|upper}}", &ctx), "MY TITLE");
        assert_eq!(render_template("{{title|lower}}", &ctx), "my title");
    }

    #[test]
    fn chained_pipes_apply_in_order() {
        let mut ctx = ctx_at(2026, 9, 28, 8, 5, 0);
        ctx.title = "  Hello World  ".to_string();
        assert_eq!(render_template("{{title|trim|slug}}", &ctx), "hello-world");
    }

    #[test]
    fn date_offset_adds_days() {
        let ctx = ctx_at(2026, 1, 5, 8, 5, 0);
        assert_eq!(render_template("{{date+7:YYYY-MM-DD}}", &ctx), "2026-01-12");
        assert_eq!(render_template("{{date-5:YYYY-MM-DD}}", &ctx), "2025-12-31");
    }

    #[test]
    fn var_placeholder_substitutes_from_context() {
        let mut ctx = ctx_at(2026, 9, 28, 8, 5, 0);
        ctx.variables
            .insert("project".to_string(), "Flint".to_string());
        assert_eq!(render_template("{{var:project}}", &ctx), "Flint");
    }

    #[test]
    fn var_placeholder_missing_from_context_left_verbatim() {
        let ctx = ctx_at(2026, 9, 28, 8, 5, 0);
        assert_eq!(render_template("{{var:unknown}}", &ctx), "{{var:unknown}}");
    }

    #[test]
    fn var_placeholder_with_pipe() {
        let mut ctx = ctx_at(2026, 9, 28, 8, 5, 0);
        ctx.variables
            .insert("project".to_string(), "Acme Corp".to_string());
        assert_eq!(render_template("{{var:project|slug}}", &ctx), "acme-corp");
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
        std::fs::write(templates.join("zeta.md"), "# {{title}}").unwrap();
        std::fs::write(templates.join("sub/alpha.md"), "# {{title}}").unwrap();
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
        assert_eq!(render_template("{{title|truncate:2}}", &ctx), "My");
        assert_eq!(
            render_template("{{title|replace:My:Your}}", &ctx),
            "Your Title"
        );
        assert_eq!(render_template("{{title|kebab|upper}}", &ctx), "MY-TITLE");
        assert_eq!(
            render_template("{{var:x|default:none}}", &ctx),
            "{{var:x|default:none}}"
        );
    }

    #[test]
    fn date_units_and_calendar() {
        let ctx = ctx_at(2026, 1, 31, 8, 5, 0);
        assert_eq!(
            render_template("{{date+2w:YYYY-MM-DD}}", &ctx),
            "2026-02-14"
        );
        assert_eq!(
            render_template("{{date-1mo:YYYY-MM-DD}}", &ctx),
            "2025-12-31"
        );
        assert_eq!(
            render_template("{{weekday}} {{quarter}} {{isoweek}}", &ctx),
            "Saturday Q1 W05"
        );
        assert_eq!(render_template("{{date+1zz}}", &ctx), "{{date+1zz}}");
    }

    #[test]
    fn seq_persists_across_restart_and_notes() {
        let dir = tempdir().unwrap();
        let body = "{{seq:T:4}}";
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
        assert_eq!(render_template("{{seq:F:2:folder}}", &a), "F01");
        assert_eq!(render_template("{{seq:F:2:folder}}", &a), "F02");
        assert_eq!(render_template("{{seq:F:2:folder}}", &b), "F01");
    }

    #[test]
    fn nestseq_resets_children_and_survives_restart() {
        let dir = tempdir().unwrap();
        let r = |b: &str| render_template(b, &seq_ctx(dir.path()));
        assert_eq!(r("T{{nestseq:3}}"), "T01.01.01");
        assert_eq!(r("T{{nestseq:3}}"), "T01.01.02");
        assert_eq!(r("{{nestseq:3:2}}"), "01.02.01");
        assert_eq!(r("{{nestseq:3}}"), "01.02.02");
        assert_eq!(r("{{nestseq:3:1}}"), "02.01.01");
        assert_eq!(r("{{nestseq:9}}"), "{{nestseq:9}}");
    }

    #[test]
    fn regexseq_increments_and_regex_matches() {
        let dir = tempdir().unwrap();
        let r = |b: &str| render_template(b, &seq_ctx(dir.path()));
        assert_eq!(r(r"{{regexseq:REQ-\d{3}}}"), "REQ-001");
        assert_eq!(r(r"{{regexseq:REQ-\d{3}}}"), "REQ-002");
        let out = r(r"{{regex:[A-Z]{2}-\d{3}}}");
        assert!(
            regex::Regex::new(r"^[A-Z]{2}-\d{3}$")
                .unwrap()
                .is_match(&out),
            "{out}"
        );
        assert_eq!(r("{{regex:a+}}"), "{{regex:a+}}");
    }

    #[test]
    fn sequences_without_store_left_verbatim() {
        let ctx = ctx_at(2026, 9, 28, 8, 5, 0);
        assert_eq!(render_template("{{seq:T:4}}", &ctx), "{{seq:T:4}}");
        assert_eq!(render_template("{{nestseq:3}}", &ctx), "{{nestseq:3}}");
    }

    #[test]
    fn lookups() {
        let dir = tempdir().unwrap();
        let mut ctx = seq_ctx(dir.path());
        ctx.path = "projects/x/new.md".into();
        assert_eq!(render_template("{{parentfolder}}", &ctx), "x");
        assert_eq!(render_template("{{workspacename}}", &ctx), "ws");
        assert_eq!(
            render_template("{{relativepath:notes/a.md}}", &ctx),
            "../../notes/a.md"
        );
        assert_eq!(
            render_template("{{linkto:notes/a.md}}", &ctx),
            "[Alpha](../../notes/a.md)"
        );
        assert_eq!(
            render_template("{{linkto:nope.md}}", &ctx),
            "{{linkto:nope.md}}"
        );
        assert_eq!(
            render_template("{{frontmatter:notes/a.md#status}}", &ctx),
            "draft"
        );
        assert_eq!(render_template("{{uuid}}", &ctx).len(), 36);
        let bare = ctx_at(2026, 9, 28, 8, 5, 0);
        assert_eq!(
            render_template("{{workspacename}}", &bare),
            "{{workspacename}}"
        );
    }
}
