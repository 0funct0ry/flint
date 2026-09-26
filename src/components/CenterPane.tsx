import React, { useEffect, useRef, useState } from 'react';
import katex from 'katex';
import { EditorSelection, EditorState, Prec } from '@codemirror/state';
import { EditorView, keymap, highlightActiveLine, drawSelection, Decoration, DecorationSet, ViewPlugin, ViewUpdate } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { markdown } from '@codemirror/lang-markdown';
import { searchKeymap, openSearchPanel } from '@codemirror/search';
import { bracketMatching, HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { tags } from '@lezer/highlight';
import { autocompletion, CompletionContext, CompletionResult } from '@codemirror/autocomplete';
import { ViewMode } from './TitleBar';
import { NoteFixture, NoteMeta, TreeNodeItem } from '../types';
import { ConflictBanner } from './ConflictBanner';
import { ContextMenu, ContextMenuItem } from './ContextMenu';
import { TableBuilderModal, TableBuilderInitial } from './TableBuilderModal';
import { commandRegistry } from '../commands/registry';
import * as ec from '../commands/editorCommands';
import { parseDelimitedSelection, ColumnAlignment } from '../commands/tableBuilder';

export interface CenterPaneProps {
  note: NoteFixture;
  viewMode: ViewMode;
  isDirty: boolean;
  onContentChange: (newContent: string) => void;
  onSaveNow?: () => void;
  onBlurSave?: () => void;
  onNavigateRelative: (target: string) => void;
  onCreateNote?: (target: string) => void;
  onOpenExternal?: (url: string) => void;
  onCloseNote?: () => void;
  showConflictBanner: boolean;
  onKeepVersion: () => void;
  onLoadFromDisk: () => void;
  onShowDifferences: () => void;
  onBack: () => void;
  onForward: () => void;
  onHeadingInView?: (anchor: string) => void;
  scrollToAnchor?: string | null;
  scrollToLine?: number | null;
  treeData?: TreeNodeItem[];
  indexedNotes?: NoteMeta[];
  savedScrollTop?: number;
  savedCursorPos?: number;
  onScrollOrCursorChange?: (
    scrollTop: number,
    cursorPos: number,
    cursorLine: number,
    cursorCol: number,
    selectionLength: number
  ) => void;
}

/**
 * Handle Markdown list continuation on Enter
 */
function handleListContinuation(view: EditorView): boolean {
  const { state } = view;
  const line = state.doc.lineAt(state.selection.main.head);
  const text = line.text;

  // Check for task list (- [ ] )
  const taskMatch = text.match(/^(\s*)([-*+]\s+\[[ xX]\]\s+)(.*)$/);
  if (taskMatch) {
    const [, indent, , rest] = taskMatch;
    if (!rest.trim()) {
      // Empty item -> remove prefix
      view.dispatch({
        changes: { from: line.from, to: line.to, insert: '' },
      });
      return true;
    }
    view.dispatch(state.replaceSelection(`\n${indent}- [ ] `));
    return true;
  }

  // Check for bullet list (- , * , + )
  const listMatch = text.match(/^(\s*)([-*+]\s+)(.*)$/);
  if (listMatch) {
    const [, indent, prefix, rest] = listMatch;
    if (!rest.trim()) {
      view.dispatch({
        changes: { from: line.from, to: line.to, insert: '' },
      });
      return true;
    }
    view.dispatch(state.replaceSelection(`\n${indent}${prefix}`));
    return true;
  }

  // Check for numbered list (1. )
  const numMatch = text.match(/^(\s*)(\d+)\.\s+(.*)$/);
  if (numMatch) {
    const [, indent, numStr, rest] = numMatch;
    if (!rest.trim()) {
      view.dispatch({
        changes: { from: line.from, to: line.to, insert: '' },
      });
      return true;
    }
    const nextNum = parseInt(numStr, 10) + 1;
    view.dispatch(state.replaceSelection(`\n${indent}${nextNum}. `));
    return true;
  }

  return false;
}

/**
 * Table alignment helper on Tab key inside Markdown tables
 */
function handleTabKey(view: EditorView): boolean {
  const { state } = view;
  const line = state.doc.lineAt(state.selection.main.head);
  if (line.text.trim().startsWith('|')) {
    // Inside a markdown table row: jump to next pipe or insert aligned cell
    const pos = state.selection.main.head;
    const nextPipe = line.text.indexOf('|', pos - line.from);
    if (nextPipe !== -1 && line.from + nextPipe + 2 <= line.to) {
      view.dispatch({
        selection: { anchor: line.from + nextPipe + 2 },
      });
      return true;
    }
  }
  // Default tab insertion
  view.dispatch(state.replaceSelection('  '));
  return true;
}

/**
 * Compute relative path from source folder to target note path
 */
function computeRelativeLinkPath(sourceNotePath: string, targetNotePath: string): string {
  const sourceFolderParts = sourceNotePath.split('/').slice(0, -1);
  const targetParts = targetNotePath.split('/');

  let common = 0;
  while (
    common < sourceFolderParts.length &&
    common < targetParts.length &&
    sourceFolderParts[common] === targetParts[common]
  ) {
    common++;
  }

  const upCount = sourceFolderParts.length - common;
  const relSegments = [];
  for (let i = 0; i < upCount; i++) {
    relSegments.push('..');
  }
  relSegments.push(...targetParts.slice(common));

  const result = relSegments.join('/');
  if (!result.startsWith('.') && !result.startsWith('/')) {
    return `./${result}`;
  }
  return result;
}

/**
 * Flatten tree nodes to get all note paths
 */
function getAllNotePaths(tree: TreeNodeItem[]): Array<{ path: string; title?: string; name: string }> {
  const result: Array<{ path: string; title?: string; name: string }> = [];
  function walk(nodes: TreeNodeItem[]) {
    for (const node of nodes) {
      if (node.is_folder && node.children) {
        walk(node.children);
      } else if (node.is_note || node.path.endsWith('.md') || node.path.endsWith('.markdown')) {
        result.push({ path: node.path, title: node.title, name: node.name });
      }
    }
  }
  walk(tree);
  return result;
}

/**
 * Bridge from the module-level `EDITOR_COMMANDS` table (shared across the palette, keymap, and
 * context menu) into the single mounted `CenterPane` instance's React state — the only command
 * that needs to open a modal rather than dispatch straight into CodeMirror. Set on mount, cleared
 * on unmount.
 */
let openTableBuilder: ((view: EditorView) => void) | null = null;

interface EditorCommandDef {
  id: string;
  title: string;
  /** CodeMirror keymap key string, e.g. `'Mod-b'`. Omit when an existing default binding
   *  (e.g. Select All's Mod-a from `defaultKeymap`) already covers it. */
  key?: string;
  shortcutDisplay: string;
  section: 'insert' | 'format' | 'paragraph' | 'link' | 'clipboard';
  run: ec.EditorCommand;
  isEnabled?: (state: EditorState) => boolean;
}

/**
 * Every Insert/Format/Paragraph/link/clipboard action, defined once and shared across the
 * command palette, the CodeMirror keymap, and the editor context menu (M10.05, SPEC §9.3).
 */
const EDITOR_COMMANDS: EditorCommandDef[] = [
  // Insert — always available.
  { id: 'editor.insert_footnote', title: 'Footnote', key: 'Mod-Alt-f', shortcutDisplay: '⌘⌥F', section: 'insert', run: ec.insertFootnote },
  { id: 'editor.insert_table', title: 'Table', key: 'Mod-Alt-t', shortcutDisplay: '⌘⌥T', section: 'insert', run: ec.insertTable },
  { id: 'editor.insert_table_builder', title: 'Table Builder', key: 'Mod-Alt-Shift-t', shortcutDisplay: '⌘⌥⇧T', section: 'insert', run: (view) => { openTableBuilder?.(view); return true; } },
  { id: 'editor.insert_callout', title: 'Callout', key: 'Mod-Alt-q', shortcutDisplay: '⌘⌥Q', section: 'insert', run: ec.insertCallout() },
  { id: 'editor.insert_hr', title: 'Horizontal Rule', key: 'Mod-Alt-h', shortcutDisplay: '⌘⌥H', section: 'insert', run: ec.insertHorizontalRule },
  { id: 'editor.insert_code_block', title: 'Code Block', key: 'Mod-Alt-c', shortcutDisplay: '⌘⌥C', section: 'insert', run: ec.insertCodeBlock },
  { id: 'editor.insert_math_block', title: 'Math Block', key: 'Mod-Alt-m', shortcutDisplay: '⌘⌥M', section: 'insert', run: ec.insertMathBlock },

  // Format — enabled only with a non-empty selection.
  { id: 'editor.format_bold', title: 'Bold', key: 'Mod-b', shortcutDisplay: '⌘B', section: 'format', run: ec.formatBold, isEnabled: ec.isFormatEnabled },
  { id: 'editor.format_italic', title: 'Italic', key: 'Mod-i', shortcutDisplay: '⌘I', section: 'format', run: ec.formatItalic, isEnabled: ec.isFormatEnabled },
  { id: 'editor.format_strikethrough', title: 'Strikethrough', key: 'Mod-Shift-x', shortcutDisplay: '⌘⇧X', section: 'format', run: ec.formatStrikethrough, isEnabled: ec.isFormatEnabled },
  { id: 'editor.format_inline_code', title: 'Inline Code', key: 'Mod-Shift-c', shortcutDisplay: '⌘⇧C', section: 'format', run: ec.formatInlineCode, isEnabled: ec.isFormatEnabled },
  { id: 'editor.format_comment', title: 'Comment', key: 'Mod-/', shortcutDisplay: '⌘/', section: 'format', run: ec.formatComment, isEnabled: ec.isFormatEnabled },

  // Paragraph — enabled only when the cursor/selection is inside a block-level element.
  { id: 'editor.paragraph_bullet_list', title: 'Bullet List', key: 'Mod-Shift-8', shortcutDisplay: '⌘⇧8', section: 'paragraph', run: ec.paragraphBulletList, isEnabled: ec.isParagraphEnabled },
  { id: 'editor.paragraph_numbered_list', title: 'Numbered List', key: 'Mod-Shift-7', shortcutDisplay: '⌘⇧7', section: 'paragraph', run: ec.paragraphNumberedList, isEnabled: ec.isParagraphEnabled },
  { id: 'editor.paragraph_task_list', title: 'Task List', key: 'Mod-Shift-9', shortcutDisplay: '⌘⇧9', section: 'paragraph', run: ec.paragraphTaskList, isEnabled: ec.isParagraphEnabled },
  { id: 'editor.paragraph_h1', title: 'Heading 1', key: 'Mod-Alt-1', shortcutDisplay: '⌘⌥1', section: 'paragraph', run: ec.paragraphHeading(1), isEnabled: ec.isParagraphEnabled },
  { id: 'editor.paragraph_h2', title: 'Heading 2', key: 'Mod-Alt-2', shortcutDisplay: '⌘⌥2', section: 'paragraph', run: ec.paragraphHeading(2), isEnabled: ec.isParagraphEnabled },
  { id: 'editor.paragraph_h3', title: 'Heading 3', key: 'Mod-Alt-3', shortcutDisplay: '⌘⌥3', section: 'paragraph', run: ec.paragraphHeading(3), isEnabled: ec.isParagraphEnabled },
  { id: 'editor.paragraph_h4', title: 'Heading 4', key: 'Mod-Alt-4', shortcutDisplay: '⌘⌥4', section: 'paragraph', run: ec.paragraphHeading(4), isEnabled: ec.isParagraphEnabled },
  { id: 'editor.paragraph_h5', title: 'Heading 5', key: 'Mod-Alt-5', shortcutDisplay: '⌘⌥5', section: 'paragraph', run: ec.paragraphHeading(5), isEnabled: ec.isParagraphEnabled },
  { id: 'editor.paragraph_h6', title: 'Heading 6', key: 'Mod-Alt-6', shortcutDisplay: '⌘⌥6', section: 'paragraph', run: ec.paragraphHeading(6), isEnabled: ec.isParagraphEnabled },
  { id: 'editor.paragraph_body', title: 'Body', key: 'Mod-Alt-0', shortcutDisplay: '⌘⌥0', section: 'paragraph', run: ec.paragraphBody, isEnabled: ec.isParagraphEnabled },
  { id: 'editor.paragraph_quote', title: 'Quote', key: 'Mod-Shift-.', shortcutDisplay: '⌘⇧.', section: 'paragraph', run: ec.paragraphQuote, isEnabled: ec.isParagraphEnabled },

  // Links — the first reuses the M6 note-path autocomplete flow, the second is a bare skeleton.
  { id: 'editor.insert_link', title: 'Add a link', key: 'Mod-Shift-k', shortcutDisplay: '⌘⇧K', section: 'link', run: ec.insertLinkWithAutocomplete },
  { id: 'editor.insert_external_link', title: 'Add external link', key: 'Mod-k', shortcutDisplay: '⌘K', section: 'link', run: ec.insertExternalLink },

  // Clipboard — via the Tauri clipboard API (SPEC §10.2 CSP), not `navigator.clipboard`.
  { id: 'editor.cut', title: 'Cut', key: 'Mod-x', shortcutDisplay: '⌘X', section: 'clipboard', run: ec.clipboardCut, isEnabled: ec.isClipboardCutCopyEnabled },
  { id: 'editor.copy', title: 'Copy', key: 'Mod-c', shortcutDisplay: '⌘C', section: 'clipboard', run: ec.clipboardCopy, isEnabled: ec.isClipboardCutCopyEnabled },
  { id: 'editor.paste', title: 'Paste', key: 'Mod-v', shortcutDisplay: '⌘V', section: 'clipboard', run: ec.clipboardPaste },
  // Select All already has its default keybinding (Mod-a) via `defaultKeymap`; listed here so
  // it also gets a palette entry and a context-menu entry per SPEC §9.3.
  { id: 'editor.select_all', title: 'Select all', shortcutDisplay: '⌘A', section: 'clipboard', run: ec.selectAllCommand },
];

/**
 * Style `%%comment%%` spans in the editor with a muted/dashed treatment (M10.05) — the comment
 * itself never reaches rendered HTML or search (flint-core strips it), this is purely a visual
 * cue so the author can still see it exists while editing. Same-line spans only; a comment
 * spanning a line break still round-trips correctly, it just isn't decorated across the break.
 */
function buildCommentDecorations(view: EditorView): DecorationSet {
  const ranges: Array<{ from: number; to: number }> = [];
  const commentRe = /%%[^%\n]*%%/g;
  for (const { from, to } of view.visibleRanges) {
    const text = view.state.doc.sliceString(from, to);
    let match: RegExpExecArray | null;
    commentRe.lastIndex = 0;
    while ((match = commentRe.exec(text)) !== null) {
      ranges.push({ from: from + match.index, to: from + match.index + match[0].length });
    }
  }
  const decorations = ranges.map((r) => Decoration.mark({ class: 'cm-flint-comment' }).range(r.from, r.to));
  return Decoration.set(decorations, true);
}

const commentDecorationPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = buildCommentDecorations(view);
    }
    update(update: ViewUpdate) {
      if (update.docChanged || update.viewportChanged) {
        this.decorations = buildCommentDecorations(update.view);
      }
    }
  },
  { decorations: (v) => v.decorations }
);

