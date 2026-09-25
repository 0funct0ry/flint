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

use crate::md_extensions::{parse_callout, strip_comments, CALLOUT_TYPES};
use crate::{extract_headings, parse_front_matter, HeadingItem};

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

/// Render Markdown note content to sanitized HTML and extract outline.
pub fn render_note_markdown(
    raw_content: &str,
    theme: &str,
    workspace_root: Option<&Path>,
    note_relative_path: Option<&str>,
) -> RenderResult {
    let (_fm_raw, body, _) = parse_front_matter(raw_content);
    let headings = extract_headings(raw_content);
    let is_dark = theme.eq_ignore_ascii_case("dark");

    let note_folder_abs = if let (Some(root), Some(rel)) = (workspace_root, note_relative_path) {
        let parent = Path::new(rel).parent().unwrap_or_else(|| Path::new(""));
        Some(root.join(parent))
    } else {
        None
    };

    let body_without_comments = strip_comments(body);
    let (protected_body, math_spans) = protect_math(&body_without_comments);

    let mut options = Options::empty();
    options.insert(Options::ENABLE_TABLES);
    options.insert(Options::ENABLE_FOOTNOTES);
    options.insert(Options::ENABLE_STRIKETHROUGH);
    options.insert(Options::ENABLE_TASKLISTS);
    options.insert(Options::ENABLE_SMART_PUNCTUATION);
    options.insert(Options::ENABLE_HEADING_ATTRIBUTES);

    let parser = Parser::new_ext(&protected_body, options);

    let mut custom_events = Vec::new();
    let mut in_code_block = false;
    let mut code_block_lang = String::new();
    let mut code_block_buf = String::new();

    let mut current_heading_level = None;
    let mut current_heading_text = String::new();
    let mut heading_iter = headings.iter();

    // Image state: collect alt text between Start(Image) and End(Image)
    let mut in_image = false;
    let mut image_alt_text = String::new();
    let mut image_resolved_url = String::new();
    let mut image_exists = false;
    let mut image_title = String::new();
    let mut image_dest_url = String::new();

    let mut blockquote_depth: i32 = 0;
    let mut blockquote_buffer: Vec<Event> = Vec::new();

    for event in parser {
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
                let highlighted = highlight_code(&code_block_buf, &code_block_lang, is_dark);
                custom_events.push(Event::Html(CowStr::Boxed(highlighted.into_boxed_str())));
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

                    // Use the anchor already assigned by extract_headings, so the
                    // rendered id matches the outline exactly even for duplicate
                    // heading text (both walk headings in the same document order).
                    let anchor = heading_iter
                        .next()
                        .map(|h| h.anchor.clone())
                        .unwrap_or_else(|| {
                            current_heading_text
                                .to_lowercase()
                                .chars()
                                .map(|ch| if ch.is_alphanumeric() { ch } else { '-' })
                                .collect::<String>()
                                .split('-')
                                .filter(|s| !s.is_empty())
                                .collect::<Vec<_>>()
                                .join("-")
                        });

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
                    let resolution = crate::resolve_link_target(root, source_rel, &raw_dest);
                    match resolution {
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
            Event::Start(Tag::Table(_)) => {
                custom_events.push(Event::Html(CowStr::Borrowed(
                    "<div class=\"table-container\" style=\"overflow-x:auto;\"><table>",
                )));
            }
            Event::End(TagEnd::Table) => {
                custom_events.push(Event::Html(CowStr::Borrowed("</table></div>")));
            }
            other => {
                if current_heading_level.is_none() && !in_image {
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
        assert!(res.html.contains("disabled"));
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
