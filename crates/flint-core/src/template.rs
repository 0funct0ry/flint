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

use chrono::{DateTime, Datelike, Duration as ChronoDuration, Local, Timelike};
use regex::Regex;
use std::collections::HashMap;
use std::path::Path;

/// The subdirectory (workspace-relative) that holds template files.
pub const TEMPLATES_DIR: &str = ".flint/templates";

/// Everything a template placeholder can reference when rendering a new note's initial content.
#[derive(Debug, Clone)]
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
}

impl TemplateContext {
    pub fn new(title: impl Into<String>, path: impl Into<String>) -> Self {
        Self {
            title: title.into(),
            path: path.into(),
            now: Local::now(),
            variables: HashMap::new(),
        }
    }

    pub fn with_variables(mut self, variables: HashMap<String, String>) -> Self {
        self.variables = variables;
        self
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

/// Apply one fixed transform helper (M10.27: `slug`/`upper`/`lower`/`trim`) to `value`. An unknown
/// helper name is a no-op — passes `value` through unchanged, matching the "unknown things never
/// drop content" contract the rest of this module follows.
fn apply_transform(fn_name: &str, value: &str) -> String {
    match fn_name {
        "slug" => {
            let lower = value.to_lowercase();
            let mut out = String::with_capacity(lower.len());
            let mut last_was_dash = false;
            for c in lower.chars() {
                if c.is_alphanumeric() {
                    out.push(c);
                    last_was_dash = false;
                } else if !last_was_dash && !out.is_empty() {
                    out.push('-');
                    last_was_dash = true;
                }
            }
            out.trim_end_matches('-').to_string()
        }
        "upper" => value.to_uppercase(),
        "lower" => value.to_lowercase(),
        "trim" => value.trim().to_string(),
        _ => value.to_string(),
    }
}

/// Render `{{date}}`, `{{date:FORMAT}}`, `{{date+N:FORMAT}}`/`{{date-N:FORMAT}}` (date math),
/// `{{time}}`, `{{title}}`, `{{path}}`, and `{{var:name}}` placeholders in `body` against `ctx`,
/// each optionally chained through `|fn` pipe transforms (`{{title|slug}}`,
/// `{{title|slug|upper}}`). Any other `{{...}}` span (unknown name, or malformed — unbalanced
/// braces, empty name) is left in the output exactly as written: this function never panics and
/// never drops content.
pub fn render_template(body: &str, ctx: &TemplateContext) -> String {
    let re = Regex::new(r"\{\{\s*([A-Za-z]+)([+-]\d+)?(?::([^}|]*))?((?:\|[A-Za-z]+)*)\s*\}\}")
        .expect("static regex");
    re.replace_all(body, |caps: &regex::Captures| {
        let name = &caps[1];
        let offset = caps.get(2).map(|m| m.as_str());
        let modifier = caps.get(3).map(|m| m.as_str());
        let pipes = caps.get(4).map(|m| m.as_str()).unwrap_or("");

        let base: Option<String> = match name {
            "date" => {
                let tokens = modifier.unwrap_or(DEFAULT_DATE_TOKENS);
                let offset_days: i64 = offset.and_then(|o| o.parse().ok()).unwrap_or(0);
                let shifted = ctx.now + ChronoDuration::days(offset_days);
                Some(format_date_tokens(&shifted, tokens))
            }
            "time" => Some(format_date_tokens(&ctx.now, "HH:mm")),
            "title" => Some(ctx.title.clone()),
            "path" => Some(ctx.path.clone()),
            "var" => modifier.and_then(|var_name| ctx.variables.get(var_name).cloned()),
            _ => None,
        };

        match base {
            Some(mut value) => {
                for fn_name in pipes.split('|').filter(|s| !s.is_empty()) {
                    value = apply_transform(fn_name, &value);
                }
                value
            }
            None => caps[0].to_string(),
        }
    })
    .into_owned()
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
            variables: HashMap::new(),
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
}
