//! Generator helpers for the template engine (M10.27): text/case pipe transforms, relative date
//! offsets, the constrained regex-pattern subset behind `{{regex:...}}`/`{{regexseq:...}}`, and
//! nested-sequence counter math. Pure logic — persistent counter state lives behind the
//! [`crate::template::SequenceStore`] trait, never here.

use chrono::{DateTime, Datelike, Duration as ChronoDuration, Local, Months};
use rand::Rng;

// ---------------------------------------------------------------------------------------------
// Text / case pipes
// ---------------------------------------------------------------------------------------------

/// Split into lowercase-able words on non-alphanumerics and camelCase boundaries.
fn split_words(value: &str) -> Vec<String> {
    let mut words = Vec::new();
    let mut cur = String::new();
    let mut prev_lower = false;
    for c in value.chars() {
        if !c.is_alphanumeric() {
            if !cur.is_empty() {
                words.push(std::mem::take(&mut cur));
            }
            prev_lower = false;
            continue;
        }
        if c.is_uppercase() && prev_lower && !cur.is_empty() {
            words.push(std::mem::take(&mut cur));
        }
        prev_lower = c.is_lowercase();
        cur.push(c);
    }
    if !cur.is_empty() {
        words.push(cur);
    }
    words
}

fn upper_first(word: &str) -> String {
    let mut chars = word.chars();
    match chars.next() {
        Some(f) => f.to_uppercase().collect::<String>() + &chars.as_str().to_lowercase(),
        None => String::new(),
    }
}

/// Apply one pipe transform. `args` are the `:`-separated arguments after the helper name. An
/// unknown helper (or unusable argument) passes `value` through unchanged — never drops content.
pub fn apply_transform(fn_name: &str, args: &[&str], value: &str) -> String {
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
        "capitalize" => upper_first(value),
        "titlecase" => value
            .split(' ')
            .map(upper_first)
            .collect::<Vec<_>>()
            .join(" "),
        "kebab" => split_words(value)
            .iter()
            .map(|w| w.to_lowercase())
            .collect::<Vec<_>>()
            .join("-"),
        "snake" => split_words(value)
            .iter()
            .map(|w| w.to_lowercase())
            .collect::<Vec<_>>()
            .join("_"),
        "truncate" => match args.first().and_then(|a| a.trim().parse::<usize>().ok()) {
            Some(n) => value.chars().take(n).collect(),
            None => value.to_string(),
        },
        // Left-pad with zeros to width N (`7|pad:3` -> `007`).
        "pad" => match args.first().and_then(|a| a.trim().parse::<usize>().ok()) {
            Some(n) => {
                let len = value.chars().count();
                if len >= n {
                    value.to_string()
                } else {
                    "0".repeat(n - len) + value
                }
            }
            None => value.to_string(),
        },
        "replace" => match args {
            [from, to, ..] if !from.is_empty() => value.replace(from, to),
            [from] if !from.is_empty() => value.replace(from, ""),
            _ => value.to_string(),
        },
        "default" => {
            if value.trim().is_empty() {
                args.join(":")
            } else {
                value.to_string()
            }
        }
        "initials" => split_words(value)
            .iter()
            .filter_map(|w| w.chars().next())
            .flat_map(|c| c.to_uppercase())
            .collect(),
        "wordcount" => value.split_whitespace().count().to_string(),
        "charcount" => value.chars().count().to_string(),
        _ => value.to_string(),
    }
}

// ---------------------------------------------------------------------------------------------
// Date offsets and calendar helpers
// ---------------------------------------------------------------------------------------------

