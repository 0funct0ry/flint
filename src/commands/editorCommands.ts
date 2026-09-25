/**
 * M10.05 — Editor context menu commands.
 *
 * Every function here is a CodeMirror `Command` (`(view: EditorView) => boolean`) so it can be
 * used directly as a keymap binding, a `CommandRegistry` handler, and a `ContextMenu` item's
 * `onClick` — one implementation, three call sites, per SPEC §9.3's "no action is
 * shortcut-only" rule.
 */
import { EditorView } from '@codemirror/view';
import { EditorSelection, EditorState } from '@codemirror/state';
import { syntaxTree } from '@codemirror/language';
import { selectAll } from '@codemirror/commands';
import { startCompletion } from '@codemirror/autocomplete';
import { writeText, readText } from '@tauri-apps/plugin-clipboard-manager';

export type EditorCommand = (view: EditorView) => boolean;

// ---------------------------------------------------------------------------
// Enablement helpers
// ---------------------------------------------------------------------------

export function hasNonEmptySelection(state: EditorState): boolean {
  return !state.selection.main.empty;
}

const BLOCK_NODE_NAMES = new Set([
  'Paragraph',
  'ATXHeading1',
  'ATXHeading2',
  'ATXHeading3',
  'ATXHeading4',
  'ATXHeading5',
  'ATXHeading6',
  'SetextHeading1',
  'SetextHeading2',
  'ListItem',
  'BulletList',
  'OrderedList',
  'Blockquote',
  'FencedCode',
  'CodeBlock',
  'Table',
]);

export interface EnclosingBlock {
  type: string;
  from: number;
  to: number;
}

/** Walk up the Lezer syntax tree from the cursor to find an enclosing Markdown block node. */
export function findEnclosingBlock(state: EditorState): EnclosingBlock | null {
  const pos = state.selection.main.head;
  let node = syntaxTree(state).resolveInner(pos, -1);
  while (node) {
    if (BLOCK_NODE_NAMES.has(node.name)) {
      return { type: node.name, from: node.from, to: node.to };
    }
    if (!node.parent) break;
    node = node.parent;
  }
  return null;
}

export const isFormatEnabled = hasNonEmptySelection;
export const isParagraphEnabled = (state: EditorState): boolean => findEnclosingBlock(state) !== null;
export const isClipboardCutCopyEnabled = hasNonEmptySelection;

// ---------------------------------------------------------------------------
// Format: toggle-aware symmetric wrap/unwrap of the selection
// ---------------------------------------------------------------------------

function toggleWrap(view: EditorView, marker: string, placeholder: string): boolean {
  const { state } = view;
  const changes = state.changeByRange((range) => {
    const selected = state.sliceDoc(range.from, range.to);

    // Selection already includes the markers -> unwrap.
    if (
      selected.length >= marker.length * 2 &&
      selected.startsWith(marker) &&
      selected.endsWith(marker)
    ) {
      const inner = selected.slice(marker.length, selected.length - marker.length);
      return {
        changes: { from: range.from, to: range.to, insert: inner },
        range: EditorSelection.range(range.from, range.from + inner.length),
      };
    }

    // Markers sit just outside the selection -> unwrap.
    const before = state.sliceDoc(Math.max(0, range.from - marker.length), range.from);
    const after = state.sliceDoc(range.to, Math.min(state.doc.length, range.to + marker.length));
    if (before === marker && after === marker) {
      return {
        changes: [
          { from: range.from - marker.length, to: range.from, insert: '' },
          { from: range.to, to: range.to + marker.length, insert: '' },
        ],
        range: EditorSelection.range(range.from - marker.length, range.to - marker.length),
      };
    }

    const text = selected || placeholder;
    const insert = `${marker}${text}${marker}`;
    return {
      changes: { from: range.from, to: range.to, insert },
      range: range.empty
        ? EditorSelection.range(range.from + marker.length, range.from + marker.length + placeholder.length)
        : EditorSelection.range(range.from, range.from + insert.length),
    };
  });
  view.dispatch(changes);
  return true;
}

export const formatBold: EditorCommand = (view) => toggleWrap(view, '**', 'bold text');
export const formatItalic: EditorCommand = (view) => toggleWrap(view, '*', 'italic text');
export const formatStrikethrough: EditorCommand = (view) => toggleWrap(view, '~~', 'strikethrough text');
export const formatInlineCode: EditorCommand = (view) => toggleWrap(view, '`', 'code');
export const formatComment: EditorCommand = (view) => toggleWrap(view, '%%', 'comment');

