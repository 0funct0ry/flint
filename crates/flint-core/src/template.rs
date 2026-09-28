//! Note template engine and `.flint/templates/` discovery (M10.26).
//!
//! Pure logic, no Tauri dependency: `render_template` substitutes `{{date}}`, `{{date:FORMAT}}`,
//! `{{time}}`, `{{title}}`, and `{{path}}` placeholders in a template body, and `list_templates`
//! enumerates the plain `.md` files a workspace keeps under `.flint/templates/` — a workspace-
//! portable directory, not hidden inside `.flint.db`, so templates travel with the notes.

use chrono::{DateTime, Datelike, Local, Timelike};
use regex::Regex;
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
}

impl TemplateContext {
    pub fn new(title: impl Into<String>, path: impl Into<String>) -> Self {
        Self {
            title: title.into(),
            path: path.into(),
            now: Local::now(),
        }
    }
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

/// Render `{{date}}`, `{{date:FORMAT}}`, `{{time}}`, `{{title}}`, and `{{path}}` placeholders in
/// `body` against `ctx`. Any other `{{...}}` span (unknown name, or malformed — unbalanced braces,
/// empty name) is left in the output exactly as written: this function never panics and never
/// drops content.
pub fn render_template(body: &str, ctx: &TemplateContext) -> String {
    let re = Regex::new(r"\{\{\s*([A-Za-z]+)(?::([^}]*))?\s*\}\}").expect("static regex");
    re.replace_all(body, |caps: &regex::Captures| {
        let name = &caps[1];
        let modifier = caps.get(2).map(|m| m.as_str());
        match name {
            "date" => {
                let tokens = modifier.unwrap_or(DEFAULT_DATE_TOKENS);
                format_date_tokens(&ctx.now, tokens)
            }
            "time" => format_date_tokens(&ctx.now, "HH:mm"),
            "title" => ctx.title.clone(),
            "path" => ctx.path.clone(),
            _ => caps[0].to_string(),
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