/// Shift `now` by an offset string such as `+7`, `-5`, `+2w`, `-1mo`, `+1y`, `+3d` (bare numbers
/// are days). Returns `None` for an unrecognized unit. Month/year math clamps the day-of-month
/// (Jan 31 + 1mo = Feb 28/29).
pub fn shift_date(now: DateTime<Local>, offset: &str) -> Option<DateTime<Local>> {
    let sign: i64 = match offset.chars().next()? {
        '+' => 1,
        '-' => -1,
        _ => return None,
    };
    let rest = &offset[1..];
    let digits_end = rest
        .find(|c: char| !c.is_ascii_digit())
        .unwrap_or(rest.len());
    let n: i64 = rest[..digits_end].parse().ok()?;
    let unit = &rest[digits_end..];
    let signed = sign * n;
    let by_months = |months: i64| -> Option<DateTime<Local>> {
        let m = Months::new(u32::try_from(months.unsigned_abs()).ok()?);
        if months >= 0 {
            now.checked_add_months(m)
        } else {
            now.checked_sub_months(m)
        }
    };
    match unit {
        "" | "d" => now.checked_add_signed(ChronoDuration::try_days(signed)?),
        "w" => now.checked_add_signed(ChronoDuration::try_weeks(signed)?),
        "mo" => by_months(signed),
        "y" => by_months(signed.checked_mul(12)?),
        _ => None,
    }
}

pub fn weekday_name(now: &DateTime<Local>) -> &'static str {
    use chrono::Weekday::*;
    match now.weekday() {
        Mon => "Monday",
        Tue => "Tuesday",
        Wed => "Wednesday",
        Thu => "Thursday",
        Fri => "Friday",
        Sat => "Saturday",
        Sun => "Sunday",
    }
}

/// `Q1`..`Q4`.
pub fn quarter_label(now: &DateTime<Local>) -> String {
    format!("Q{}", (now.month() - 1) / 3 + 1)
}

/// ISO-8601 week, e.g. `W39`.
pub fn iso_week_label(now: &DateTime<Local>) -> String {
    format!("W{:02}", now.iso_week().week())
}

// ---------------------------------------------------------------------------------------------
// Constrained regex-pattern subset
// ---------------------------------------------------------------------------------------------

const MAX_REPEAT: usize = 64;

#[derive(Debug, Clone, PartialEq, Eq)]
struct PatternItem {
    chars: Vec<char>,
    min: usize,
    max: usize,
}

impl PatternItem {
    fn is_numeric(&self) -> bool {
        self.chars.len() == 10 && self.chars.iter().all(|c| c.is_ascii_digit())
    }
}

/// A parsed pattern in the supported subset: literals, escapes (`\d`, `\w`, `\\.`), character
/// classes (`[A-Z0-9_]`), and `{n}`/`{n,m}` repeats. Full regex (alternation, groups, `* + ?`) is
/// deliberately rejected — reversing it is undecidable in general.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Pattern {
    items: Vec<PatternItem>,
}

fn digits() -> Vec<char> {
    ('0'..='9').collect()
}

fn word_chars() -> Vec<char> {
    ('a'..='z')
        .chain('A'..='Z')
        .chain('0'..='9')
        .chain(std::iter::once('_'))
        .collect()
}

impl Pattern {
    pub fn parse(src: &str) -> Option<Pattern> {
        let chars: Vec<char> = src.chars().collect();
        let mut items: Vec<PatternItem> = Vec::new();
        let mut i = 0;
        while i < chars.len() {
            match chars[i] {
                '\\' => {
                    let esc = *chars.get(i + 1)?;
                    let set = match esc {
                        'd' => digits(),
                        'w' => word_chars(),
                        c if c.is_alphanumeric() => return None,
                        c => vec![c],
                    };
                    items.push(PatternItem {
                        chars: set,
                        min: 1,
                        max: 1,
                    });
                    i += 2;
                }
                '[' => {
                    let close = chars[i + 1..].iter().position(|&c| c == ']')? + i + 1;
                    let body = &chars[i + 1..close];
                    if body.is_empty() {
                        return None;
                    }
                    let mut set = Vec::new();
                    let mut j = 0;
                    while j < body.len() {
                        if j + 2 < body.len() && body[j + 1] == '-' {
                            let (a, b) = (body[j], body[j + 2]);
                            if a > b {
                                return None;
                            }
                            set.extend(a..=b);
                            j += 3;
                        } else {
                            set.push(body[j]);
                            j += 1;
                        }
                    }
                    set.dedup();
                    items.push(PatternItem {
                        chars: set,
                        min: 1,
                        max: 1,
                    });
                    i = close + 1;
                }
                '{' => {
                    let close = chars[i + 1..].iter().position(|&c| c == '}')? + i + 1;
                    let body: String = chars[i + 1..close].iter().collect();
                    let (min, max) = match body.split_once(',') {
                        Some((a, b)) => (a.trim().parse().ok()?, b.trim().parse().ok()?),
                        None => {
                            let n: usize = body.trim().parse().ok()?;
                            (n, n)
                        }
                    };
                    if min > max || max > MAX_REPEAT {
                        return None;
                    }
                    let last = items.last_mut()?;
                    if last.min != 1 || last.max != 1 {
                        return None; // already repeated
                    }
                    last.min = min;
                    last.max = max;
                    i = close + 1;
                }
                '*' | '+' | '?' | '|' | '(' | ')' | '.' | '^' | '$' | ']' | '}' => return None,
                c => {
                    items.push(PatternItem {
                        chars: vec![c],
                        min: 1,
                        max: 1,
                    });
                    i += 1;
                }
            }
        }
        if items.is_empty() {
            return None;
        }
        Some(Pattern { items })
    }