// ---------------------------------------------------------------------------
// Paragraph: apply to every paragraph/block touched by the selection
// ---------------------------------------------------------------------------

const HEADING_RE = /^(\s*)#{1,6}\s+/;
const LIST_RE = /^(\s*)(?:[-*+]\s+(?:\[[ xX]\]\s+)?|\d+\.\s+)/;
const QUOTE_RE = /^(\s*)>\s?/;

function stripBlockPrefix(text: string): { indent: string; rest: string } {
  let m = text.match(HEADING_RE);
  if (m) return { indent: m[1], rest: text.slice(m[0].length) };
  m = text.match(LIST_RE);
  if (m) return { indent: m[1], rest: text.slice(m[0].length) };
  m = text.match(QUOTE_RE);
  if (m) return { indent: m[1], rest: text.slice(m[0].length) };
  const indentMatch = text.match(/^(\s*)/);
  return { indent: indentMatch ? indentMatch[1] : '', rest: text.replace(/^\s*/, '') };
}

function applyToSelectedLines(view: EditorView, transform: (text: string) => string): boolean {
  const { state } = view;
  const changes: { from: number; to: number; insert: string }[] = [];
  const seenLines = new Set<number>();

  for (const range of state.selection.ranges) {
    const startLine = state.doc.lineAt(range.from).number;
    const endLine = state.doc.lineAt(range.to).number;
    for (let ln = startLine; ln <= endLine; ln++) {
      if (seenLines.has(ln)) continue;
      seenLines.add(ln);
      const line = state.doc.line(ln);
      const newText = transform(line.text);
      if (newText !== line.text) {
        changes.push({ from: line.from, to: line.to, insert: newText });
      }
    }
  }

  if (changes.length > 0) {
    view.dispatch({ changes });
  }
  return true;
}

export function paragraphHeading(level: 1 | 2 | 3 | 4 | 5 | 6): EditorCommand {
  return (view) =>
    applyToSelectedLines(view, (text) => {
      const { indent, rest } = stripBlockPrefix(text);
      return `${indent}${'#'.repeat(level)} ${rest}`;
    });
}

export const paragraphBody: EditorCommand = (view) =>
  applyToSelectedLines(view, (text) => {
    const { indent, rest } = stripBlockPrefix(text);
    return `${indent}${rest}`;
  });

export const paragraphQuote: EditorCommand = (view) =>
  applyToSelectedLines(view, (text) => {
    const { indent, rest } = stripBlockPrefix(text);
    return `${indent}> ${rest}`;
  });

export const paragraphBulletList: EditorCommand = (view) =>
  applyToSelectedLines(view, (text) => {
    const { indent, rest } = stripBlockPrefix(text);
    return `${indent}- ${rest}`;
  });

export const paragraphTaskList: EditorCommand = (view) =>
  applyToSelectedLines(view, (text) => {
    const { indent, rest } = stripBlockPrefix(text);
    return `${indent}- [ ] ${rest}`;
  });

export const paragraphNumberedList: EditorCommand = (view) => {
  let n = 1;
  return applyToSelectedLines(view, (text) => {
    const { indent, rest } = stripBlockPrefix(text);
    return `${indent}${n++}. ${rest}`;
  });
};

// ---------------------------------------------------------------------------
// Insert: always available, insert skeleton text at the cursor
// ---------------------------------------------------------------------------

function insertAtCursor(view: EditorView, text: string, cursorOffset: number): boolean {
  const { state } = view;
  const pos = state.selection.main.head;
  view.dispatch({
    changes: { from: pos, to: pos, insert: text },
    selection: EditorSelection.cursor(pos + cursorOffset),
  });
  return true;
}

export const insertFootnote: EditorCommand = (view) => {
  const { state } = view;
  const doc = state.doc.toString();
  const used = new Set<number>();
  const re = /\[\^(\d+)\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(doc)) !== null) {
    used.add(parseInt(m[1], 10));
  }
  let n = 1;
  while (used.has(n)) n++;

  const pos = state.selection.main.head;
  const marker = `[^${n}]`;
  const defText = `\n\n[^${n}]: `;
  view.dispatch({
    changes: [
      { from: pos, to: pos, insert: marker },
      { from: state.doc.length, to: state.doc.length, insert: defText },
    ],
    selection: EditorSelection.cursor(state.doc.length + defText.length),
  });
  return true;
};

