//! Markdown rendering pipeline for Flint (SPEC §8.4, M5).
//!
//! Features:
//! - Front-matter skip.
//! - Math expressions (`$...$` and `$$...$$`) preserved as placeholders before parsing.
//! - pulldown-cmark parser with tables, footnotes, task lists, strikethrough, heading attributes, smart punctuation.
//! - Heading outline extraction with clean slug anchors.
//! - Code syntax highlighting via syntect (theming matching Flint's light and dark tokens).
//! - Local workspace image asset protocol resolution and missing image fallback placeholder.
//! - Conservative HTML sanitization via ammonia (no scripts, no iframes, no event handlers, no `javascript:` URLs).
//! - Source line mapping hints on block elements for scroll synchronization in split view.

use ammonia::Builder as AmmoniaBuilder;
use pulldown_cmark::{
    html, CodeBlockKind, CowStr, Event, HeadingLevel, Options, Parser, Tag, TagEnd,
};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::path::Path;
use std::sync::OnceLock;
use syntect::easy::HighlightLines;
use syntect::highlighting::ThemeSet;
use syntect::html::{styled_line_to_highlighted_html, IncludeBackground};
use syntect::parsing::SyntaxSet;

use crate::md_extensions::{
    decode_wikilink_dest, decode_wikilink_embed_dest, parse_callout, rewrite_wikilinks,
    strip_comments, CALLOUT_TYPES,
};
use crate::{dedup_slug, extract_headings, parse_front_matter, slugify, HeadingItem, NotePath};
use std::collections::HashMap;
use std::fs;

/// Maximum embed recursion depth (M10.24): a chain of `![[...]]` embeds nested deeper than this
/// stops recursing and renders a `flint-embed-depth-limit` placeholder instead, so a pathological
/// (non-cyclic) embed chain can't cause runaway work. Chosen so ordinary legitimate nesting still
/// renders in full.
const EMBED_MAX_DEPTH: usize = 5;

/// Result returned from markdown rendering.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RenderResult {
    pub html: String,
    pub headings: Vec<HeadingItem>,
}

static SYNTAX_SET: OnceLock<SyntaxSet> = OnceLock::new();
static THEME_SET: OnceLock<ThemeSet> = OnceLock::new();

fn get_syntax_set() -> &'static SyntaxSet {
    SYNTAX_SET.get_or_init(SyntaxSet::load_defaults_newlines)
}

fn get_theme_set() -> &'static ThemeSet {
    THEME_SET.get_or_init(ThemeSet::load_defaults)
}

/// Highlight a block of code with syntect.
fn highlight_code(code: &str, lang: &str, is_dark: bool) -> String {
    let ps = get_syntax_set();
    let ts = get_theme_set();

    let theme_name = if is_dark {
        "base16-ocean.dark"
    } else {
        "base16-ocean.light"
    };
    let theme = &ts.themes[theme_name];

    let syntax = if !lang.is_empty() {
        ps.find_syntax_by_token(lang)
            .or_else(|| ps.find_syntax_by_extension(lang))
            .unwrap_or_else(|| ps.find_syntax_plain_text())
    } else {
        ps.find_syntax_plain_text()
    };

    let mut highlighter = HighlightLines::new(syntax, theme);
    let mut highlighted_html = String::new();

    for line in syntect::util::LinesWithEndings::from(code) {
        if let Ok(ranges) = highlighter.highlight_line(line, ps) {
            if let Ok(escaped) = styled_line_to_highlighted_html(&ranges[..], IncludeBackground::No)
            {
                highlighted_html.push_str(&escaped);
            } else {
                let escaped = html_escape::encode_text(line);
                highlighted_html.push_str(&escaped);
            }
        } else {
            let escaped = html_escape::encode_text(line);
            highlighted_html.push_str(&escaped);
        }
    }

    format!(
        "<pre class=\"syntect-code\" data-lang=\"{}\"><code>{}</code></pre>",
        html_escape::encode_double_quoted_attribute(lang),
        highlighted_html
    )
}

mod html_escape {
    pub fn encode_text(s: &str) -> String {
        s.replace('&', "&amp;")
            .replace('<', "&lt;")
            .replace('>', "&gt;")
            .replace('"', "&quot;")
            .replace('\'', "&#39;")
    }

    pub fn encode_double_quoted_attribute(s: &str) -> String {
        encode_text(s)
    }
}

/// Helper to protect math delimiters `$$...$$` and `$...$` before parsing.
fn protect_math(text: &str) -> (String, Vec<MathSpan>) {
    let mut out = String::with_capacity(text.len());
    let mut math_spans = Vec::new();
    let chars: Vec<char> = text.chars().collect();
    let len = chars.len();
    let mut i = 0;
    let mut in_code_fence = false;

    while i < len {
        // Check for code fence
        if (i == 0 || chars[i - 1] == '\n')
            && i + 2 < len
            && (chars[i] == '`' && chars[i + 1] == '`' && chars[i + 2] == '`'
                || chars[i] == '~' && chars[i + 1] == '~' && chars[i + 2] == '~')
        {
            in_code_fence = !in_code_fence;
            out.push(chars[i]);
            out.push(chars[i + 1]);
            out.push(chars[i + 2]);
            i += 3;
            continue;
        }

        if in_code_fence {
            out.push(chars[i]);
            i += 1;
            continue;
        }

        // Check for inline code span `...` or ``...``
        if chars[i] == '`' {
            let mut backtick_count = 0;
            let mut k = i;
            while k < len && chars[k] == '`' {
                backtick_count += 1;
                k += 1;
            }

            // Look for matching closing backticks
            let mut close_idx = None;
            let mut scan = k;
            while scan < len {
                if chars[scan] == '`' {
                    let mut match_count = 0;
                    let m_start = scan;
                    while scan < len && chars[scan] == '`' {
                        match_count += 1;
                        scan += 1;
                    }
                    if match_count == backtick_count {
                        close_idx = Some((m_start, scan));
                        break;
                    }
                } else {
                    scan += 1;
                }
            }

            if let Some((_start, end)) = close_idx {
                for ch in &chars[i..end] {
                    out.push(*ch);
                }
                i = end;
                continue;
            }
        }

        // Check for display math $$...$$
        if chars[i] == '$' && i + 1 < len && chars[i + 1] == '$' {
            // Find closing $$
            let mut j = i + 2;
            let mut found = false;
            while j + 1 < len {
                if chars[j] == '$' && chars[j + 1] == '$' && (j == i + 2 || chars[j - 1] != '\\') {
                    found = true;
                    break;
                }
                j += 1;
            }

            if found {
                let math_content: String = chars[i + 2..j].iter().collect();
                let placeholder = format!("FLINTMATHBLOCKPLACEHOLDER{}", math_spans.len());
                math_spans.push(MathSpan {
                    placeholder: placeholder.clone(),
                    content: math_content.trim().to_string(),
                    is_block: true,
                });
                out.push_str(&placeholder);
                i = j + 2;
                continue;
            }
        }

        // Check for inline math $...$
        if chars[i] == '$' && (i == 0 || chars[i - 1] != '\\') {
            // Look ahead for closing $
            let mut j = i + 1;
            let mut found = false;
            // Ensure not empty and not an escaped dollar
            if j < len && chars[j] != '$' {
                while j < len {
                    if chars[j] == '$' && chars[j - 1] != '\\' {
                        found = true;
                        break;
                    }
                    j += 1;
                }
            }

            if found {
                let math_content: String = chars[i + 1..j].iter().collect();
                let placeholder = format!("FLINTMATHINLINEPLACEHOLDER{}", math_spans.len());
                math_spans.push(MathSpan {
                    placeholder: placeholder.clone(),
                    content: math_content.to_string(),
                    is_block: false,
                });
                out.push_str(&placeholder);
                i = j + 1;
                continue;
            }
        }

        out.push(chars[i]);
        i += 1;
    }

    (out, math_spans)
}

