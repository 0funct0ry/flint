import React, { useEffect, useRef } from 'react';
import { EditorState } from '@codemirror/state';
import { EditorView, keymap, highlightActiveLine } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { markdown } from '@codemirror/lang-markdown';
import { ViewMode } from './TitleBar';
import { NoteFixture } from '../types';
import { ConflictBanner } from './ConflictBanner';

export interface CenterPaneProps {
  note: NoteFixture;
  viewMode: ViewMode;
  isDirty: boolean;
  onContentChange: (newContent: string) => void;
  onNavigateRelative: (target: string) => void;
  showConflictBanner: boolean;
  onKeepVersion: () => void;
  onLoadFromDisk: () => void;
  onShowDifferences: () => void;
  onBack: () => void;
  onForward: () => void;
}

export const CenterPane: React.FC<CenterPaneProps> = ({
  note,
  viewMode,
  isDirty,
  onContentChange,
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

  // Initialize CodeMirror 6 editor instance
  useEffect(() => {
    if (!editorContainerRef.current) return;

    const startState = EditorState.create({
      doc: note.content,
      extensions: [
        history(),
        keymap.of([...defaultKeymap, ...historyKeymap]),
        markdown(),
        highlightActiveLine(),
        EditorView.lineWrapping,
        EditorView.updateListener.of((update) => {
          if (update.docChanged) {
            onContentChangeRef.current(update.state.doc.toString());
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
          {note.path}
        </span>
        <span className="text-[var(--faint)] text-[11px]">· {note.lastModifiedAgo}</span>

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
      <div className="flex-1 flex min-h-0">
        {/* CodeMirror Editor Pane */}
        {(viewMode === 'edit' || viewMode === 'split') && (
          <div
            className={`h-full min-w-0 overflow-auto ${
              viewMode === 'split' ? 'w-1/2 border-r border-[var(--border)]' : 'w-full'
            }`}
          >
            <div ref={editorContainerRef} className="h-full" />
          </div>
        )}

        {/* Pre-baked Reader Pane */}
        {(viewMode === 'read' || viewMode === 'split') && (
          <div
            className={`h-full min-w-0 overflow-auto bg-[var(--canvas)] ${
              viewMode === 'split' ? 'w-1/2' : 'w-full'
            }`}
            onClick={handleReaderClick}
          >
            <div
              className="reader-content"
              dangerouslySetInnerHTML={{ __html: note.renderedHtml }}
            />
          </div>
        )}
      </div>
    </main>
  );
};
