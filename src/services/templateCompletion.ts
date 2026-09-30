import { Completion, CompletionContext, CompletionResult } from '@codemirror/autocomplete';
import { EditorView } from '@codemirror/view';

/** The fixed set of pipe transforms `render_template` understands (M10.27 follow-up) — kept in
 * sync with `flint_core::template`'s transform table by hand, the same way this file's sibling
 * completion source (`linkCompletionSource` in `CenterPane.tsx`) mirrors backend behavior rather
 * than importing it (there is no shared TS/Rust schema in this codebase). */
const PIPE_FUNCTIONS = [
  'slug',
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

/** Pipes that take arguments: accepting one leaves the cursor after the `:` ready for the value. */
const PIPE_FUNCTIONS_WITH_ARGS = ['truncate:', 'pad:', 'replace:', 'default:'];

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
 * Autocomplete for template placeholders, following the exact structural pattern
 * `linkCompletionSource` (`CenterPane.tsx`) uses: a manual regex match against the text before the
 * cursor rather than `autocompletion`'s built-in trigger-char config, so multiple distinct trigger
 * shapes can be checked in one source with an explicit priority order.
 *
 * Two trigger shapes, both scoped to *inside* an unclosed `{{...}}` span (checked via `openBrace`
 * below so this never fires on ordinary `{`/`|` text elsewhere in the body):
 * - `{{` (optionally with a partially-typed name) → `date`/`date:FORMAT`/`time`/`title`/`path`/
 *   `var:<declared variable>`, each closing the span with `}}` on accept (except `date:FORMAT`,
 *   which leaves the cursor positioned to type the format).
 * - `|` right after a placeholder name inside `{{...}}` → the fixed pipe-function list, left open
 *   (no forced `}}`) so a chained `|anotherFn` or a manually-typed `}}` both stay easy.
 */
export function createTemplatePlaceholderCompletionSource(getVariableNames: () => string[]) {
  return (context: CompletionContext): CompletionResult | null => {
    const line = context.state.doc.lineAt(context.pos);
    const lineBefore = line.text.slice(0, context.pos - line.from);

    // Is the cursor inside an unclosed `{{...}}` span on this line? (A `}}` after the last `{{`
    // would mean the span already closed before the cursor.)
    const openBrace = lineBefore.lastIndexOf('{{');
    if (openBrace === -1) return null;
    const insideSpan = lineBefore.slice(openBrace + 2);
    if (insideSpan.includes('}}')) return null;

    const pipeMatch = /\|(\w*)$/.exec(insideSpan);
    if (pipeMatch) {
      const typed = pipeMatch[1];
      const from = context.pos - typed.length;
      return {
        from,
        options: [
          ...PIPE_FUNCTIONS.map((fn) => ({
            label: fn,
            type: 'function',
            apply: fn,
          })),
          ...PIPE_FUNCTIONS_WITH_ARGS.map((fn) => ({
            label: `${fn}ARG`,
            type: 'function',
            apply: fn,
          })),
        ],
      };
    }

    // Only offer the placeholder-name list when nothing but the name itself has been typed so far
    // (no `|` or `:` yet) — once a modifier/pipe has started, name completion no longer applies.
    const nameMatch = /^(\w*)$/.exec(insideSpan);
    if (!nameMatch) return null;
    const typed = nameMatch[1];
    const from = context.pos - typed.length;

    const variableOptions = getVariableNames().map((name) => ({
      label: `var:${name}`,
      detail: 'declared variable',
      type: 'variable',
      apply: `var:${name}}}`,
    }));

    return {
      from,
      options: [
        { label: 'title', detail: "the note's title", type: 'keyword', apply: 'title}}' },
        { label: 'path', detail: "the note's workspace-relative path", type: 'keyword', apply: 'path}}' },
        { label: 'date', detail: 'today, YYYY-MM-DD', type: 'keyword', apply: 'date}}' },
        {
          label: 'date:FORMAT',
          detail: 'e.g. DD/MM/YYYY',
          type: 'keyword',
          apply: applyAndPlaceCursor('date:}}', 2),
        },
        { label: 'time', detail: 'HH:mm', type: 'keyword', apply: 'time}}' },
        { label: 'weekday', detail: 'e.g. Monday', type: 'keyword', apply: 'weekday}}' },
        { label: 'quarter', detail: 'e.g. Q3', type: 'keyword', apply: 'quarter}}' },
        { label: 'isoweek', detail: 'e.g. W40', type: 'keyword', apply: 'isoweek}}' },
        { label: 'uuid', detail: 'random UUID', type: 'keyword', apply: 'uuid}}' },
        { label: 'parentfolder', detail: "the note's folder name", type: 'keyword', apply: 'parentfolder}}' },
        { label: 'workspacename', detail: 'workspace directory name', type: 'keyword', apply: 'workspacename}}' },
        {
          label: 'seq:PREFIX:WIDTH',
          detail: 'auto-increment, e.g. T0001',
          type: 'keyword',
          apply: applyAndPlaceCursor('seq::4}}', 5),
        },
        {
          label: 'nestseq:LEVELS',
          detail: 'nested counter, e.g. 01.01.02',
          type: 'keyword',
          apply: applyAndPlaceCursor('nestseq:3}}', 3),
        },
        {
          label: 'regex:PATTERN',
          detail: 'random ID, e.g. [A-Z]{2}\\d{3}',
          type: 'keyword',
          apply: applyAndPlaceCursor('regex:}}', 2),
        },
        {
          label: 'regexseq:PATTERN',
          detail: 'sequential ID, e.g. REQ-\\d{3}',
          type: 'keyword',
          apply: applyAndPlaceCursor('regexseq:}}', 2),
        },
        { label: 'linkto:PATH', detail: 'link to another note', type: 'keyword', apply: applyAndPlaceCursor('linkto:}}', 2) },
        { label: 'relativepath:PATH', detail: 'relative path to a note', type: 'keyword', apply: applyAndPlaceCursor('relativepath:}}', 2) },
        { label: 'frontmatter:PATH#KEY', detail: "another note's field", type: 'keyword', apply: applyAndPlaceCursor('frontmatter:}}', 2) },
        ...variableOptions,
      ],
    };
  };
}
