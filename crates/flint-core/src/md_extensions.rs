//! Flint-specific Markdown extensions shared by the render pipeline and content search
//! (M10.05): Obsidian-style callouts (`> [!type]`) and comments (`%%...%%`).
//!
//! M10.23 adds wikilinks (`[[target]]`, `[[target|alias]]`, `[[target#heading]]`, `![[target]]`)
//! as a second, opt-in link syntax. `pulldown-cmark` has no `[[...]]` production, so this is a
//! preprocessing pass ([`rewrite_wikilinks`]) that runs at the same pipeline stage as
//! [`strip_comments`] — after front-matter strip, before the main parse — rewriting each
//! recognized span into an equivalent CommonMark inline link so the rest of the render pipeline
//! needs zero changes. [`scan_wikilink_spans`] is the single shared scanner both the rewrite and
//! `extract_links`/rename-rewriting call, so they never disagree about what a wikilink resolves
//! to.

/// Recognized callout types. The list is deliberately small and extensible; an unrecognized
/// type still renders as a styled blockquote rather than being dropped.
pub const CALLOUT_TYPES: &[&str] = &["note", "tip", "warning", "danger", "info"];

/// Parse the first line of a blockquote's content for a callout marker, e.g. `[!note] Heads up`.
/// Returns `(type, rest_of_line)` on match. `type` is not filtered against [`CALLOUT_TYPES`] here;
/// callers decide how to style an unrecognized type.
pub fn parse_callout(first_line: &str) -> Option<(&str, &str)> {
    let trimmed = first_line.trim_start();
    let rest = trimmed.strip_prefix("[!")?;
    let close = rest.find(']')?;
    let callout_type = &rest[..close];
    if callout_type.is_empty()
        || !callout_type
            .chars()
            .all(|c| c.is_alphanumeric() || c == '_')
    {
        return None;
    }
    let after = rest[close + 1..].trim_start();
    Some((callout_type, after))
}