/**
 * Find link at position in text line
 */
function findLinkAtPos(lineText: string, col: number): { target: string; isExternal: boolean } | null {
  const regex = /\[([^\]]*)\]\(([^)]+)\)/g;
  let match;
  while ((match = regex.exec(lineText)) !== null) {
    const start = match.index;
    const end = match.index + match[0].length;
    if (col >= start && col <= end) {
      const target = match[2];
      const isExternal = target.startsWith('http://') || target.startsWith('https://') || target.startsWith('mailto:');
      return { target, isExternal };
    }
  }
  return null;
}

// Maps markdown syntax to the existing --kw/--str/--lnk/--cmt/--hd theme tokens (index.css)
// rather than introducing a separate highlight-only palette.
const markdownHighlightStyle = HighlightStyle.define([
  { tag: tags.heading, color: 'var(--hd)', fontWeight: 600 },
  { tag: tags.strong, color: 'var(--kw)', fontWeight: 700 },
  { tag: tags.emphasis, color: 'var(--kw)', fontStyle: 'italic' },
  { tag: tags.strikethrough, color: 'var(--faint)', textDecoration: 'line-through' },
  { tag: tags.link, color: 'var(--lnk)', textDecoration: 'underline' },
  { tag: tags.url, color: 'var(--lnk)' },
  { tag: tags.monospace, color: 'var(--str)', fontFamily: 'var(--mono)' },
  { tag: tags.quote, color: 'var(--muted)', fontStyle: 'italic' },
  { tag: tags.list, color: 'var(--accent)' },
  { tag: tags.contentSeparator, color: 'var(--border)' },
  { tag: tags.processingInstruction, color: 'var(--cmt)' },
  { tag: tags.meta, color: 'var(--cmt)' },
]);

