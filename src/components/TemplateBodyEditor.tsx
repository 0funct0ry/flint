import React, { useEffect, useRef, useState } from 'react';
import { EditorSelection, EditorState } from '@codemirror/state';
import { EditorView, keymap, drawSelection, highlightActiveLine } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { markdown } from '@codemirror/lang-markdown';
import { bracketMatching } from '@codemirror/language';
import { autocompletion } from '@codemirror/autocomplete';
import { createTemplatePlaceholderCompletionSource } from '../services/templateCompletion';
import { buildEditorContextMenuItems, buildFormattingKeymap, setOpenTableBuilder } from '../services/editorContextMenu';
import { ContextMenu } from './ContextMenu';
import { TableBuilderModal, TableBuilderInitial } from './TableBuilderModal';
import { parseDelimitedSelection, ColumnAlignment } from '../commands/tableBuilder';

export interface TemplateBodyEditorProps {
  initialValue: string;
  onChange: (value: string) => void;
  /** Declared variable names, for the `var.` completion branch — read live via a ref so
   * adding/renaming a variable row updates completions without remounting the editor. */
  variableNames: string[];
  className?: string;
}

/**
 * A standalone CodeMirror 6 Markdown editor for a template's body (M10.27 follow-up). Not
 * `CenterPane`'s full note editor (no link/tag autocomplete, no cursor/scroll persistence, no
 * fingerprint/conflict handling — a template file has none of that note-specific state), but it
 * shares the exact same Insert/Format/Paragraph/link/clipboard context menu, formatting keymap,
 * and Table Builder support via `services/editorContextMenu` — a template body is still Markdown,
 * and gets the same editing affordances a note does. Placeholder (`{{...}}`) completion is the one
 * thing genuinely specific to a template body, layered on top via its own completion source.
 * Picks up the app's theme for free via the same global `.cm-editor` CSS rules the note editor
 * uses (see `src/index.css`); no separate theme wiring needed.
 *
 * Remount this component (via a `key` on the parent, the same pattern `TemplatesScreen` already
 * uses for `TemplateForm`) when switching between templates — it only reads `initialValue` once,
 * on mount, exactly like every other CodeMirror instance in this codebase.
 */
export const TemplateBodyEditor: React.FC<TemplateBodyEditorProps> = ({
  initialValue,
  onChange,
  variableNames,
  className,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const [, forceRerender] = useState(0);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const variableNamesRef = useRef(variableNames);
  variableNamesRef.current = variableNames;

  const [contextMenuState, setContextMenuState] = useState<{ x: number; y: number } | null>(null);
  const [tableBuilderState, setTableBuilderState] = useState<{
    initial: TableBuilderInitial;
    selectionRange: { from: number; to: number } | null;
  } | null>(null);

  // Bridge `editor.insert_table_builder`'s `run` (module-level, in `EDITOR_COMMANDS`) into this
  // instance's modal state — same pattern `CenterPane` uses. Only one CodeMirror instance is ever
  // mounted at a time in this app (the Templates screen replaces the note editor entirely), so
  // this single shared slot is safe.
  useEffect(() => {
    setOpenTableBuilder((view) => {
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
    });
    return () => {
      setOpenTableBuilder(null);
    };
  }, []);

  const handleTableBuilderInsert = (markdownText: string, replaceSelection: boolean) => {
    const view = viewRef.current;
    setTableBuilderState(null);
    if (!view) return;
    view.focus();
    const { state } = view;
    const from = replaceSelection && tableBuilderState?.selectionRange ? tableBuilderState.selectionRange.from : state.selection.main.head;
    const to = replaceSelection && tableBuilderState?.selectionRange ? tableBuilderState.selectionRange.to : state.selection.main.head;
    const firstCellOffset = 2;
    view.dispatch({
      changes: { from, to, insert: markdownText },
      selection: EditorSelection.cursor(from + firstCellOffset),
    });
  };

  useEffect(() => {
    if (!containerRef.current) return;

    const completionSource = createTemplatePlaceholderCompletionSource(
      () => variableNamesRef.current
    );

    const state = EditorState.create({
      doc: initialValue,
      extensions: [
        history(),
        drawSelection(),
        bracketMatching(),
        highlightActiveLine(),
        EditorView.lineWrapping,
        markdown(),
        autocompletion({ override: [completionSource], activateOnTyping: true }),
        keymap.of(buildFormattingKeymap()),
        keymap.of([...defaultKeymap, ...historyKeymap]),
        EditorView.domEventHandlers({
          contextmenu: (event) => {
            event.preventDefault();
            setContextMenuState({ x: event.clientX, y: event.clientY });
            return true;
          },
          keydown: (event, view) => {
            // The OS "Menu" key, and Shift-F10 as its standard alternate, open the same menu
            // anchored at the text cursor rather than the mouse — same as the note editor.
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
            onChangeRef.current(update.state.doc.toString());
          }
          if (update.selectionSet) {
            // Re-render so the context menu (if open) reflects the current selection/cursor —
            // mirrors `CenterPane`'s own selectionSet handling.
            forceRerender((n) => n + 1);
          }
        }),
      ],
    });

    const view = new EditorView({ state, parent: containerRef.current });
    viewRef.current = view;

    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // `initialValue` is intentionally read only once, on mount — the parent remounts this
    // component (via `key`) to load a different template rather than pushing updated content in.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div
      className={
        className ?? 'h-full min-h-0 border border-[var(--border)] rounded-[5px] overflow-hidden'
      }
    >
      <div ref={containerRef} className="h-full" aria-label="Template body" />

      {contextMenuState && viewRef.current && (
        <ContextMenu
          x={contextMenuState.x}
          y={contextMenuState.y}
          items={buildEditorContextMenuItems(viewRef.current)}
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
    </div>
  );
};