/// Strip `%%...%%` comment spans from `input`, leaving code fences and inline code spans
/// untouched. Comments may span a line break; newline characters outside the delimiters are
/// preserved so downstream line numbers (e.g. content search) stay correct.
pub fn strip_comments(input: &str) -> String {
    let chars: Vec<char> = input.chars().collect();
    let len = chars.len();
    let mut out = String::with_capacity(input.len());
    let mut i = 0;
    let mut in_code_fence = false;

    while i < len {
        // Code fence toggle at line start.
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

        // Inline code span: skip untouched.
        if chars[i] == '`' {
            let mut backtick_count = 0;
            let mut k = i;
            while k < len && chars[k] == '`' {
                backtick_count += 1;
                k += 1;
            }

            let mut close_idx = None;
            let mut scan = k;
            while scan < len {
                if chars[scan] == '`' {
                    let m_start = scan;
                    let mut match_count = 0;
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

        // Comment span `%%...%%`, may span a line break.
        if chars[i] == '%' && i + 1 < len && chars[i + 1] == '%' {
            let mut j = i + 2;
            let mut found = false;
            while j + 1 < len {
                if chars[j] == '%' && chars[j + 1] == '%' {
                    found = true;
                    break;
                }
                j += 1;
            }

            if found {
                i = j + 2;
                continue;
            }
        }

        out.push(chars[i]);
        i += 1;
    }

    out
}

// ---------------------------------------------------------------------------------------------
// Wikilinks (M10.23)
// ---------------------------------------------------------------------------------------------

/// A single recognized `[[...]]` / `![[...]]` span found by [`scan_wikilink_spans`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WikilinkSpan {
    /// Byte offset of the start of the whole span (the `!` for an embed, otherwise the first
    /// `[`) in the scanned text.
    pub start: usize,
    /// Byte offset one past the closing `]]`.
    pub end: usize,
    /// The `target` portion, unescaped, verbatim as written (not resolved).
    pub target: String,
    /// The `#heading` portion, unescaped, if present.
    pub heading: Option<String>,
    /// The `|alias` portion, unescaped, if present.
    pub alias: Option<String>,
    /// Whether this was an embed span (`![[...]]`) rather than a plain link (`[[...]]`).
    pub is_embed: bool,
}

/// Split `s` on the first *unescaped* occurrence of `delim`, returning `(before, after)` with
/// escape sequences left intact (unescaping happens separately, once, over the whole matched
/// piece — see [`unescape_wikilink_text`]).
fn split_unescaped(s: &str, delim: char) -> (String, Option<String>) {
    let chars: Vec<char> = s.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        if chars[i] == '\\' && i + 1 < chars.len() {
            i += 2;
            continue;
        }
        if chars[i] == delim {
            let before: String = chars[..i].iter().collect();
            let after: String = chars[i + 1..].iter().collect();
            return (before, Some(after));
        }
        i += 1;
    }
    (s.to_string(), None)
}

/// Resolve `\|`, `\#`, `\[`, `\]` escapes to their literal character. No other escape sequence is
/// recognized — a backslash before any other character is left as a literal backslash.
fn unescape_wikilink_text(s: &str) -> String {
    let chars: Vec<char> = s.chars().collect();
    let mut out = String::with_capacity(s.len());
    let mut i = 0;
    while i < chars.len() {
        if chars[i] == '\\' && i + 1 < chars.len() && matches!(chars[i + 1], '|' | '#' | '[' | ']')
        {
            out.push(chars[i + 1]);
            i += 2;
        } else {
            out.push(chars[i]);
            i += 1;
        }
    }
    out
}

/// Scan `input` for `[[...]]` / `![[...]]` spans. A span starts at `[[` (or `![[`) and ends at
/// the next `]]` *on the same line* — wikilinks do not span newlines, and an unterminated `[[`
/// before end-of-line is left as literal text, same treatment as an unmatched `[` in CommonMark.
///
/// This scanner operates byte-wise on UTF-8 input: every delimiter it looks for (`\n`, `\\`, `[`,
/// `]`, `!`) is ASCII, and ASCII byte values never occur inside a multi-byte UTF-8 sequence, so
/// stepping one byte at a time past non-ASCII content is safe and all returned offsets land on
/// character boundaries.
pub fn scan_wikilink_spans(input: &str) -> Vec<WikilinkSpan> {
    let bytes = input.as_bytes();
    let len = bytes.len();
    let mut spans = Vec::new();
    let mut i = 0;

    while i < len {
        let is_embed =
            bytes[i] == b'!' && i + 2 < len && bytes[i + 1] == b'[' && bytes[i + 2] == b'[';
        let bracket_start = if is_embed { i + 1 } else { i };

        let is_open = bracket_start + 1 < len
            && bytes[bracket_start] == b'['
            && bytes[bracket_start + 1] == b'[';

        if !is_open {
            i += 1;
            continue;
        }

        let content_start = bracket_start + 2;
        let mut j = content_start;
        let mut close = None;
        while j < len {
            match bytes[j] {
                b'\n' => break,
                b'\\' if j + 1 < len && bytes[j + 1] != b'\n' => j += 2,
                b']' if j + 1 < len && bytes[j + 1] == b']' => {
                    close = Some(j);
                    break;
                }
                _ => j += 1,
            }
        }

        let Some(close_idx) = close else {
            i += 1;
            continue;
        };

        let content = &input[content_start..close_idx];
        let (target_and_heading, alias) = split_unescaped(content, '|');
        let (target, heading) = split_unescaped(&target_and_heading, '#');

        spans.push(WikilinkSpan {
            start: i,
            end: close_idx + 2,
            target: unescape_wikilink_text(target.trim()),
            heading: heading.map(|h| unescape_wikilink_text(h.trim())),
            alias: alias.map(|a| unescape_wikilink_text(a.trim())),
            is_embed,
        });

        i = close_idx + 2;
    }

    spans
}

/// URL scheme prefix used to mark a rewritten link's `dest_url` as wikilink-origin, so the render
/// pipeline's link handler knows to resolve it via bare-name lookup
/// ([`crate::resolve_wikilink_target`]) instead of the path-only [`crate::resolve_link_target`].
/// Never a real network scheme — Flint makes no network requests (SPEC §10.3.5); this string
/// never leaves the render pipeline's own `dest_url` handling.
pub const WIKILINK_DEST_SCHEME: &str = "flint-wikilink://";

/// Encode a wikilink span's `target`/`heading` into the placeholder `dest_url` used by
/// [`rewrite_wikilinks`]'s CommonMark output. Kept separate from the scheme constant so both the
/// rewrite and (in `render.rs`) the decode side share one format.
pub fn encode_wikilink_dest(target: &str, heading: Option<&str>) -> String {
    match heading {
        Some(h) if !h.is_empty() => format!("{WIKILINK_DEST_SCHEME}{target}#{h}"),
        _ => format!("{WIKILINK_DEST_SCHEME}{target}"),
    }
}

/// Decode a `dest_url` produced by [`encode_wikilink_dest`] back into `(target, heading)`.
/// Returns `None` if `dest_url` doesn't carry the wikilink scheme prefix.
pub fn decode_wikilink_dest(dest_url: &str) -> Option<(String, Option<String>)> {
    let rest = dest_url.strip_prefix(WIKILINK_DEST_SCHEME)?;
    let rest = rest.replace("%3C", "<").replace("%3E", ">");
    match rest.split_once('#') {
        Some((target, heading)) => Some((target.to_string(), Some(heading.to_string()))),
        None => Some((rest.to_string(), None)),
    }
}

/// URL scheme prefix used to mark a rewritten `![[target]]` embed span's `dest_url` distinctly
/// from a plain `[[target]]` wikilink (M10.24). `rewrite_wikilinks` emits embed spans as
/// CommonMark *image* syntax (`![label](<dest>)`) carrying this scheme so the render pipeline's
/// image event handler can tell "this is a transclusion" apart from a real image or a plain
/// internal link without re-parsing the source.
pub const WIKILINK_EMBED_DEST_SCHEME: &str = "flint-embed://";

/// Encode an embed span's `target`/`heading` into the placeholder `dest_url` used by
/// [`rewrite_wikilinks`]'s embed output. Mirrors [`encode_wikilink_dest`].
pub fn encode_wikilink_embed_dest(target: &str, heading: Option<&str>) -> String {
    match heading {
        Some(h) if !h.is_empty() => format!("{WIKILINK_EMBED_DEST_SCHEME}{target}#{h}"),
        _ => format!("{WIKILINK_EMBED_DEST_SCHEME}{target}"),
    }
}

/// Decode a `dest_url` produced by [`encode_wikilink_embed_dest`] back into `(target, heading)`.
/// Returns `None` if `dest_url` doesn't carry the embed scheme prefix. Mirrors
/// [`decode_wikilink_dest`].
pub fn decode_wikilink_embed_dest(dest_url: &str) -> Option<(String, Option<String>)> {
    let rest = dest_url.strip_prefix(WIKILINK_EMBED_DEST_SCHEME)?;
    let rest = rest.replace("%3C", "<").replace("%3E", ">");
    match rest.split_once('#') {
        Some((target, heading)) => Some((target.to_string(), Some(heading.to_string()))),
        None => Some((rest.to_string(), None)),
    }
}

/// Preprocessing pass: rewrite every recognized `[[...]]`/`![[...]]` span in `body` into an
/// equivalent CommonMark inline link (`![alt](dest)` for an embed, `[label](dest)` otherwise), so
/// the rest of the render pipeline (syntect highlighting, `ammonia` sanitize) needs zero changes.
/// `dest` is the [`encode_wikilink_dest`]-encoded placeholder, decoded and resolved later in
/// `render.rs`'s link/image event handling. The visible label/alt text is the alias when present,
/// otherwise the bare target text (heading dropped from the visible text either way, matching how
/// a Markdown link's visible label never repeats its URL fragment).
///
/// No-op (returns `body` unchanged) when `enabled` is `false` — `[[...]]` is then fully inert
/// literal text, per the opt-in default.
pub fn rewrite_wikilinks(body: &str, enabled: bool) -> String {
    if !enabled {
        return body.to_string();
    }

    let spans = scan_wikilink_spans(body);
    if spans.is_empty() {
        return body.to_string();
    }

    let mut out = String::with_capacity(body.len());
    let mut cursor = 0;
    for span in &spans {
        out.push_str(&body[cursor..span.start]);
        let label = span.alias.clone().unwrap_or_else(|| span.target.clone());
        // CommonMark's `(dest)` form forbids unescaped spaces/parens; note names routinely
        // contain spaces, so use the `<dest>` angle-bracket form instead, which permits them
        // (only `<` and `>` need escaping there).
        let escaped_label = label.replace('\\', "\\\\").replace(']', "\\]");
        if span.is_embed {
            // `![[target]]` is emitted as CommonMark *image* syntax carrying the distinct embed
            // scheme, so `render.rs`'s image event handler can recognize it as a transclusion
            // (M10.24) rather than a real image or a plain internal link.
            let dest = encode_wikilink_embed_dest(&span.target, span.heading.as_deref());
            let escaped_dest = dest.replace('<', "%3C").replace('>', "%3E");
            out.push_str(&format!("![{escaped_label}](<{escaped_dest}>)"));
        } else {
            let dest = encode_wikilink_dest(&span.target, span.heading.as_deref());
            let escaped_dest = dest.replace('<', "%3C").replace('>', "%3E");
            out.push_str(&format!("[{escaped_label}](<{escaped_dest}>)"));
        }
        cursor = span.end;
    }
    out.push_str(&body[cursor..]);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_callout_recognized() {
        assert_eq!(
            parse_callout("[!note] heads up"),
            Some(("note", "heads up"))
        );
        assert_eq!(parse_callout("[!warning]"), Some(("warning", "")));
    }

    #[test]
    fn parse_callout_unrecognized_type_still_parses() {
        // Callers decide styling; parsing itself doesn't filter against CALLOUT_TYPES.
        assert_eq!(parse_callout("[!bogus] text"), Some(("bogus", "text")));
        assert!(!CALLOUT_TYPES.contains(&"bogus"));
    }

    #[test]
    fn parse_callout_no_match() {
        assert_eq!(parse_callout("just a quote"), None);
    }

    #[test]
    fn strip_comments_inline() {
        assert_eq!(strip_comments("foo %%secret%% bar"), "foo  bar");
    }

    #[test]
    fn strip_comments_across_linebreak() {
        let input = "before %%line one\nline two%% after";
        assert_eq!(strip_comments(input), "before  after");
    }

    #[test]
    fn strip_comments_not_stripped_in_code_fence() {
        let input = "```\n%%kept%%\n```\n";
        assert_eq!(strip_comments(input), input);
    }

    #[test]
    fn strip_comments_not_stripped_in_inline_code() {
        let input = "text `%%kept%%` more";
        assert_eq!(strip_comments(input), input);
    }

    #[test]
    fn strip_comments_preserves_surrounding_newlines() {
        let input = "line one\n%%secret%%\nline three";
        let result = strip_comments(input);
        assert_eq!(result, "line one\n\nline three");
        assert_eq!(result.lines().count(), 3);
    }

    #[test]
    fn wikilink_scan_plain() {
        let spans = scan_wikilink_spans("see [[Target Note]] here");
        assert_eq!(spans.len(), 1);
        assert_eq!(spans[0].target, "Target Note");
        assert_eq!(spans[0].heading, None);
        assert_eq!(spans[0].alias, None);
        assert!(!spans[0].is_embed);
    }

    #[test]
    fn wikilink_scan_alias() {
        let spans = scan_wikilink_spans("[[Target|Alias Text]]");
        assert_eq!(spans[0].target, "Target");
        assert_eq!(spans[0].alias.as_deref(), Some("Alias Text"));
    }

    #[test]
    fn wikilink_scan_heading() {
        let spans = scan_wikilink_spans("[[Target#Some Heading]]");
        assert_eq!(spans[0].target, "Target");
        assert_eq!(spans[0].heading.as_deref(), Some("Some Heading"));
        assert_eq!(spans[0].alias, None);
    }

    #[test]
    fn wikilink_scan_heading_and_alias() {
        let spans = scan_wikilink_spans("[[Target#Heading|Alias]]");
        assert_eq!(spans[0].target, "Target");
        assert_eq!(spans[0].heading.as_deref(), Some("Heading"));
        assert_eq!(spans[0].alias.as_deref(), Some("Alias"));
    }

    #[test]
    fn wikilink_scan_embed() {
        let spans = scan_wikilink_spans("before ![[Target]] after");
        assert!(spans[0].is_embed);
        assert_eq!(spans[0].target, "Target");
        assert_eq!(spans[0].start, 7);
    }

    #[test]
    fn wikilink_scan_escapes() {
        let spans = scan_wikilink_spans(r"[[a\|b\#c\[d\]e]]");
        assert_eq!(spans[0].target, "a|b#c[d]e");
        assert_eq!(spans[0].heading, None);
        assert_eq!(spans[0].alias, None);
    }

    #[test]
    fn wikilink_scan_unterminated_is_not_a_span() {
        let spans = scan_wikilink_spans("this [[has no close on this line\nnext line");
        assert!(spans.is_empty());
    }

    #[test]
    fn wikilink_scan_does_not_span_newlines() {
        let spans = scan_wikilink_spans("[[foo\nbar]]");
        assert!(spans.is_empty());
    }

    #[test]
    fn wikilink_scan_multiple_on_one_line() {
        let spans = scan_wikilink_spans("[[One]] and [[Two]]");
        assert_eq!(spans.len(), 2);
        assert_eq!(spans[0].target, "One");
        assert_eq!(spans[1].target, "Two");
    }

    #[test]
    fn rewrite_wikilinks_disabled_is_inert() {
        let input = "see [[Target|Alias]] here";
        assert_eq!(rewrite_wikilinks(input, false), input);
    }

    #[test]
    fn rewrite_wikilinks_plain_link() {
        let out = rewrite_wikilinks("see [[Target Note]] here", true);
        assert_eq!(
            out,
            format!("see [Target Note](<{WIKILINK_DEST_SCHEME}Target Note>) here")
        );
    }

    #[test]
    fn rewrite_wikilinks_alias_and_heading() {
        let out = rewrite_wikilinks("[[Target#Heading|Alias]]", true);
        assert_eq!(
            out,
            format!("[Alias](<{WIKILINK_DEST_SCHEME}Target#Heading>)")
        );
    }

    #[test]
    fn rewrite_wikilinks_embed_uses_image_syntax_and_embed_scheme() {
        // M10.24: `![[target]]` rewrites to CommonMark image syntax carrying the distinct embed
        // scheme, so render.rs's image handler can recognize it as a transclusion.
        let out = rewrite_wikilinks("![[Target]]", true);
        assert_eq!(
            out,
            format!("![Target](<{WIKILINK_EMBED_DEST_SCHEME}Target>)")
        );
    }

    #[test]
    fn decode_wikilink_embed_dest_round_trips() {
        let dest = encode_wikilink_embed_dest("Target", Some("Heading"));
        assert_eq!(
            decode_wikilink_embed_dest(&dest),
            Some(("Target".to_string(), Some("Heading".to_string())))
        );
        assert_eq!(decode_wikilink_embed_dest("flint-wikilink://Target"), None);
    }

    #[test]
    fn decode_wikilink_dest_round_trips() {
        let dest = encode_wikilink_dest("My Note", Some("A Heading"));
        assert_eq!(
            decode_wikilink_dest(&dest),
            Some(("My Note".to_string(), Some("A Heading".to_string())))
        );
        let dest_no_heading = encode_wikilink_dest("My Note", None);
        assert_eq!(
            decode_wikilink_dest(&dest_no_heading),
            Some(("My Note".to_string(), None))
        );
        assert_eq!(decode_wikilink_dest("not-a-wikilink"), None);
    }

    use proptest::{prop_assert_eq, proptest};

    proptest! {
        #[test]
        fn wikilink_scan_never_panics_on_arbitrary_input(s in ".*") {
            let _ = scan_wikilink_spans(&s);
        }

        #[test]
        fn wikilink_scan_escaped_delimiters_never_split_span(
            target in "[a-zA-Z0-9]{1,10}",
            heading in "[a-zA-Z0-9]{1,10}",
            alias in "[a-zA-Z0-9]{1,10}",
        ) {
            // Escaping every delimiter character inside each segment must round-trip through
            // scan+unescape back to the original unescaped text, regardless of what those
            // segments contain (as long as they don't themselves contain the raw delimiters).
            let escaped = format!(
                "[[{}#{}|{}]]",
                target.replace('|', "\\|").replace('#', "\\#"),
                heading.replace('|', "\\|").replace('#', "\\#"),
                alias.replace('|', "\\|").replace('#', "\\#"),
            );
            let spans = scan_wikilink_spans(&escaped);
            prop_assert_eq!(spans.len(), 1);
            prop_assert_eq!(&spans[0].target, &target);
            prop_assert_eq!(spans[0].heading.as_deref(), Some(heading.as_str()));
            prop_assert_eq!(spans[0].alias.as_deref(), Some(alias.as_str()));
        }
    }
}
