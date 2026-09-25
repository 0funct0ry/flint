//! Flint-specific Markdown extensions shared by the render pipeline and content search
//! (M10.05): Obsidian-style callouts (`> [!type]`) and comments (`%%...%%`).

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
}
