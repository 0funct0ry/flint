import { Completion, CompletionContext, CompletionResult } from '@codemirror/autocomplete';
import { EditorView } from '@codemirror/view';

/** Filters `render_template` (Tera, M10.29) understands — the built-ins Flint keeps plus the ones
 * it registers from `flint_core::template_gen`. Kept in sync with Rust by hand, the same way this
 * file's sibling completion source (`linkCompletionSource` in `CenterPane.tsx`) mirrors backend
 * behavior rather than importing it (there is no shared TS/Rust schema in this codebase). */
const FILTERS = [
  'slugify',
  'upper',
  'lower',
  'trim',
  'capitalize',
  'titlecase',
  'kebab',
  'snake',
  'initials',
  'wordcount',
  'charcount',
];

/** Filters that take keyword arguments: accepting one leaves the cursor inside the parentheses. */
const FILTERS_WITH_ARGS: { label: string; apply: string; cursorOffsetFromEnd: number }[] = [
  { label: 'truncate(length=N)', apply: 'truncate(length=)', cursorOffsetFromEnd: 1 },
  { label: 'pad(width=N)', apply: 'pad(width=)', cursorOffsetFromEnd: 1 },
  { label: 'replace(from, to)', apply: 'replace(from="", to="")', cursorOffsetFromEnd: 9 },
  { label: 'default(value)', apply: 'default(value="")', cursorOffsetFromEnd: 2 },
];

/** Statement keywords offered after `{%`. */
const STATEMENTS: { label: string; apply: string; detail: string }[] = [
  { label: 'for', apply: 'for i in range(end=3) %}', detail: 'loop' },
  { label: 'endfor', apply: 'endfor %}', detail: 'close a loop' },
  { label: 'if', apply: 'if  %}', detail: 'conditional' },
  { label: 'elif', apply: 'elif  %}', detail: 'else-if branch' },
  { label: 'else', apply: 'else %}', detail: 'else branch' },
  { label: 'endif', apply: 'endif %}', detail: 'close a conditional' },
  { label: 'set', apply: 'set  = ', detail: 'assign a local' },
];

/** Insert `text` in place of the completed range, then move the cursor to `text.length -
 * cursorOffsetFromEnd`. Used for `date:FORMAT`, where accepting the completion should leave the
 * cursor ready to type the format rather than after it. */
function applyAndPlaceCursor(text: string, cursorOffsetFromEnd: number) {
  return (view: EditorView, _completion: Completion, from: number, to: number) => {
    view.dispatch({
      changes: { from, to, insert: text },
      selection: { anchor: from + text.length - cursorOffsetFromEnd },
    });
  };
}

/**
 * Autocomplete for Tera template syntax (M10.29), following the structural pattern
 * `linkCompletionSource` (`CenterPane.tsx`) uses: a manual regex match against the text before the
 * cursor. Three trigger shapes, each scoped to *inside* an unclosed span on the current line:
 * - `{{ ` → variables (`title`, `path`, `folder`, `var.<declared>`) and functions (`date()`, `seq()`, …)
 * - `|` inside `{{ … }}` → filters
 * - `{%` → statements (`for`/`if`/`set`/`end…`)
 */
export function createTemplatePlaceholderCompletionSource(getVariableNames: () => string[]) {
  return (context: CompletionContext): CompletionResult | null => {
    const line = context.state.doc.lineAt(context.pos);
    const lineBefore = line.text.slice(0, context.pos - line.from);

    // `{% keyword` — open statement (no closing `%}` yet).
    const stmtOpen = lineBefore.lastIndexOf('{%');
    if (stmtOpen !== -1 && !lineBefore.slice(stmtOpen).includes('%}')) {
      const m = /^\{%-?\s*(\w*)$/.exec(lineBefore.slice(stmtOpen));
      if (!m) return null;
      const from = context.pos - m[1].length;
      return {
        from,
        options: STATEMENTS.map((st) => ({
          label: st.label,
          detail: st.detail,
          type: 'keyword',
          apply: st.apply,
        })),
      };
    }

    const openBrace = lineBefore.lastIndexOf('{{');
    if (openBrace === -1) return null;
    const insideSpan = lineBefore.slice(openBrace + 2);
    if (insideSpan.includes('}}')) return null;

    const pipeMatch = /\|\s*(\w*)$/.exec(insideSpan);
    if (pipeMatch) {
      const from = context.pos - pipeMatch[1].length;
      return {
        from,
        options: [
          ...FILTERS.map((fn) => ({ label: fn, type: 'function', apply: fn })),
          ...FILTERS_WITH_ARGS.map((f) => ({
            label: f.label,
            type: 'function',
            apply: applyAndPlaceCursor(f.apply, f.cursorOffsetFromEnd),
          })),
        ],
      };
    }

    // Name completion only while the identifier itself is being typed (`var.pri` included).
    const nameMatch = /^\s*([\w.]*)$/.exec(insideSpan);
    if (!nameMatch) return null;
    const from = context.pos - nameMatch[1].length;

    const variableOptions = getVariableNames().map((name) => ({
      label: `var.${name}`,
      detail: 'declared variable',
      type: 'variable',
      apply: `var.${name} }}`,
    }));
    const fn = (label: string, detail: string, args: string, cursorBack: number) => ({
      label: `${label}()`,
      detail,
      type: 'function',
      apply: applyAndPlaceCursor(`${label}(${args}) }}`, cursorBack),
    });

    return {
      from,
      options: [
        { label: 'title', detail: "the note's title", type: 'keyword', apply: 'title }}' },
        { label: 'path', detail: "the note's workspace-relative path", type: 'keyword', apply: 'path }}' },
        { label: 'folder', detail: "the note's folder path", type: 'keyword', apply: 'folder }}' },
        fn('date', 'today; offset="+2w", fmt="YYYY-MM-DD"', '', 4),
        fn('time', 'HH:mm', '', 4),
        fn('weekday', 'e.g. Monday', '', 4),
        fn('quarter', 'e.g. Q3', '', 4),
        fn('isoweek', 'e.g. W40', '', 4),
        fn('uuid', 'random UUID', '', 4),
        fn('parentfolder', "the note's folder name", '', 4),
        fn('workspacename', 'workspace directory name', '', 4),
        fn('seq', 'auto-increment, e.g. T0001', 'prefix="", width=4', 14),
        fn('nestseq', 'nested counter, e.g. 01.01.02', 'levels=3', 5),
        fn('regex', 'random ID, e.g. [A-Z]{2}\\d{3}', 'pattern=""', 5),
        fn('regexseq', 'sequential ID, e.g. REQ-\\d{3}', 'pattern=""', 5),
        fn('linkto', 'link to another note', 'path=""', 5),
        fn('relativepath', 'relative path to a note', 'to=""', 5),
        fn('frontmatter', "another note's field", 'path="", key=""', 13),
        ...variableOptions,
      ],
    };
  };
}