struct MathSpan {
    placeholder: String,
    content: String,
    is_block: bool,
}

/// Render a fully-buffered blockquote's events as either an Obsidian-style callout
/// (`> [!type]`) or a plain blockquote, per SPEC M10.05. An unrecognized callout type still
/// renders as a styled blockquote rather than being dropped.
///
/// Note: this uses pulldown-cmark's own default HTML output for the buffered events, so a task
/// checkbox inside a blockquote renders as the library's plain `disabled` checkbox rather than
/// the clickable, `data-task-index`-numbered one the main event loop produces — matching
/// `findTaskMarkers` (`src/services/taskList.ts`), which likewise does not match a
/// blockquote-prefixed task line. Interactive checkboxes inside blockquotes are not supported.
fn render_callout_or_blockquote(events: Vec<Event<'_>>) -> Event<'_> {
    let mut callout: Option<(String, usize, usize, String)> = None;

    // The first paragraph's first line may be split across several adjacent `Text` events
    // (pulldown-cmark splits text around bracket-like characters such as `[`/`]` even outside
    // an actual link). Concatenate every Text event up to the first line break to recover the
    // full first line before matching the callout marker against it.
    if let Some(Event::Start(Tag::Paragraph)) = events.first() {
        let mut first_line = String::new();
        let mut end_idx = None;
        for (idx, ev) in events.iter().enumerate().skip(1) {
            match ev {
                Event::Text(text) => first_line.push_str(text),
                Event::SoftBreak | Event::HardBreak => {
                    end_idx = Some(idx);
                    break;
                }
                Event::End(TagEnd::Paragraph) => {
                    end_idx = Some(idx);
                    break;
                }
                _ => break,
            }
        }

        if let (Some(end_idx), Some((ctype, rest))) = (
            end_idx,
            parse_callout(&first_line).map(|(t, r)| (t.to_string(), r.to_string())),
        ) {
            callout = Some((ctype, 1, end_idx, rest));
        }
    }

    let mut inner_html = String::new();

    if let Some((callout_type, marker_start, marker_end, rest)) = callout {
        let rebuilt: Vec<Event> = events
            .into_iter()
            .enumerate()
            .filter_map(|(i, ev)| {
                if i == marker_start {
                    if rest.is_empty() {
                        None
                    } else {
                        Some(Event::Text(CowStr::Boxed(rest.clone().into_boxed_str())))
                    }
                } else if i > marker_start && i < marker_end {
                    None
                } else {
                    Some(ev)
                }
            })
            .collect();
        html::push_html(&mut inner_html, rebuilt.into_iter());

        let type_lc = callout_type.to_lowercase();
        let class = if CALLOUT_TYPES.contains(&type_lc.as_str()) {
            format!("callout callout-{}", type_lc)
        } else {
            "callout".to_string()
        };
        let html_out = format!(
            "<div class=\"{}\" data-callout-type=\"{}\">{}</div>",
            class,
            html_escape::encode_double_quoted_attribute(&type_lc),
            inner_html
        );
        Event::Html(CowStr::Boxed(html_out.into_boxed_str()))
    } else {
        html::push_html(&mut inner_html, events.into_iter());
        let html_out = format!("<blockquote>{}</blockquote>", inner_html);
        Event::Html(CowStr::Boxed(html_out.into_boxed_str()))
    }
}

/// Convert local image relative path to Tauri asset protocol URL or placeholder.
fn resolve_image_src(
    src: &str,
    note_folder_abs: Option<&Path>,
    workspace_root: Option<&Path>,
) -> (String, bool) {
    if src.starts_with("http://")
        || src.starts_with("https://")
        || src.starts_with("data:")
        || src.starts_with("asset:")
    {
        return (src.to_string(), true);
    }

    // Attempt to resolve local path
    if let (Some(folder), Some(root)) = (note_folder_abs, workspace_root) {
        let clean_path = src
            .split('?')
            .next()
            .unwrap_or(src)
            .split('#')
            .next()
            .unwrap_or(src);
        let trimmed_leading = clean_path.trim_start_matches("./");
        let resolved = if clean_path.starts_with('/') {
            root.join(clean_path.trim_start_matches('/'))
        } else if folder.join(trimmed_leading).exists() {
            folder.join(trimmed_leading)
        } else if root.join(trimmed_leading).exists() {
            root.join(trimmed_leading)
        } else {
            folder.join(trimmed_leading)
        };

        // Canonicalize & verify containment
        if let Ok(canonical_root) = root.canonicalize() {
            if let Ok(canonical_img) = resolved.canonicalize() {
                if canonical_img.starts_with(&canonical_root) && canonical_img.is_file() {
                    // Convert to asset protocol URL: asset://localhost/<absolute_path>
                    let path_str = canonical_img.to_string_lossy();
                    let asset_url = format!("asset://localhost{}", path_str);
                    return (asset_url, true);
                }
            }
        }
    }

    // Missing local image
    (src.to_string(), false)
}

/// Build the same `flint-ambiguous-link` anchor markup the plain-link handler emits, reused by
/// the embed handler (M10.24) so an ambiguous embed target gets identical UI to an ambiguous
/// plain wikilink rather than a separate error path.
fn ambiguous_link_html(candidates: &[NotePath], label: &str) -> String {
    let candidates_attr = candidates.join(",");
    format!(
        "<a href=\"#/ambiguous\" class=\"flint-ambiguous-link\" data-candidates=\"{}\">{}</a>",
        html_escape::encode_double_quoted_attribute(&candidates_attr),
        html_escape::encode_text(label)
    )
}

/// Build the same `flint-broken-link` anchor markup the plain-link handler emits, reused by the
/// embed handler (M10.24) so an unresolved embed target gets identical UI to an unresolved plain
/// wikilink rather than a separate error path.
fn broken_link_html(raw_path: &str, anchor: Option<&str>, label: &str) -> String {
    let anchor_part = anchor.map(|a| format!("#{}", a)).unwrap_or_default();
    let href = format!("#/create-note/{}{}", raw_path, anchor_part);
    let title_val = format!("Broken link — click to create {}", raw_path);
    format!(
        "<a href=\"{}\" class=\"flint-broken-link\" data-target=\"{}\" title=\"{}\">{}</a>",
        html_escape::encode_double_quoted_attribute(&href),
        html_escape::encode_double_quoted_attribute(raw_path),
        html_escape::encode_double_quoted_attribute(&title_val),
        html_escape::encode_text(label)
    )
}

/// Resolve and render an `![[target]]` embed (M10.24): unresolved/ambiguous targets reuse the
/// plain-link broken/ambiguous UI; a resolved target is read from disk and recursively rendered
/// (so its own relative links/images resolve against *its* folder), wrapped in a bordered
/// `.flint-embed` boundary; a cycle or over-depth chain renders a named, non-blank placeholder
/// instead of recursing.
#[allow(clippy::too_many_arguments)]
fn render_embed(
    target: &str,
    heading: Option<&str>,
    theme: &str,
    workspace_root: Option<&Path>,
    note_relative_path: Option<&str>,
    wikilinks_enabled: bool,
    filename_stems: &HashMap<String, Vec<NotePath>>,
    visited: &mut Vec<NotePath>,
    depth: usize,
) -> String {
    let (Some(root), Some(source_rel)) = (workspace_root, note_relative_path) else {
        // No workspace context to resolve against — render the raw target as a broken link,
        // matching the plain-link handler's fallback for the same situation.
        return broken_link_html(target, heading, target);
    };

    let resolution =
        crate::resolve_wikilink_target(root, source_rel, filename_stems, target, heading);

    match resolution {
        crate::ResolvedTarget::Ambiguous(candidates) => ambiguous_link_html(&candidates, target),
        crate::ResolvedTarget::Unresolved { raw_path, anchor } => {
            broken_link_html(&raw_path, anchor.as_deref(), target)
        }
        crate::ResolvedTarget::External(url) => {
            // A bare wikilink target never resolves to `External` (no `://` in a bare name), but
            // handle it defensively rather than panicking.
            format!(
                "<a href=\"{}\" target=\"_blank\" rel=\"noopener noreferrer\" class=\"flint-external-link\">{}</a>",
                html_escape::encode_double_quoted_attribute(&url),
                html_escape::encode_text(target)
            )
        }
        crate::ResolvedTarget::Internal { path, .. } => {
            if visited.contains(&path) {
                let mut chain: Vec<&str> = visited.iter().map(|p| p.as_str()).collect();
                chain.push(&path);
                return format!(
                    "<div class=\"flint-embed-cycle\">Embed cycle: {}</div>",
                    html_escape::encode_text(&chain.join(" \u{2192} "))
                );
            }
            if depth >= EMBED_MAX_DEPTH {
                return format!(
                    "<div class=\"flint-embed-depth-limit\">Embed depth limit ({}) reached — not rendering <code>{}</code></div>",
                    EMBED_MAX_DEPTH,
                    html_escape::encode_text(&path)
                );
            }

            let target_abs = root.join(&path);
            let target_content = match fs::read_to_string(&target_abs) {
                Ok(c) => c,
                Err(_) => return broken_link_html(&path, None, target),
            };

            visited.push(path.clone());
            let inner = render_note_markdown_recursive(
                &target_content,
                theme,
                Some(root),
                Some(&path),
                wikilinks_enabled,
                Some(filename_stems),
                visited,
                depth + 1,
            );
            visited.pop();

            format!(
                "<div class=\"flint-embed\" data-embed-source=\"{}\"><div class=\"flint-embed-source\">{}</div>{}</div>",
                html_escape::encode_double_quoted_attribute(&path),
                html_escape::encode_text(&path),
                inner.html
            )
        }
    }
}

/// Render Markdown note content to sanitized HTML and extract outline. Wikilinks are off
/// (see [`render_note_markdown_with_config`] to enable them) — this wrapper exists so the many
/// call sites that don't care about M10.23 don't need to thread a filename-stem index through.
pub fn render_note_markdown(
    raw_content: &str,
    theme: &str,
    workspace_root: Option<&Path>,
    note_relative_path: Option<&str>,
) -> RenderResult {
    render_note_markdown_with_config(
        raw_content,
        theme,
        workspace_root,
        note_relative_path,
        false,
        None,
    )
}

/// Same as [`render_note_markdown`], with `markdown.wikilinks` support (M10.23): when
/// `wikilinks_enabled`, `[[...]]`/`![[...]]` spans are rewritten to real links before parsing,
/// and resolved via bare-name lookup against `filename_stems` (the workspace `Index`'s stem map)
/// rather than the path-only [`crate::resolve_link_target`].
pub fn render_note_markdown_with_config(
    raw_content: &str,
    theme: &str,
    workspace_root: Option<&Path>,
    note_relative_path: Option<&str>,
    wikilinks_enabled: bool,
    filename_stems: Option<&HashMap<String, Vec<NotePath>>>,
) -> RenderResult {
    // Seed the cycle-detection set with the top-level note's own path so a note that (directly or
    // indirectly) embeds itself is caught rather than recursing forever (M10.24).
    let mut visited: Vec<NotePath> = Vec::new();
    if let Some(rel) = note_relative_path {
        visited.push(rel.to_string());
    }
    render_note_markdown_recursive(
        raw_content,
        theme,
        workspace_root,
        note_relative_path,
        wikilinks_enabled,
        filename_stems,
        &mut visited,
        0,
    )
}

/// Implementation behind [`render_note_markdown_with_config`], with the embed-recursion state
/// (`visited` path chain for cycle detection, `depth` for the [`EMBED_MAX_DEPTH`] cap) threaded
/// through so a resolved `![[target]]` embed can recursively call back into this same function
/// (see the `Event::Start(Tag::Image)` handling below) while sharing `workspace_root`/`theme`.
#[allow(clippy::too_many_arguments)]
fn render_note_markdown_recursive(
    raw_content: &str,
    theme: &str,
    workspace_root: Option<&Path>,
    note_relative_path: Option<&str>,
    wikilinks_enabled: bool,
    filename_stems: Option<&HashMap<String, Vec<NotePath>>>,
    visited: &mut Vec<NotePath>,
    depth: usize,
) -> RenderResult {
    let (_fm_raw, body, _, _) = parse_front_matter(raw_content);
    let headings = extract_headings(raw_content);
    let is_dark = theme.eq_ignore_ascii_case("dark");
    let empty_stems: HashMap<String, Vec<NotePath>> = HashMap::new();
    let filename_stems = filename_stems.unwrap_or(&empty_stems);

    let note_folder_abs = if let (Some(root), Some(rel)) = (workspace_root, note_relative_path) {
        let parent = Path::new(rel).parent().unwrap_or_else(|| Path::new(""));
        Some(root.join(parent))
    } else {
        None
    };

    let body_without_comments = strip_comments(body);
    let body_with_wikilinks = rewrite_wikilinks(&body_without_comments, wikilinks_enabled);
    let (protected_body, math_spans) = protect_math(&body_with_wikilinks);

    let mut options = Options::empty();
    options.insert(Options::ENABLE_TABLES);
    options.insert(Options::ENABLE_FOOTNOTES);
    options.insert(Options::ENABLE_STRIKETHROUGH);
    options.insert(Options::ENABLE_TASKLISTS);
    options.insert(Options::ENABLE_SMART_PUNCTUATION);
    options.insert(Options::ENABLE_HEADING_ATTRIBUTES);

    let mut parser = Parser::new_ext(&protected_body, options).peekable();

    let mut custom_events = Vec::new();
    let mut in_code_block = false;
    let mut code_block_lang = String::new();
    let mut code_block_buf = String::new();
    // Numbers every task-list checkbox in document order so the frontend can map a click on the
    // Nth rendered checkbox back to the Nth task marker in the raw source (`findTaskMarkers` in
    // `src/services/taskList.ts`) and toggle it in place. A checkbox inside a blockquote is
    // rendered via `render_callout_or_blockquote` instead (plain pulldown-cmark output, disabled,
    // uncounted here) — see that function's own note.
    let mut task_index: usize = 0;

    let mut current_heading_level = None;
    let mut current_heading_text = String::new();
    // Search cursor into `headings` (built by the separate `extract_headings` line
    // scanner) rather than a plain iterator: the scanner and this real pulldown-cmark
    // parse can disagree on what counts as a heading (e.g. setext headings, or headings
    // inside constructs the scanner doesn't track), so we resync on each heading by
    // matching slugified text going forward from the cursor instead of assuming the two
    // passes stay positionally aligned.
    let mut heading_search_start: usize = 0;
    let mut orphan_slug_counts: std::collections::HashMap<String, u32> =
        std::collections::HashMap::new();

    // Image state: collect alt text between Start(Image) and End(Image)
    let mut in_image = false;
    let mut image_alt_text = String::new();
    let mut image_resolved_url = String::new();
    let mut image_exists = false;
    let mut image_title = String::new();
    let mut image_dest_url = String::new();

    // Embed state (M10.24): an `![[target]]` embed also arrives as a `Tag::Image` event (see
    // `rewrite_wikilinks`), but its HTML is computed entirely at `Start(Image)` time (no
    // dependency on the label text between Start/End), so this just suppresses the normal
    // image-handling and text-forwarding paths until `End(Image)`.
    let mut in_embed = false;

    let mut blockquote_depth: i32 = 0;
    let mut blockquote_buffer: Vec<Event> = Vec::new();

    while let Some(event) = parser.next() {
        if blockquote_depth > 0 {
            match &event {
                Event::Start(Tag::BlockQuote(_)) => {
                    blockquote_depth += 1;
                    blockquote_buffer.push(event);
                }
                Event::End(TagEnd::BlockQuote(_)) => {
                    blockquote_depth -= 1;
                    if blockquote_depth == 0 {
                        let events = std::mem::take(&mut blockquote_buffer);
                        custom_events.push(render_callout_or_blockquote(events));
                    } else {
                        blockquote_buffer.push(event);
                    }
                }
                _ => {
                    blockquote_buffer.push(event);
                }
            }
            continue;
        }

        if let Event::Start(Tag::BlockQuote(_)) = &event {
            blockquote_depth += 1;
            blockquote_buffer.clear();
            continue;
        }

        match event {
            Event::Start(Tag::CodeBlock(kind)) => {
                in_code_block = true;
                code_block_lang = match kind {
                    CodeBlockKind::Fenced(lang) => lang.trim().to_string(),
                    CodeBlockKind::Indented => String::new(),
                };
                code_block_buf.clear();
            }
            Event::End(TagEnd::CodeBlock) => {
                in_code_block = false;
                let rendered = if code_block_lang.eq_ignore_ascii_case("mermaid") {
                    // Mermaid needs its raw diagram-definition text (HTML-escaped, not
                    // syntax-colorized) handed to the client-side library verbatim (M10.24).
                    format!(
                        "<pre class=\"mermaid\">{}</pre>",
                        html_escape::encode_text(&code_block_buf)
                    )
                } else {
                    highlight_code(&code_block_buf, &code_block_lang, is_dark)
                };
                custom_events.push(Event::Html(CowStr::Boxed(rendered.into_boxed_str())));
            }
            Event::Text(text) if in_code_block => {
                code_block_buf.push_str(&text);
            }
            Event::Text(text) if in_image => {
                image_alt_text.push_str(&text);
            }
            Event::Code(text) if in_image => {
                image_alt_text.push_str(&text);
            }
            Event::SoftBreak if in_image => {
                image_alt_text.push(' ');
            }
            Event::Start(Tag::Heading { level, .. }) => {
                current_heading_level = Some(level);
                current_heading_text.clear();
            }
            Event::End(TagEnd::Heading(_)) => {
                if let Some(level) = current_heading_level.take() {
                    let level_num = match level {
                        HeadingLevel::H1 => 1,
                        HeadingLevel::H2 => 2,
                        HeadingLevel::H3 => 3,
                        HeadingLevel::H4 => 4,
                        HeadingLevel::H5 => 5,
                        HeadingLevel::H6 => 6,
                    };

                    // Use the anchor already assigned by extract_headings, resynced by
                    // matching slugified text forward from the search cursor so the
                    // rendered id matches the outline entry even if the two heading
                    // passes have drifted out of positional lockstep.
                    let wanted_slug = slugify(&current_heading_text);
                    let matched = headings[heading_search_start..]
                        .iter()
                        .position(|h| slugify(&h.text) == wanted_slug)
                        .map(|offset| heading_search_start + offset);
                    let anchor = match matched {
                        Some(idx) => {
                            heading_search_start = idx + 1;
                            headings[idx].anchor.clone()
                        }
                        None => dedup_slug(&mut orphan_slug_counts, wanted_slug),
                    };

                    let h_html = format!(
                        "<h{} id=\"{}\">{}</h{}>",
                        level_num,
                        html_escape::encode_double_quoted_attribute(&anchor),
                        html_escape::encode_text(&current_heading_text),
                        level_num
                    );
                    custom_events.push(Event::Html(CowStr::Boxed(h_html.into_boxed_str())));
                }
            }
            Event::Text(text) if current_heading_level.is_some() => {
                current_heading_text.push_str(&text);
            }
            Event::Code(text) if current_heading_level.is_some() => {
                current_heading_text.push_str(&text);
            }
            Event::Start(Tag::Link {
                link_type: _,
                dest_url,
                title,
                id: _,
            }) => {
                let raw_dest = dest_url.to_string();
                let title_attr = if !title.is_empty() {
                    format!(
                        " title=\"{}\"",
                        html_escape::encode_double_quoted_attribute(&title)
                    )
                } else {
                    String::new()
                };

                if let (Some(root), Some(source_rel)) = (workspace_root, note_relative_path) {
                    let resolution = match decode_wikilink_dest(&raw_dest) {
                        Some((target, heading)) => crate::resolve_wikilink_target(
                            root,
                            source_rel,
                            filename_stems,
                            &target,
                            heading.as_deref(),
                        ),
                        None => crate::resolve_link_target(root, source_rel, &raw_dest),
                    };
                    match resolution {
                        crate::ResolvedTarget::Ambiguous(candidates) => {
                            let candidates_attr = candidates.join(",");
                            let link_html = format!(
                                "<a href=\"#/ambiguous\" class=\"flint-ambiguous-link\" data-candidates=\"{}\"{}>",
                                html_escape::encode_double_quoted_attribute(&candidates_attr),
                                title_attr
                            );
                            custom_events
                                .push(Event::Html(CowStr::Boxed(link_html.into_boxed_str())));
                        }
                        crate::ResolvedTarget::Internal { path, anchor } => {
                            let anchor_part = anchor.map(|a| format!("#{}", a)).unwrap_or_default();
                            let href = format!("#/note/{}{}", path, anchor_part);
                            let link_html = format!(
                                "<a href=\"{}\" class=\"flint-internal-link\" data-target=\"{}\"{}>",
                                html_escape::encode_double_quoted_attribute(&href),
                                html_escape::encode_double_quoted_attribute(&path),
                                title_attr
                            );
                            custom_events
                                .push(Event::Html(CowStr::Boxed(link_html.into_boxed_str())));
                        }
                        crate::ResolvedTarget::Unresolved { raw_path, anchor } => {
                            let anchor_part = anchor.map(|a| format!("#{}", a)).unwrap_or_default();
                            let href = format!("#/create-note/{}{}", raw_path, anchor_part);
                            let title_val = if !title.is_empty() {
                                title.to_string()
                            } else {
                                format!("Broken link — click to create {}", raw_path)
                            };
                            let link_html = format!(
                                "<a href=\"{}\" class=\"flint-broken-link\" data-target=\"{}\" title=\"{}\">",
                                html_escape::encode_double_quoted_attribute(&href),
                                html_escape::encode_double_quoted_attribute(&raw_path),
                                html_escape::encode_double_quoted_attribute(&title_val)
                            );
                            custom_events
                                .push(Event::Html(CowStr::Boxed(link_html.into_boxed_str())));
                        }
                        crate::ResolvedTarget::External(url) => {
                            let link_html = format!(
                                "<a href=\"{}\" target=\"_blank\" rel=\"noopener noreferrer\" class=\"flint-external-link\"{}>",
                                html_escape::encode_double_quoted_attribute(&url),
                                title_attr
                            );
                            custom_events
                                .push(Event::Html(CowStr::Boxed(link_html.into_boxed_str())));
                        }
                    }
                } else {
                    // Fallback when no workspace root context is provided
                    let link_html = format!(
                        "<a href=\"{}\"{}>",
                        html_escape::encode_double_quoted_attribute(&raw_dest),
                        title_attr
                    );
                    custom_events.push(Event::Html(CowStr::Boxed(link_html.into_boxed_str())));
                }
            }
            Event::End(TagEnd::Link) => {
                custom_events.push(Event::Html(CowStr::Borrowed("</a>")));
            }
            Event::Start(Tag::Image {
                link_type: _,
                dest_url,
                title,
                id: _,
            }) => {
                if let Some((target, heading)) = decode_wikilink_embed_dest(&dest_url) {
                    in_embed = true;
                    let embed_html = render_embed(
                        &target,
                        heading.as_deref(),
                        theme,
                        workspace_root,
                        note_relative_path,
                        wikilinks_enabled,
                        filename_stems,
                        visited,
                        depth,
                    );
                    custom_events.push(Event::Html(CowStr::Boxed(embed_html.into_boxed_str())));
                    continue;
                }

                let (resolved_url, exists) =
                    resolve_image_src(&dest_url, note_folder_abs.as_deref(), workspace_root);
                in_image = true;
                image_alt_text.clear();
                image_resolved_url = resolved_url;
                image_exists = exists;
                image_title = title.to_string();
                image_dest_url = dest_url.to_string();
            }
            Event::End(TagEnd::Image) => {
                if in_embed {
                    in_embed = false;
                    continue;
                }
                in_image = false;
                if image_exists {
                    let title_attr = if !image_title.is_empty() {
                        format!(
                            " title=\"{}\"",
                            html_escape::encode_double_quoted_attribute(&image_title)
                        )
                    } else {
                        String::new()
                    };
                    let img_html = format!(
                        "<img src=\"{}\" alt=\"{}\"{} loading=\"lazy\" />",
                        html_escape::encode_double_quoted_attribute(&image_resolved_url),
                        html_escape::encode_double_quoted_attribute(&image_alt_text),
                        title_attr
                    );
                    custom_events.push(Event::Html(CowStr::Boxed(img_html.into_boxed_str())));
                } else {
                    let missing_html = format!(
                        "<span class=\"flint-missing-image\" title=\"Image not found: {}\"><span class=\"flint-missing-image-icon\">🖼</span> Missing image: <code>{}</code></span>",
                        html_escape::encode_double_quoted_attribute(&image_dest_url),
                        html_escape::encode_text(&image_dest_url)
                    );
                    custom_events.push(Event::Html(CowStr::Boxed(missing_html.into_boxed_str())));
                }
            }
            Event::Start(Tag::Table(alignments)) => {
                // Wrap in a scrolling container, but still forward the original `Table` event
                // (with its column alignments) to `html::push_html` — it tracks alignment state
                // internally and needs to see this event to emit `style="text-align: …"` on each
                // `<th>`/`<td>`, not just the synthetic wrapper markup.
                custom_events.push(Event::Html(CowStr::Borrowed(
                    "<div class=\"table-container\" style=\"overflow-x:auto;\">",
                )));
                custom_events.push(Event::Start(Tag::Table(alignments)));
            }
            Event::End(TagEnd::Table) => {
                custom_events.push(Event::End(TagEnd::Table));
                custom_events.push(Event::Html(CowStr::Borrowed("</div>")));
            }
            Event::Start(Tag::Item) => {
                // pulldown-cmark's own `<li>` never carries a class (see `html.rs`'s
                // `Tag::Item` arm), so a plain list and a task list are visually
                // indistinguishable without this: a task item gets `class="task-list-item"`
                // (which `src/index.css` uses to hide the bullet/number marker and space the
                // checkbox from its label), a non-task item is forwarded unchanged and keeps its
                // bullet or number. Peeking one event ahead is safe because pulldown-cmark always
                // emits `TaskListMarker` as the first child of a task list item's `Item` node.
                if matches!(parser.peek(), Some(Event::TaskListMarker(_))) {
                    custom_events.push(Event::Html(CowStr::Borrowed(
                        "<li class=\"task-list-item\">",
                    )));
                } else {
                    custom_events.push(Event::Start(Tag::Item));
                }
            }
            Event::TaskListMarker(checked) => {
                let index = task_index;
                task_index += 1;
                let input_html = format!(
                    "<input type=\"checkbox\" data-task-index=\"{index}\"{checked_attr}/>",
                    checked_attr = if checked { " checked=\"\"" } else { "" }
                );
                custom_events.push(Event::Html(CowStr::Boxed(input_html.into_boxed_str())));
            }
            other => {
                if current_heading_level.is_none() && !in_image && !in_embed {
                    custom_events.push(other);
                }
            }
        }
    }

    let mut raw_rendered_html = String::new();
    html::push_html(&mut raw_rendered_html, custom_events.into_iter());

    // Sanitize with ammonia allowlist
    let mut ammonia_cleaner = AmmoniaBuilder::new();
    let mut tags = HashSet::new();
    tags.insert("h1");
    tags.insert("h2");
    tags.insert("h3");
    tags.insert("h4");
    tags.insert("h5");
    tags.insert("h6");
    tags.insert("p");
    tags.insert("hr");
    tags.insert("blockquote");
    tags.insert("ol");
    tags.insert("ul");
    tags.insert("li");
    tags.insert("input");
    tags.insert("pre");
    tags.insert("code");
    tags.insert("em");
    tags.insert("strong");
    tags.insert("del");
    tags.insert("s");
    tags.insert("a");
    tags.insert("img");
    tags.insert("div");
    tags.insert("span");
    tags.insert("table");
    tags.insert("thead");
    tags.insert("tbody");
    tags.insert("tfoot");
    tags.insert("tr");
    tags.insert("th");
    tags.insert("td");
    tags.insert("sub");
    tags.insert("sup");
    tags.insert("mark");
    tags.insert("section");

    let mut tag_attributes = std::collections::HashMap::new();
    let mut a_attrs = HashSet::new();
    a_attrs.insert("href");
    a_attrs.insert("title");
    a_attrs.insert("class");
    a_attrs.insert("target");
    a_attrs.insert("data-target");
    tag_attributes.insert("a", a_attrs);

    let mut img_attrs = HashSet::new();
    img_attrs.insert("src");
    img_attrs.insert("alt");
    img_attrs.insert("title");
    img_attrs.insert("loading");
    img_attrs.insert("class");
    tag_attributes.insert("img", img_attrs);

    let mut code_attrs = HashSet::new();
    code_attrs.insert("class");
    tag_attributes.insert("code", code_attrs);

    let mut pre_attrs = HashSet::new();
    pre_attrs.insert("class");
    pre_attrs.insert("data-lang");
    tag_attributes.insert("pre", pre_attrs);

    let mut input_attrs = HashSet::new();
    input_attrs.insert("type");
    input_attrs.insert("disabled");
    input_attrs.insert("checked");
    input_attrs.insert("class");
    input_attrs.insert("data-task-index");
    tag_attributes.insert("input", input_attrs);

    let mut generic_attrs = HashSet::new();
    generic_attrs.insert("class");
    generic_attrs.insert("id");
    generic_attrs.insert("style");
    generic_attrs.insert("title");
    generic_attrs.insert("data-lang");
    generic_attrs.insert("data-math");
    generic_attrs.insert("data-target");
    generic_attrs.insert("data-callout-type");
    generic_attrs.insert("data-embed-source");
    tag_attributes.insert("div", generic_attrs.clone());
    tag_attributes.insert("span", generic_attrs.clone());
    tag_attributes.insert("h1", generic_attrs.clone());
    tag_attributes.insert("h2", generic_attrs.clone());
    tag_attributes.insert("h3", generic_attrs.clone());
    tag_attributes.insert("h4", generic_attrs.clone());
    tag_attributes.insert("h5", generic_attrs.clone());
    tag_attributes.insert("h6", generic_attrs.clone());
    tag_attributes.insert("li", generic_attrs.clone());
    tag_attributes.insert("th", generic_attrs.clone());
    tag_attributes.insert("td", generic_attrs);

    let mut url_schemes = HashSet::new();
    url_schemes.insert("http");
    url_schemes.insert("https");
    url_schemes.insert("mailto");
    url_schemes.insert("asset");

    ammonia_cleaner
        .tags(tags)
        .tag_attributes(tag_attributes)
        .url_schemes(url_schemes)
        .link_rel(Some("noopener noreferrer"));

    let sanitized_html = ammonia_cleaner.clean(&raw_rendered_html).to_string();

    // Reinsert math elements
    let mut final_html = sanitized_html;
    for span in math_spans {
        let replacement = if span.is_block {
            format!(
                "<div class=\"flint-math-block\" data-math=\"{}\"></div>",
                html_escape::encode_double_quoted_attribute(&span.content)
            )
        } else {
            format!(
                "<span class=\"flint-math-inline\" data-math=\"{}\"></span>",
                html_escape::encode_double_quoted_attribute(&span.content)
            )
        };
        final_html = final_html.replace(&span.placeholder, &replacement);
    }

    RenderResult {
        html: final_html,
        headings,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::tempdir;

    #[test]
    fn test_render_table_column_alignment_survives_sanitization() {
        let md = "| Left | Center | Right | None |\n\
                  |:---|:---:|---:|---|\n\
                  | a | b | c | d |\n";
        let res = render_note_markdown(md, "dark", None, None);
        assert!(res
            .html
            .contains(r#"<th style="text-align: left">Left</th>"#));
        assert!(res
            .html
            .contains(r#"<th style="text-align: center">Center</th>"#));
        assert!(res
            .html
            .contains(r#"<th style="text-align: right">Right</th>"#));
        assert!(res.html.contains("<th>None</th>"));
        assert!(res.html.contains(r#"<td style="text-align: left">a</td>"#));
        assert!(res
            .html
            .contains(r#"<td style="text-align: center">b</td>"#));
        assert!(res.html.contains(r#"<td style="text-align: right">c</td>"#));
        assert!(res.html.contains("<td>d</td>"));
    }

    #[test]
    fn test_render_front_matter_skip_and_headings() {
        let md = r#"---
title: Test Note
tags: [rust, test]
---

# Main Title

Some introductory paragraph.

## Sub Heading

Content in sub section.
"#;
        let res = render_note_markdown(md, "dark", None, None);
        assert!(!res.html.contains("tags: [rust, test]"));
        assert!(res.html.contains("<h1 id=\"main-title\">Main Title</h1>"));
        assert!(res.html.contains("<h2 id=\"sub-heading\">Sub Heading</h2>"));
        assert_eq!(res.headings.len(), 2);
        assert_eq!(res.headings[0].text, "Main Title");
        assert_eq!(res.headings[0].anchor, "main-title");
        assert_eq!(res.headings[1].text, "Sub Heading");
        assert_eq!(res.headings[1].anchor, "sub-heading");
    }

    #[test]
    fn test_render_setext_heading_does_not_desync_outline_anchors() {
        // `extract_headings` (used for the outline) only recognizes ATX (`#`) headings,
        // so a setext heading (underlined with `===`) is invisible to it but is still a
        // real heading to pulldown-cmark. Regression test for a bug where this caused
        // every subsequent ATX heading's rendered `id` to be assigned the wrong outline
        // entry's anchor (see M-outline-click-to-scroll-fix).
        let md = r#"Intro Section
=============

Some text.

# Components

Some component text.

## Motion Semantics

Some motion text.
"#;
        let res = render_note_markdown(md, "dark", None, None);
        // The outline (from extract_headings) only sees the two ATX headings.
        assert_eq!(res.headings.len(), 2);
        assert_eq!(res.headings[0].text, "Components");
        assert_eq!(res.headings[0].anchor, "components");
        assert_eq!(res.headings[1].text, "Motion Semantics");
        assert_eq!(res.headings[1].anchor, "motion-semantics");
        // The rendered HTML must assign each ATX heading its own matching anchor,
        // not the next outline entry's anchor shifted by the invisible setext heading.
        assert!(res.html.contains("id=\"components\">Components"));
        assert!(res
            .html
            .contains("id=\"motion-semantics\">Motion Semantics"));
    }

    #[test]
    fn test_render_gfm_tables_and_tasklists() {
        let md = r#"
| Col A | Col B |
|-------|-------|
| 1     | 2     |

- [x] Done item
- [ ] Todo item
"#;
        let res = render_note_markdown(md, "light", None, None);
        assert!(res.html.contains("<table"));
        assert!(res.html.contains("<th>Col A</th>"));
        assert!(res.html.contains("<td>1</td>"));
        assert!(res.html.contains("type=\"checkbox\""));
        assert!(res.html.contains("checked"));
    }

    #[test]
    fn test_render_task_checkboxes_are_interactive_and_numbered_in_order() {
        let md = "- [x] Done item\n- [ ] Todo item\n- [ ] Third item\n";
        let res = render_note_markdown(md, "light", None, None);
        // Not `disabled` — a task checkbox is a real two-way control the frontend can click.
        assert!(!res.html.contains("disabled"));
        assert!(res
            .html
            .contains("<input type=\"checkbox\" data-task-index=\"0\" checked=\"\">"));
        assert!(res
            .html
            .contains("<input type=\"checkbox\" data-task-index=\"1\">"));
        assert!(res
            .html
            .contains("<input type=\"checkbox\" data-task-index=\"2\">"));
    }

    #[test]
    fn test_render_task_checkboxes_in_ordered_list() {
        // pulldown-cmark recognizes task markers in ordered lists too (SPEC-observed behavior,
        // not GFM-strict), and the frontend's checkbox click handler relies on that holding.
        let md = "1. [ ] Task 1\n2. [x] Task 2\n";
        let res = render_note_markdown(md, "light", None, None);
        assert!(res
            .html
            .contains("<input type=\"checkbox\" data-task-index=\"0\">"));
        assert!(res
            .html
            .contains("<input type=\"checkbox\" data-task-index=\"1\" checked=\"\">"));
        // Still an `<ol>`, and the item carries `task-list-item` for CSS (see `src/index.css`)
        // to space the checkbox from its label — but keeps its number, unlike an unordered list.
        assert!(res.html.contains("<ol>"));
        assert!(res.html.contains("<li class=\"task-list-item\">"));
    }

    #[test]
    fn test_render_task_list_item_gets_class_plain_list_item_does_not() {
        let md = "- [ ] A task\n- A plain item\n";
        let res = render_note_markdown(md, "light", None, None);
        assert!(res.html.contains("<li class=\"task-list-item\">"));
        // The plain item must not pick up the task class, and must render as an ordinary `<li>`.
        assert!(res.html.contains("<li>A plain item</li>"));
    }

    #[test]
    fn test_render_syntect_code_highlighting() {
        let md = r#"
```rust
fn main() {
    println!("Hello Flint!");
}
```
"#;
        let res_dark = render_note_markdown(md, "dark", None, None);
        assert!(res_dark.html.contains("syntect-code"));
        assert!(res_dark.html.contains("data-lang=\"rust\""));
        assert!(res_dark.html.contains("color:#"));

        let res_light = render_note_markdown(md, "light", None, None);
        assert!(res_light.html.contains("syntect-code"));
    }

    #[test]
    fn test_render_mermaid_fence_skips_syntax_highlighting() {
        let md = "```mermaid\ngraph TD;\n  A-->B;\n```";
        let res = render_note_markdown(md, "dark", None, None);
        assert!(res.html.contains("<pre class=\"mermaid\">"));
        // Raw diagram source, HTML-escaped but not syntect-colorized (no `<span style=` runs,
        // no `syntect-code` class, no `data-lang` attribute — the class alone is the signal).
        assert!(!res.html.contains("syntect-code"));
        assert!(!res.html.contains("data-lang"));
        assert!(res.html.contains("A--&gt;B"));
    }

    #[test]
    fn test_render_mermaid_case_insensitive_and_trimmed_lang() {
        let md = "``` Mermaid \ngraph TD;\n```";
        let res = render_note_markdown(md, "dark", None, None);
        assert!(res.html.contains("<pre class=\"mermaid\">"));
    }

    #[test]
    fn test_render_non_mermaid_fence_still_highlighted() {
        let md = "```python\nprint('hi')\n```";
        let res = render_note_markdown(md, "dark", None, None);
        assert!(res.html.contains("syntect-code"));
        assert!(!res.html.contains("class=\"mermaid\""));
    }

    #[test]
    fn test_render_math_placeholders() {
        let md = r#"
Given $x + y = z$, we can compute:

$$
E = mc^2
$$

> **Note:** Whether `$...$` and `$$...$$` render as MathJax/KaTeX depends on the Markdown renderer.
"#;
        let res = render_note_markdown(md, "dark", None, None);
        eprintln!("RES HTML: {}", res.html);
        assert!(res
            .html
            .contains("<span class=\"flint-math-inline\" data-math=\"x + y = z\"></span>"));
        assert!(res
            .html
            .contains("<div class=\"flint-math-block\" data-math=\"E = mc^2\"></div>"));
        assert!(res.html.contains("<code>$...$</code>"));
        assert!(res.html.contains("<code>$$...$$</code>"));
        assert!(res.html.contains("<blockquote>"));
    }

    #[test]
    fn test_render_ammonia_sanitization_security() {
        let md = r#"
# Heading

<script>alert('pwned')</script>
<iframe src="https://evil.com"></iframe>
<a href="javascript:alert(1)">Evil Link</a>
<img src="x" onerror="alert(1)" />
<b onclick="alert(1)">Click</b>
"#;
        let res = render_note_markdown(md, "dark", None, None);
        assert!(!res.html.contains("<script"));
        assert!(!res.html.contains("alert('pwned')"));
        assert!(!res.html.contains("<iframe"));
        assert!(!res.html.contains("javascript:"));
        assert!(!res.html.contains("onerror"));
        assert!(!res.html.contains("onclick"));
    }

    #[test]
    fn test_render_image_resolution_and_missing_placeholder() {
        let dir = tempdir().unwrap();
        let root = dir.path();
        let images_dir = root.join("assets");
        fs::create_dir_all(&images_dir).unwrap();
        let test_img = images_dir.join("diagram.png");
        fs::write(&test_img, b"fake png").unwrap();

        let md = r#"
![Existing](./assets/diagram.png)
![Missing](./assets/nonexistent.png)
"#;
        let res = render_note_markdown(md, "dark", Some(root), Some("notes/test.md"));
        assert!(res.html.contains("asset://localhost"));
        assert!(res.html.contains("flint-missing-image"));
        assert!(res
            .html
            .contains("Missing image: <code>./assets/nonexistent.png</code>"));
    }

    #[test]
    fn test_render_specific_badge() {
        let md = r#"[![Build](https://img.shields.io/badge/build-passing-brightgreen)](https://example.com/ci)"#;
        let res = render_note_markdown(md, "dark", None, None);
        eprintln!("DEBUG_RENDERED_HTML: {}", res.html);
        assert!(res.html.contains("<img"));
        assert!(res.html.contains("img.shields.io"));
    }

    #[test]
    fn test_render_horizontal_rule() {
        let md = "Above\n\n---\n\nBelow";
        let res = render_note_markdown(md, "dark", None, None);
        assert!(res.html.contains("<hr"));
        assert!(res.html.contains("<p>Above</p>"));
        assert!(res.html.contains("<p>Below</p>"));
    }

    #[test]
    fn test_render_callout_note() {
        let md = "> [!note]\n> Heads up, this matters.\n";
        let res = render_note_markdown(md, "dark", None, None);
        assert!(res.html.contains("callout callout-note"));
        assert!(res.html.contains("Heads up, this matters."));
        assert!(!res.html.contains("[!note]"));
        assert!(!res.html.contains("<blockquote>"));
    }

    #[test]
    fn test_render_callout_unrecognized_type_still_renders() {
        let md = "> [!bogus]\n> Still shown.\n";
        let res = render_note_markdown(md, "dark", None, None);
        assert!(res.html.contains("class=\"callout\""));
        assert!(res.html.contains("Still shown."));
        assert!(!res.html.contains("[!bogus]"));
    }

    #[test]
    fn test_render_plain_blockquote_unaffected() {
        let md = "> Just a normal quote.\n";
        let res = render_note_markdown(md, "dark", None, None);
        assert!(res.html.contains("<blockquote>"));
        assert!(res.html.contains("Just a normal quote."));
        assert!(!res.html.contains("callout"));
    }

    #[test]
    fn test_render_comment_stripped_inline() {
        let md = "Visible text %%hidden secret%% more visible text.";
        let res = render_note_markdown(md, "dark", None, None);
        assert!(res.html.contains("Visible text"));
        assert!(res.html.contains("more visible text."));
        assert!(!res.html.contains("hidden secret"));
    }

    #[test]
    fn test_render_comment_stripped_across_linebreak() {
        let md = "Before %%line one\nline two%% after.";
        let res = render_note_markdown(md, "dark", None, None);
        assert!(res.html.contains("Before"));
        assert!(res.html.contains("after."));
        assert!(!res.html.contains("line one"));
        assert!(!res.html.contains("line two"));
    }

    #[test]
    fn test_render_comment_not_stripped_in_code_fence() {
        let md = "```\n%%kept literally%%\n```\n";
        let res = render_note_markdown(md, "dark", None, None);
        assert!(res.html.contains("%%kept literally%%"));
    }

    #[test]
    fn test_render_comment_not_stripped_in_inline_code() {
        let md = "Some `%%kept literally%%` text.";
        let res = render_note_markdown(md, "dark", None, None);
        assert!(res.html.contains("%%kept literally%%"));
    }

    #[test]
    fn test_render_inserted_math_block_matches_handtyped() {
        let inserted = "$$\n\n$$\n";
        let handtyped = "$$\n\n$$\n";
        let res_inserted = render_note_markdown(inserted, "dark", None, None);
        let res_handtyped = render_note_markdown(handtyped, "dark", None, None);
        assert_eq!(res_inserted.html, res_handtyped.html);
        assert!(res_inserted.html.contains("flint-math-block"));
    }

    #[test]
    fn test_render_inserted_code_block_matches_handtyped() {
        let inserted = "```\n\n```\n";
        let handtyped = "```\n\n```\n";
        let res_inserted = render_note_markdown(inserted, "dark", None, None);
        let res_handtyped = render_note_markdown(handtyped, "dark", None, None);
        assert_eq!(res_inserted.html, res_handtyped.html);
        assert!(res_inserted.html.contains("syntect-code"));
    }
}