    /// A random string matching the pattern.
    pub fn generate(&self) -> String {
        let mut rng = rand::thread_rng();
        let mut out = String::new();
        for item in &self.items {
            let count = if item.min == item.max {
                item.min
            } else {
                rng.gen_range(item.min..=item.max)
            };
            for _ in 0..count {
                out.push(item.chars[rng.gen_range(0..item.chars.len())]);
            }
        }
        out
    }

    /// The `n`th (1-based) string of the pattern: its first numeric run holds `n` zero-padded to
    /// the run's (maximum) width; every other item is deterministic (its first character).
    /// `None` when the pattern has no numeric run or `n` no longer fits.
    pub fn sequence(&self, n: u64) -> Option<String> {
        let idx = self.items.iter().position(|it| it.is_numeric())?;
        let mut out = String::new();
        for (k, item) in self.items.iter().enumerate() {
            if k == idx {
                let width = item.max;
                let s = n.to_string();
                if s.len() > width {
                    return None;
                }
                out.push_str(&"0".repeat(width - s.len()));
                out.push_str(&s);
            } else {
                for _ in 0..item.min {
                    out.push(item.chars[0]);
                }
            }
        }
        Some(out)
    }
}

// ---------------------------------------------------------------------------------------------
// Nested sequences
// ---------------------------------------------------------------------------------------------

/// Advance an ordered counter-path: increment level `bump` (0-based) and reset every deeper level
/// to 1. A fresh (empty or short) path is padded with 1s first, so the first result of
/// `advance_path([], 3, 2)` is `[1, 1, 1]`.
pub fn advance_path(current: &[u64], levels: usize, bump: usize) -> Vec<u64> {
    let mut path: Vec<u64> = current.iter().copied().take(levels).collect();
    let fresh = path.is_empty();
    path.resize(levels, 1);
    if fresh {
        return path;
    }
    let bump = bump.min(levels - 1);
    path[bump] += 1;
    for v in path.iter_mut().skip(bump + 1) {
        *v = 1;
    }
    path
}

pub fn format_path(path: &[u64]) -> String {
    path.iter()
        .map(|n| format!("{n:02}"))
        .collect::<Vec<_>>()
        .join(".")
}