export const CenterPane: React.FC<CenterPaneProps> = ({
  note,
  viewMode,
  isDirty,
  onContentChange,
  onSaveNow,
  onBlurSave,
  onNavigateRelative,
  onCreateNote,
  onOpenExternal,
  onCloseNote,
  showConflictBanner,
  onKeepVersion,
  onLoadFromDisk,
  onShowDifferences,
  onBack,
  onForward,
  onHeadingInView,
  scrollToAnchor,
  scrollToLine,
  treeData = [],
  indexedNotes = [],
  savedScrollTop,
  savedCursorPos,
  onScrollOrCursorChange,
}) => {
  const editorContainerRef = useRef<HTMLDivElement>(null);
  const readerContainerRef = useRef<HTMLDivElement>(null);
  const editorViewRef = useRef<EditorView | null>(null);

  // Active while an outline/search jump is scrolling the panes. Scroll-spy and split-view sync
  // stand down meanwhile; otherwise the sync drags the reader to the editor's top line and the
  // spy overwrites the clicked heading's highlight with whatever heading sits there.
  const programmaticScrollRef = useRef<{ active: boolean; timer: ReturnType<typeof setTimeout> | null }>({
    active: false,
    timer: null,
  });
  const holdProgrammaticScroll = (ms: number) => {
    const s = programmaticScrollRef.current;
    s.active = true;
    if (s.timer) clearTimeout(s.timer);
    s.timer = setTimeout(() => {
      s.active = false;
      s.timer = null;
    }, ms);
  };

  const onContentChangeRef = useRef(onContentChange);
  onContentChangeRef.current = onContentChange;

  const onSaveNowRef = useRef(onSaveNow);
  onSaveNowRef.current = onSaveNow;

  const onBlurSaveRef = useRef(onBlurSave);
  onBlurSaveRef.current = onBlurSave;

  const onNavigateRelativeRef = useRef(onNavigateRelative);
  onNavigateRelativeRef.current = onNavigateRelative;

  const onOpenExternalRef = useRef(onOpenExternal);
  onOpenExternalRef.current = onOpenExternal;

  const onCreateNoteRef = useRef(onCreateNote);
  onCreateNoteRef.current = onCreateNote;

  const treeDataRef = useRef(treeData);
  treeDataRef.current = treeData;

  const indexedNotesRef = useRef(indexedNotes);
  indexedNotesRef.current = indexedNotes;

  const onScrollOrCursorChangeRef = useRef(onScrollOrCursorChange);
  onScrollOrCursorChangeRef.current = onScrollOrCursorChange;

  // The context menu only applies to the CodeMirror editor pane, not the reader; the editor
  // stays mounted (just hidden) in read mode, so its handlers need this to stay current.
  const viewModeRef = useRef(viewMode);
  viewModeRef.current = viewMode;

  // Track the note path currently loaded in the editor instance
  const loadedNotePathRef = useRef<string>('');

  const [contextMenuState, setContextMenuState] = useState<{ x: number; y: number } | null>(null);

  const [tableBuilderState, setTableBuilderState] = useState<{
    initial: TableBuilderInitial;
    selectionRange: { from: number; to: number } | null;
  } | null>(null);

  // Bridge `editor.insert_table_builder`'s `run` (defined once, module-level, in
  // `EDITOR_COMMANDS`) into this instance's modal state — see `openTableBuilder`'s doc comment.
  useEffect(() => {
    openTableBuilder = (view) => {
      const { state } = view;
      const range = state.selection.main;
      const selectedText = state.sliceDoc(range.from, range.to);
      const parsed = range.empty ? null : parseDelimitedSelection(selectedText);

      const initial: TableBuilderInitial = parsed
        ? {
            headers: parsed.headers,
            alignments: parsed.headers.map(() => 'none' as ColumnAlignment),
            bodyRowCount: Math.max(1, parsed.bodyRowCount),
            detectedDelimiter: parsed.delimiter,
          }
        : {
            headers: ['', ''],
            alignments: ['none', 'none'],
            bodyRowCount: 1,
          };

      setTableBuilderState({
        initial,
        selectionRange: parsed ? { from: range.from, to: range.to } : null,
      });
    };
    return () => {
      openTableBuilder = null;
    };
  }, []);

  const handleTableBuilderInsert = (markdown: string, replaceSelection: boolean) => {
    const view = editorViewRef.current;
    setTableBuilderState(null);
    if (!view) return;
    view.focus();
    const { state } = view;
    const from = replaceSelection && tableBuilderState?.selectionRange ? tableBuilderState.selectionRange.from : state.selection.main.head;
    const to = replaceSelection && tableBuilderState?.selectionRange ? tableBuilderState.selectionRange.to : state.selection.main.head;
    // Cursor lands in the first header cell: right after "| " on the first line.
    const firstCellOffset = 2;
    view.dispatch({
      changes: { from, to, insert: markdown },
      selection: EditorSelection.cursor(from + firstCellOffset),
    });
  };

  // Register every Insert/Format/Paragraph/link/clipboard command once, per SPEC §9.3 — the
  // handler always reads the currently-mounted EditorView from the ref, so this stays correct
  // across note switches without re-registering.
  useEffect(() => {
    for (const cmd of EDITOR_COMMANDS) {
      commandRegistry.register({
        id: cmd.id,
        title: cmd.title,
        category: 'Editor',
        shortcut: cmd.key,
        shortcutDisplay: cmd.shortcutDisplay,
        handler: () => {
          const view = editorViewRef.current;
          if (view) {
            view.focus();
            cmd.run(view);
          }
        },
      });
    }
  }, []);

  // Render KaTeX formulas whenever note.renderedHtml or viewMode changes
  useEffect(() => {
    if (!readerContainerRef.current) return;
    if (viewMode === 'edit') return;

    const renderMath = () => {
      if (!readerContainerRef.current) return;

      // Render inline math
      const inlineMathNodes = readerContainerRef.current.querySelectorAll('.flint-math-inline');
      inlineMathNodes.forEach((node) => {
        const math = node.getAttribute('data-math');
        if (math && !node.hasAttribute('data-rendered')) {
          try {
            katex.render(math, node as HTMLElement, {
              throwOnError: false,
              displayMode: false,
            });
            node.setAttribute('data-rendered', 'true');
          } catch (e) {
            console.warn('KaTeX inline render error:', e);
          }
        }
      });

      // Render block display math
      const blockMathNodes = readerContainerRef.current.querySelectorAll('.flint-math-block');
      blockMathNodes.forEach((node) => {
        const math = node.getAttribute('data-math');
        if (math && !node.hasAttribute('data-rendered')) {
          try {
            katex.render(math, node as HTMLElement, {
              throwOnError: false,
              displayMode: true,
            });
            node.setAttribute('data-rendered', 'true');
          } catch (e) {
            console.warn('KaTeX block render error:', e);
          }
        }
      });
    };

    // Run immediately and in animation frame to ensure DOM is attached
    renderMath();
    const frame = requestAnimationFrame(renderMath);
    return () => cancelAnimationFrame(frame);
  }, [note.renderedHtml, viewMode]);

  // Scroll to anchor when requested from outline
  useEffect(() => {
    if (!scrollToAnchor || !readerContainerRef.current) return;
    const targetElem = readerContainerRef.current.querySelector(`#${CSS.escape(scrollToAnchor)}`);
    if (targetElem) {
      holdProgrammaticScroll(400);
      targetElem.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }, [scrollToAnchor]);

  // Scroll to specific line when requested from search
  useEffect(() => {
    if (!scrollToLine || scrollToLine < 1) return;

    if (editorViewRef.current) {
      holdProgrammaticScroll(400);
      const view = editorViewRef.current;
      const totalLines = view.state.doc.lines;
      const targetLine = Math.min(Math.max(1, scrollToLine), totalLines);
      const lineObj = view.state.doc.line(targetLine);

      view.dispatch({
        selection: EditorSelection.single(lineObj.from, lineObj.to),
        effects: EditorView.scrollIntoView(lineObj.from, { y: 'center' }),
      });
      view.focus();
    }
  }, [scrollToLine, note.path]);

  // Track active heading in view as reader scrolls
  useEffect(() => {
    const reader = readerContainerRef.current;
    if (!reader || !onHeadingInView) return;

    const handleScroll = () => {
      if (programmaticScrollRef.current.active) {
        // Keep holding until the smooth scroll has been quiet for a moment.
        holdProgrammaticScroll(150);
        return;
      }
      const headings = reader.querySelectorAll('h1, h2, h3, h4, h5, h6');
      let currentAnchor = '';
      const readerTop = reader.getBoundingClientRect().top;

      headings.forEach((h) => {
        const rect = h.getBoundingClientRect();
        if (rect.top - readerTop <= 60 && h.id) {
          currentAnchor = h.id;
        }
      });

      if (currentAnchor) {
        onHeadingInView(currentAnchor);
      }
    };

    reader.addEventListener('scroll', handleScroll, { passive: true });
    return () => reader.removeEventListener('scroll', handleScroll);
  }, [onHeadingInView, note.renderedHtml]);

  useEffect(() => {
    const release = () => {
      const s = programmaticScrollRef.current;
      if (s.timer) clearTimeout(s.timer);
      s.active = false;
      s.timer = null;
    };
    const targets = [editorContainerRef.current, readerContainerRef.current].filter(
      (el): el is HTMLDivElement => el !== null,
    );
    const events = ['wheel', 'touchstart', 'keydown', 'mousedown'] as const;
    targets.forEach((el) => events.forEach((ev) => el.addEventListener(ev, release, { passive: true })));
    return () => {
      targets.forEach((el) => events.forEach((ev) => el.removeEventListener(ev, release)));
      release();
    };
  }, []);

  // Synchronized scrolling in split view with source-line mapping (SPEC §8.1)
  useEffect(() => {
    if (viewMode !== 'split') return;

    const editorScroller = editorContainerRef.current?.querySelector('.cm-scroller') as HTMLElement | null;
    const reader = readerContainerRef.current;
    if (!editorScroller || !reader) return;

    // Track which pane is the active scroll source to prevent echo loops.
    // 'idle' = no sync in progress, 'editor' = editor initiated, 'reader' = reader initiated
    let scrollSource: 'idle' | 'editor' | 'reader' = 'idle';
    let scrollResetTimer: ReturnType<typeof setTimeout> | null = null;

    const resetScrollSource = () => {
      scrollSource = 'idle';
      scrollResetTimer = null;
    };

    const scheduleReset = () => {
      if (scrollResetTimer) clearTimeout(scrollResetTimer);
      // Hold the guard long enough for the synced pane's scroll event to fire and be suppressed
      scrollResetTimer = setTimeout(resetScrollSource, 80);
    };

    const handleEditorScroll = () => {
      if (programmaticScrollRef.current.active) {
        holdProgrammaticScroll(150);
        return;
      }
      if (scrollSource === 'reader') return;
      scrollSource = 'editor';

      const editorView = editorViewRef.current;
      if (editorView) {
        const scrollTop = editorScroller.scrollTop;
        const scrollHeight = editorScroller.scrollHeight;
        const clientHeight = editorScroller.clientHeight;
        const maxScroll = scrollHeight - clientHeight;

        // Edge clamp: top
        if (scrollTop <= 2) {
          reader.scrollTop = 0;
        }
        // Edge clamp: bottom
        else if (scrollTop >= maxScroll - 2) {
          reader.scrollTop = reader.scrollHeight - reader.clientHeight;
        }
        // Line-based proportional mapping
        else {
          const topBlock = editorView.lineBlockAtHeight(scrollTop);
          const topLineNumber = editorView.state.doc.lineAt(topBlock.from).number;
          const totalLines = editorView.state.doc.lines;
          const progress = totalLines > 1 ? (topLineNumber - 1) / (totalLines - 1) : 0;
          const readerMaxScroll = reader.scrollHeight - reader.clientHeight;
          reader.scrollTop = progress * readerMaxScroll;
        }
      }

      scheduleReset();
    };

    const handleReaderScroll = () => {
      if (programmaticScrollRef.current.active) {
        holdProgrammaticScroll(150);
        return;
      }
      if (scrollSource === 'editor') return;
      scrollSource = 'reader';

      const editorView = editorViewRef.current;
      if (editorView) {
        const scrollTop = reader.scrollTop;
        const maxScroll = reader.scrollHeight - reader.clientHeight;

        // Edge clamp: top
        if (scrollTop <= 2) {
          editorScroller.scrollTop = 0;
        }
        // Edge clamp: bottom
        else if (scrollTop >= maxScroll - 2) {
          editorScroller.scrollTop = editorScroller.scrollHeight - editorScroller.clientHeight;
        }
        // Reverse line-based proportional mapping
        else {
          const readerProgress = maxScroll > 0 ? scrollTop / maxScroll : 0;
          const totalLines = editorView.state.doc.lines;
          const targetLineNum = Math.max(1, Math.min(Math.round(readerProgress * (totalLines - 1)) + 1, totalLines));
          const line = editorView.state.doc.line(targetLineNum);
          const lineBlock = editorView.lineBlockAt(line.from);
          editorScroller.scrollTop = lineBlock.top;
        }
      }

      scheduleReset();
    };

    editorScroller.addEventListener('scroll', handleEditorScroll, { passive: true });
    reader.addEventListener('scroll', handleReaderScroll, { passive: true });

    return () => {
      editorScroller.removeEventListener('scroll', handleEditorScroll);
      reader.removeEventListener('scroll', handleReaderScroll);
      if (scrollResetTimer) clearTimeout(scrollResetTimer);
    };
  }, [viewMode, note.path, note.headings]);

  // Build the context-menu item list fresh on each open, so enabled/disabled reflects the
  // selection/cursor at open time: the two link items, then Format/Paragraph/Insert as flyout
  // submenus (keeps the top level short), then clipboard actions.
  const buildMenuItems = (): ContextMenuItem[] => {
    const view = editorViewRef.current;
    if (!view) return [];
    const { state } = view;

    const sep = (id: string): ContextMenuItem => ({ id, label: '', separator: true, onClick: () => {} });

    const toItem = (cmd: EditorCommandDef): ContextMenuItem => {
      const enabled = cmd.isEnabled ? cmd.isEnabled(state) : true;
      return {
        id: cmd.id,
        label: cmd.title,
        shortcut: cmd.shortcutDisplay,
        disabled: !enabled,
        disabledReason: !enabled
          ? cmd.section === 'format' || cmd.section === 'clipboard'
            ? 'Select some text first'
            : cmd.section === 'paragraph'
            ? 'Place the cursor in a paragraph, list, or heading first'
            : undefined
          : undefined,
        onClick: () => {
          view.focus();
          cmd.run(view);
        },
      };
    };

    const byIds = (...ids: string[]) =>
      ids
        .map((id) => EDITOR_COMMANDS.find((c) => c.id === id))
        .filter((c): c is EditorCommandDef => !!c)
        .map(toItem);

    const formatSubmenu: ContextMenuItem[] = [
      ...byIds('editor.format_bold', 'editor.format_italic', 'editor.format_strikethrough', 'editor.format_inline_code'),
      sep('format-sep-1'),
      ...byIds('editor.format_comment'),
    ];

    const paragraphSubmenu: ContextMenuItem[] = [
      ...byIds('editor.paragraph_bullet_list', 'editor.paragraph_numbered_list', 'editor.paragraph_task_list'),
      sep('paragraph-sep-1'),
      ...byIds(
        'editor.paragraph_h1',
        'editor.paragraph_h2',
        'editor.paragraph_h3',
        'editor.paragraph_h4',
        'editor.paragraph_h5',
        'editor.paragraph_h6',
        'editor.paragraph_body',
        'editor.paragraph_quote'
      ),
    ];

    const insertSubmenu: ContextMenuItem[] = [
      ...byIds('editor.insert_footnote', 'editor.insert_table', 'editor.insert_table_builder', 'editor.insert_callout', 'editor.insert_hr'),
      sep('insert-sep-1'),
      ...byIds('editor.insert_code_block', 'editor.insert_math_block'),
    ];

    return [
      ...byIds('editor.insert_link', 'editor.insert_external_link'),
      sep('sep-1'),
      { id: 'group-format', label: 'Format', submenu: formatSubmenu, onClick: () => {} },
      { id: 'group-paragraph', label: 'Paragraph', submenu: paragraphSubmenu, onClick: () => {} },
      { id: 'group-insert', label: 'Insert', submenu: insertSubmenu, onClick: () => {} },
      sep('sep-2'),
      ...byIds('editor.cut', 'editor.copy', 'editor.paste', 'editor.select_all'),
    ];
  };

  // Navigate to link target helper
  const navigateToLink = (rawTarget: string) => {
    const isExternal =
      rawTarget.startsWith('http://') ||
      rawTarget.startsWith('https://') ||
      rawTarget.startsWith('mailto:');
    if (isExternal) {
      if (onOpenExternalRef.current) {
        onOpenExternalRef.current(rawTarget);
      }
    } else {
      const cleanPath = rawTarget.split('#')[0];
      const anchor = rawTarget.includes('#') ? rawTarget.split('#')[1] : null;

      if (!cleanPath && anchor) {
        // Anchor in current note
        const targetElem = readerContainerRef.current?.querySelector(`#${CSS.escape(anchor)}`);
        if (targetElem) {
          targetElem.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
        return;
      }

      onNavigateRelativeRef.current(rawTarget);
    }
  };

  // Initialize CodeMirror 6 editor instance with autocompletion and link navigation
  useEffect(() => {
    if (!note.path) {
      if (editorViewRef.current) {
        editorViewRef.current.destroy();
        editorViewRef.current = null;
      }
      loadedNotePathRef.current = '';
      return;
    }
    if (!editorContainerRef.current) return;

    // Link autocomplete completion source (SPEC §6.3, M7)
    const linkCompletionSource = (context: CompletionContext): CompletionResult | null => {
      const line = context.state.doc.lineAt(context.pos);
      const lineBefore = line.text.slice(0, context.pos - line.from);

      // Trigger on `[` or `](`
      const openBracketMatch = /\[([^\]]*)$/.exec(lineBefore);
      const openParenMatch = /\]\(([^)]*)$/.exec(lineBefore);

      const notes = indexedNotesRef.current && indexedNotesRef.current.length > 0
        ? indexedNotesRef.current.map((n) => ({
            path: n.path,
            title: n.title,
            name: n.path.split('/').pop() || n.path,
          }))
        : getAllNotePaths(treeDataRef.current);

      if (openParenMatch) {
        const typed = openParenMatch[1];
        const from = context.pos - typed.length;
        return {
          from,
          options: notes.map((n) => {
            const rel = computeRelativeLinkPath(note.path, n.path);
            return {
              label: rel,
              detail: n.title || n.name,
              type: 'file',
              apply: rel,
            };
          }),
        };
      } else if (openBracketMatch) {
        const typed = openBracketMatch[1];
        const from = context.pos - typed.length;
        return {
          from,
          options: notes.map((n) => {
            const rel = computeRelativeLinkPath(note.path, n.path);
            const title = n.title || n.name.replace(/\.md$/, '');
            return {
              label: title,
              detail: rel,
              type: 'file',
              apply: `${title}](${rel})`,
            };
          }),
        };
      }
      return null;
    };

    // If switching to a new note or container changed, create/re-create editor
    const isAttached =
      editorViewRef.current &&
      editorContainerRef.current.contains(editorViewRef.current.dom);
    if (loadedNotePathRef.current !== note.path || !editorViewRef.current || !isAttached) {
      if (editorViewRef.current) {
        editorViewRef.current.destroy();
      }

      const formattingKeymap = [
        ...EDITOR_COMMANDS.filter((cmd) => cmd.key).map((cmd) => ({ key: cmd.key as string, run: cmd.run })),
        {
          key: 'Mod-s',
          run: () => {
            if (onSaveNowRef.current) {
              onSaveNowRef.current();
            }
            return true;
          },
        },
        {
          key: 'Mod-f',
          run: openSearchPanel,
        },
        {
          key: 'Enter',
          run: handleListContinuation,
        },
        {
          key: 'Tab',
          run: handleTabKey,
        },
        {
          key: 'Mod-Enter',
          run: (view: EditorView) => {
            const pos = view.state.selection.main.head;
            const line = view.state.doc.lineAt(pos);
            const col = pos - line.from;
            const link = findLinkAtPos(line.text, col);
            if (link) {
              navigateToLink(link.target);
              return true;
            }
            return false;
          },
        },
      ];

      const startState = EditorState.create({
        doc: note.content,
        extensions: [
          history(),
          // CodeMirror-drawn selection layer instead of the native one, so the selection stays
          // visible when focus moves elsewhere (e.g. into the editor context menu).
          drawSelection(),
          bracketMatching(),
          highlightActiveLine(),
          EditorView.lineWrapping,
          markdown(),
          syntaxHighlighting(markdownHighlightStyle),
          commentDecorationPlugin,
          autocompletion({
            override: [linkCompletionSource],
            activateOnTyping: true,
          }),
          Prec.high(keymap.of(formattingKeymap)),
          keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap]),
          EditorView.domEventHandlers({
            click: (event, view) => {
              if (event.metaKey || event.ctrlKey) {
                const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
                if (pos !== null) {
                  const line = view.state.doc.lineAt(pos);
                  const col = pos - line.from;
                  const link = findLinkAtPos(line.text, col);
                  if (link) {
                    event.preventDefault();
                    navigateToLink(link.target);
                    return true;
                  }
                }
              }
              return false;
            },
            contextmenu: (event) => {
              if (viewModeRef.current === 'read') return false;
              event.preventDefault();
              setContextMenuState({ x: event.clientX, y: event.clientY });
              return true;
            },
            keydown: (event, view) => {
              if (viewModeRef.current === 'read') return false;
              // The OS "Menu" key, and Shift-F10 as its standard alternate, open the same menu
              // anchored at the text cursor rather than the mouse (keyboard-only users).
              if (event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey)) {
                event.preventDefault();
                const coords = view.coordsAtPos(view.state.selection.main.head);
                if (coords) {
                  setContextMenuState({ x: coords.left, y: coords.bottom });
                }
                return true;
              }
              return false;
            },
          }),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) {
              onContentChangeRef.current(update.state.doc.toString());
            }
            if (update.selectionSet) {
              setContextMenuState(null);
            }
            if (update.focusChanged && !update.view.hasFocus) {
              if (onBlurSaveRef.current) {
                onBlurSaveRef.current();
              }
            }
            if (onScrollOrCursorChangeRef.current) {
              const scroller = update.view.scrollDOM;
              const sel = update.state.selection.main;
              const line = update.state.doc.lineAt(sel.head);
              const cursorLine = line.number;
              const cursorCol = sel.head - line.from + 1;
              const selectionLength = Math.abs(sel.to - sel.from);
              onScrollOrCursorChangeRef.current(
                scroller.scrollTop,
                sel.head,
                cursorLine,
                cursorCol,
                selectionLength
              );
            }
          }),
        ],
      });

      const view = new EditorView({
        state: startState,
        parent: editorContainerRef.current,
      });

      // Restore saved cursor & scroll if provided
      if (savedCursorPos !== undefined && savedCursorPos <= startState.doc.length) {
        view.dispatch({
          selection: { anchor: savedCursorPos },
        });
      }
      if (savedScrollTop !== undefined) {
        view.scrollDOM.scrollTop = savedScrollTop;
      }

      editorViewRef.current = view;
      loadedNotePathRef.current = note.path;
    } else {
      // Same note: if external reload happened (e.g. disk load), synchronize if doc changed externally
      const currentDoc = editorViewRef.current.state.doc.toString();
      if (currentDoc !== note.content && !isDirty) {
        editorViewRef.current.dispatch({
          changes: { from: 0, to: currentDoc.length, insert: note.content },
        });
      }
    }
  }, [note.path, note.content, isDirty, savedCursorPos, savedScrollTop]);

  // Clean up on unmount
  useEffect(() => {
    return () => {
      if (editorViewRef.current) {
        editorViewRef.current.destroy();
        editorViewRef.current = null;
      }
    };
  }, []);

  // Handle reader link clicks
  const handleReaderClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const target = (e.target as HTMLElement).closest('a');
    if (target) {
      const href = target.getAttribute('href');
      if (href) {
        if (href.startsWith('#/note/')) {
          e.preventDefault();
          const targetPathWithAnchor = href.replace('#/note/', '');
          onNavigateRelative(targetPathWithAnchor);
        } else if (href.startsWith('#/create-note/')) {
          e.preventDefault();
          const targetPathWithAnchor = href.replace('#/create-note/', '');
          const cleanPath = targetPathWithAnchor.split('#')[0];
          if (onCreateNote) {
            onCreateNote(cleanPath);
          }
        } else if (href.startsWith('#')) {
          e.preventDefault();
          const anchor = href.slice(1);
          const targetElem = readerContainerRef.current?.querySelector(`#${CSS.escape(anchor)}`);
          if (targetElem) {
            targetElem.scrollIntoView({ behavior: 'smooth', block: 'start' });
          }
        } else if (href.startsWith('http://') || href.startsWith('https://') || href.startsWith('mailto:')) {
          e.preventDefault();
          if (onOpenExternal) {
            onOpenExternal(href);
          }
        }
      }
    }
  };

  return (
    <main className="flex-1 flex flex-col min-w-0 bg-[var(--canvas)] select-none">
      {/* Note Bar */}
      <div className="flex items-center gap-2 h-[33px] shrink-0 px-3.5 border-b border-[var(--border)] text-xs text-[var(--muted)] bg-[var(--panel)]">
        {/* Unsaved dirty dot indicator */}
        <span
          className={`text-base leading-none transition-opacity ${
            isDirty ? 'text-[var(--spark)] opacity-100' : 'opacity-0'
          }`}
          title={isDirty ? 'Unsaved changes' : 'Saved'}
        >
          ●
        </span>

        {/* Note path */}
        <span className="font-mono text-[11.5px] text-[var(--text-2)] truncate">
          {note.path || 'No note open'}
        </span>
        {note.path && <span className="text-[var(--faint)] text-[11px]">· {note.lastModifiedAgo}</span>}

        {/* Close Note Tab Button */}
        {note.path && (
          <button
            onClick={onCloseNote}
            className="ml-1 p-0.5 rounded hover:bg-[var(--panel-2)] hover:text-[var(--text)] text-[var(--muted)] transition-colors text-xs flex items-center justify-center w-4 h-4"
            title="Close tab (⌘W)"
            aria-label="Close note"
          >
            ✕
          </button>
        )}

        {/* History navigation affordances */}
        <div className="ml-auto flex items-center gap-0.5">
          <button
            onClick={onBack}
            className="w-6 h-6 grid place-items-center rounded text-[var(--muted)] hover:bg-[var(--panel-2)] hover:text-[var(--text)] transition-colors text-sm"
            title="Back in history (⌘[)"
          >
            ‹
          </button>
          <button
            onClick={onForward}
            className="w-6 h-6 grid place-items-center rounded text-[var(--muted)] hover:bg-[var(--panel-2)] hover:text-[var(--text)] transition-colors text-sm"
            title="Forward in history (⌘])"
          >
            ›
          </button>
          <button
            className="w-6 h-6 grid place-items-center rounded text-[var(--muted)] hover:bg-[var(--panel-2)] hover:text-[var(--text)] transition-colors text-xs"
            title="Reveal in Finder / File Manager (⌘⇧R)"
          >
            ⤤
          </button>
        </div>
      </div>

      {/* External Change Conflict Banner */}
      <ConflictBanner
        visible={showConflictBanner}
        onKeepVersion={onKeepVersion}
        onLoadFromDisk={onLoadFromDisk}
        onShowDifferences={onShowDifferences}
      />

      {/* Center View Area (Edit, Read, or Split) */}
      {!note.path ? (
        <div className="flex-1 flex flex-col items-center justify-center text-center p-6 bg-[var(--canvas)]">
          <div className="text-sm font-medium text-[var(--muted)] mb-2">No note selected</div>
          <div className="text-xs text-[var(--faint)]">Select a note from the sidebar or press ⌘P to open one.</div>
        </div>
      ) : (
        <div className="flex-1 flex min-h-0">
          {/* CodeMirror Editor Pane: Always mounted, styled according to viewMode */}
          <div
            className={`h-full min-w-0 overflow-auto ${
              viewMode === 'edit'
                ? 'w-full block'
                : viewMode === 'split'
                ? 'w-1/2 border-r border-[var(--border)] block'
                : 'hidden'
            }`}
          >
            <div ref={editorContainerRef} className="h-full" />
          </div>

          {contextMenuState && viewMode !== 'read' && (
            <ContextMenu
              x={contextMenuState.x}
              y={contextMenuState.y}
              items={buildMenuItems()}
              onClose={() => setContextMenuState(null)}
            />
          )}

          {tableBuilderState && (
            <TableBuilderModal
              isOpen={true}
              initial={tableBuilderState.initial}
              onInsert={handleTableBuilderInsert}
              onCancel={() => setTableBuilderState(null)}
            />
          )}

          {/* Reader Pane: Mounted and toggled via CSS */}
          <div
            ref={readerContainerRef}
            className={`h-full min-w-0 overflow-auto bg-[var(--canvas)] ${
              viewMode === 'read'
                ? 'w-full block'
                : viewMode === 'split'
                ? 'w-1/2 block'
                : 'hidden'
            }`}
            onClick={handleReaderClick}
          >
            <div
              className="reader-content"
              dangerouslySetInnerHTML={{ __html: note.renderedHtml }}
            />
          </div>
        </div>
      )}
    </main>
  );
};
