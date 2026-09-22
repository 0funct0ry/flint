import React, { useEffect, useRef } from 'react';
import { EditorSelection, EditorState, Prec } from '@codemirror/state';
import { EditorView, keymap, highlightActiveLine } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { markdown } from '@codemirror/lang-markdown';
import { searchKeymap, openSearchPanel } from '@codemirror/search';
import { bracketMatching } from '@codemirror/language';
import { ViewMode } from './TitleBar';
import { NoteFixture } from '../types';
import { ConflictBanner } from './ConflictBanner';

export interface CenterPaneProps {
  note: NoteFixture;
  viewMode: ViewMode;
  isDirty: boolean;
  onContentChange: (newContent: string) => void;
  onSaveNow?: () => void;
  onBlurSave?: () => void;
  onNavigateRelative: (target: string) => void;
  showConflictBanner: boolean;
  onKeepVersion: () => void;
  onLoadFromDisk: () => void;
  onShowDifferences: () => void;
  onBack: () => void;
  onForward: () => void;
}

/**
 * Format markdown selection helper for bold (**text**), italic (*text*), link ([text](url))
 */
function wrapSelection(view: EditorView, before: string, after: string, placeholder = '') {
  const { state, dispatch } = view;
  const changes = state.changeByRange((range) => {
    const selected = state.sliceDoc(range.from, range.to) || placeholder;
    const insert = `${before}${selected}${after}`;
    return {
      changes: { from: range.from, to: range.to, insert },
      range: range.empty
        ? EditorSelection.range(range.from + before.length, range.from + before.length + placeholder.length)
        : EditorSelection.range(range.from, range.from + insert.length),
    };
  });
  dispatch(changes);
  return true;
}

/**
 * Handle Markdown list continuation on Enter
 */
function handleListContinuation(view: EditorView): boolean {
  const { state } = view;
  const line = state.doc.lineAt(state.selection.main.head);
  const text = line.text;

  // Check for unordered list item (- , * , + ) or ordered list item (1. , 2. ) or task list (- [ ] )
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

export const CenterPane: React.FC<CenterPaneProps> = ({
  note,
  viewMode,
  isDirty,
  onContentChange,
  onSaveNow,
  onBlurSave,
  onNavigateRelative,
  showConflictBanner,
  onKeepVersion,
  onLoadFromDisk,
  onShowDifferences,
  onBack,
  onForward,
}) => {
  const editorContainerRef = useRef<HTMLDivElement>(null);
  const editorViewRef = useRef<EditorView | null>(null);

  const onContentChangeRef = useRef(onContentChange);
  onContentChangeRef.current = onContentChange;

  const onSaveNowRef = useRef(onSaveNow);
  onSaveNowRef.current = onSaveNow;

  const onBlurSaveRef = useRef(onBlurSave);
  onBlurSaveRef.current = onBlurSave;

  // Initialize CodeMirror 6 editor instance with full SPEC §8.2 extension suite
  useEffect(() => {
    if (!editorContainerRef.current) return;

    const formattingKeymap = [
      {
        key: 'Mod-b',
        run: (view: EditorView) => wrapSelection(view, '**', '**', 'bold text'),
      },
      {
        key: 'Mod-i',
        run: (view: EditorView) => wrapSelection(view, '*', '*', 'italic text'),
      },
      {
        key: 'Mod-k',
        run: (view: EditorView) => wrapSelection(view, '[', '](https://)', 'link text'),
      },
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
    ];

    const startState = EditorState.create({
      doc: note.content,
      extensions: [
        history(),
        bracketMatching(),
        highlightActiveLine(),
        EditorView.lineWrapping,
        markdown(),
        Prec.high(keymap.of(formattingKeymap)),
        keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap]),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) {
            onContentChangeRef.current(update.state.doc.toString());
          }
          if (update.focusChanged && !update.view.hasFocus) {
            if (onBlurSaveRef.current) {
              onBlurSaveRef.current();
            }
          }
        }),
      ],
    });

    const view = new EditorView({
      state: startState,
      parent: editorContainerRef.current,
    });

    editorViewRef.current = view;

    return () => {
      view.destroy();
    };
  }, [note.path, note.content]);

  // Handle reader link clicks
  const handleReaderClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const target = (e.target as HTMLElement).closest('a');
    if (target) {
      e.preventDefault();
      const href = target.getAttribute('href');
      if (href && href.startsWith('#/note/')) {
        const notePath = href.replace('#/note/', '');
        onNavigateRelative(notePath);
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

          {/* Reader Pane: Mounted and toggled via CSS */}
          <div
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