export const insertTable: EditorCommand = (view) => {
  const header = '| Column 1 | Column 2 |\n';
  const sep = '| --- | --- |\n';
  const bodyRow = '|  |  |\n';
  const skeleton = header + sep + bodyRow;
  const firstCellOffset = header.length + sep.length + 2; // after "|_" of the body row
  return insertAtCursor(view, skeleton, firstCellOffset);
};

export function insertCallout(calloutType = 'note'): EditorCommand {
  return (view) => {
    const insert = `> [!${calloutType}]\n> `;
    return insertAtCursor(view, insert, insert.length);
  };
}

export const insertHorizontalRule: EditorCommand = (view) => insertAtCursor(view, '\n\n---\n\n', '\n\n---\n\n'.length);

export const insertCodeBlock: EditorCommand = (view) => {
  const { state } = view;
  const range = state.selection.main;
  const selected = state.sliceDoc(range.from, range.to);
  const insert = `\`\`\`\n${selected}\n\`\`\`\n`;
  const cursorPos = range.from + 4 + selected.length; // after "```\n" plus the (possibly empty) selection
  view.dispatch({
    changes: { from: range.from, to: range.to, insert },
    selection: EditorSelection.cursor(cursorPos),
  });
  return true;
};

export const insertMathBlock: EditorCommand = (view) => {
  const { state } = view;
  const range = state.selection.main;
  const selected = state.sliceDoc(range.from, range.to);
  const insert = `$$\n${selected}\n$$\n`;
  const cursorPos = range.from + 3 + selected.length; // after "$$\n" plus the (possibly empty) selection
  view.dispatch({
    changes: { from: range.from, to: range.to, insert },
    selection: EditorSelection.cursor(cursorPos),
  });
  return true;
};

// ---------------------------------------------------------------------------
// Links
// ---------------------------------------------------------------------------

/** Reuses the M6 note-path autocomplete flow by inserting `[label](` and triggering it. */
export const insertLinkWithAutocomplete: EditorCommand = (view) => {
  const { state } = view;
  const range = state.selection.main;
  const label = state.sliceDoc(range.from, range.to);
  const insert = `[${label}](`;
  view.dispatch({
    changes: { from: range.from, to: range.to, insert },
    selection: EditorSelection.cursor(range.from + insert.length),
  });
  startCompletion(view);
  return true;
};

/** Bare external-link skeleton, cursor placed in the URL segment, no autocomplete. */
export const insertExternalLink: EditorCommand = (view) => {
  const { state } = view;
  const range = state.selection.main;
  const label = state.sliceDoc(range.from, range.to);
  const url = 'https://';
  const insert = `[${label}](${url})`;
  const urlStart = range.from + 1 + label.length + 1; // after "[label]("
  view.dispatch({
    changes: { from: range.from, to: range.to, insert },
    selection: EditorSelection.range(urlStart, urlStart + url.length),
  });
  return true;
};

// ---------------------------------------------------------------------------
// Clipboard — Tauri IPC, not `navigator.clipboard` (SPEC §10.2 strict CSP)
// ---------------------------------------------------------------------------

export const clipboardCut: EditorCommand = (view) => {
  const { state } = view;
  const range = state.selection.main;
  if (range.empty) return true;
  const selected = state.sliceDoc(range.from, range.to);
  void writeText(selected);
  view.dispatch({ changes: { from: range.from, to: range.to, insert: '' } });
  return true;
};

export const clipboardCopy: EditorCommand = (view) => {
  const { state } = view;
  const range = state.selection.main;
  if (range.empty) return true;
  void writeText(state.sliceDoc(range.from, range.to));
  return true;
};

export const clipboardPaste: EditorCommand = (view) => {
  readText()
    .then((text) => {
      if (text) {
        view.dispatch(view.state.replaceSelection(text));
      }
    })
    .catch((err) => console.warn('Clipboard paste failed:', err));
  return true;
};

export const selectAllCommand: EditorCommand = (view) => selectAll(view);