/// A random v4 UUID.
pub fn uuid_v4() -> String {
    let mut b: [u8; 16] = rand::thread_rng().gen();
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    let h: String = b.iter().map(|x| format!("{x:02x}")).collect();
    format!(
        "{}-{}-{}-{}-{}",
        &h[..8],
        &h[8..12],
        &h[12..16],
        &h[16..20],
        &h[20..]
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    fn at(y: i32, m: u32, d: u32) -> DateTime<Local> {
        Local.with_ymd_and_hms(y, m, d, 8, 0, 0).unwrap()
    }

    #[test]
    fn case_transforms() {
        assert_eq!(
            apply_transform("capitalize", &[], "hELLO wORLD"),
            "Hello world"
        );
        assert_eq!(
            apply_transform("titlecase", &[], "hello big world"),
            "Hello Big World"
        );
        assert_eq!(
            apply_transform("kebab", &[], "helloWorld Foo_bar"),
            "hello-world-foo-bar"
        );
        assert_eq!(apply_transform("snake", &[], "Hello World"), "hello_world");
        assert_eq!(apply_transform("initials", &[], "ada lovelace"), "AL");
    }

    #[test]
    fn arg_transforms() {
        assert_eq!(apply_transform("truncate", &["3"], "abcdef"), "abc");
        assert_eq!(apply_transform("truncate", &["x"], "abcdef"), "abcdef");
        assert_eq!(apply_transform("pad", &["4"], "7"), "0007");
        assert_eq!(apply_transform("pad", &["1"], "77"), "77");
        assert_eq!(apply_transform("replace", &["a", "o"], "banana"), "bonono");
        assert_eq!(apply_transform("default", &["n/a"], "  "), "n/a");
        assert_eq!(apply_transform("default", &["n/a"], "x"), "x");
        assert_eq!(apply_transform("wordcount", &[], "a b  c"), "3");
        assert_eq!(apply_transform("charcount", &[], "héllo"), "5");
        assert_eq!(apply_transform("bogus", &[], "x"), "x");
    }

    #[test]
    fn date_shifts() {
        let d = at(2026, 1, 31);
        assert_eq!(
            shift_date(d, "+2w").unwrap().date_naive().to_string(),
            "2026-02-14"
        );
        assert_eq!(
            shift_date(d, "+1mo").unwrap().date_naive().to_string(),
            "2026-02-28"
        );
        assert_eq!(
            shift_date(d, "-1mo").unwrap().date_naive().to_string(),
            "2025-12-31"
        );
        assert_eq!(
            shift_date(d, "+1y").unwrap().date_naive().to_string(),
            "2027-01-31"
        );
        assert_eq!(
            shift_date(d, "+3").unwrap().date_naive().to_string(),
            "2026-02-03"
        );
        assert!(shift_date(d, "+3zz").is_none());
    }

    #[test]
    fn calendar_labels() {
        let d = at(2026, 9, 28);
        assert_eq!(weekday_name(&d), "Monday");
        assert_eq!(quarter_label(&d), "Q3");
        assert_eq!(iso_week_label(&d), "W40");
        assert_eq!(iso_week_label(&at(2026, 1, 1)), "W01");
        assert_eq!(quarter_label(&at(2026, 1, 1)), "Q1");
    }

    #[test]
    fn pattern_sequence() {
        let p = Pattern::parse(r"REQ-\d{3}").unwrap();
        assert_eq!(p.sequence(1).unwrap(), "REQ-001");
        assert_eq!(p.sequence(42).unwrap(), "REQ-042");
        assert!(p.sequence(1000).is_none());
        assert!(Pattern::parse(r"[A-Z]{3}").unwrap().sequence(1).is_none());
    }

    #[test]
    fn pattern_random_matches_shape() {
        let p = Pattern::parse(r"ID-[A-C]{2}\d{2,4}").unwrap();
        let re = regex::Regex::new(r"^ID-[A-C]{2}\d{2,4}$").unwrap();
        for _ in 0..50 {
            assert!(re.is_match(&p.generate()));
        }
    }

    #[test]
    fn pattern_rejects_unsupported() {
        for bad in [
            "a+",
            "a|b",
            "(a)",
            "a*",
            "",
            r"\q",
            "[z-a]",
            "{3}",
            r"\d{9999}",
            "a{2}{3}",
        ] {
            assert!(Pattern::parse(bad).is_none(), "{bad}");
        }
    }

    #[test]
    fn nested_path_resets_children() {
        assert_eq!(advance_path(&[], 3, 2), vec![1, 1, 1]);
        assert_eq!(advance_path(&[1, 1, 1], 3, 2), vec![1, 1, 2]);
        assert_eq!(advance_path(&[1, 1, 2], 3, 1), vec![1, 2, 1]);
        assert_eq!(advance_path(&[1, 2, 5], 3, 0), vec![2, 1, 1]);
        assert_eq!(format_path(&[1, 2, 10]), "01.02.10");
    }

    #[test]
    fn uuid_shape() {
        let u = uuid_v4();
        assert_eq!(u.len(), 36);
        assert_eq!(&u[14..15], "4");
    }
}
