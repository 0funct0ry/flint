import React, { useEffect, useRef } from 'react';
import katex from 'katex';
import { EditorSelection, EditorState, Prec } from '@codemirror/state';
import { EditorView, keymap, highlightActiveLine } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { markdown } from '@codemirror/lang-markdown';
import { searchKeymap, openSearchPanel } from '@codemirror/search';
import { bracketMatching } from '@codemirror/language';
import { autocompletion, CompletionContext, CompletionResult } from '@codemirror/autocomplete';
import { ViewMode } from './TitleBar';
import { NoteFixture, TreeNodeItem } from '../types';
import { ConflictBanner } from './ConflictBanner';

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
  treeData?: TreeNodeItem[];
  savedScrollTop?: number;
  savedCursorPos?: number;
  onScrollOrCursorChange?: (scrollTop: number, cursorPos: number) => void;
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
  treeData = [],
  savedScrollTop,
  savedCursorPos,
  onScrollOrCursorChange,
}) => {
  const editorContainerRef = useRef<HTMLDivElement>(null);
  const readerContainerRef = useRef<HTMLDivElement>(null);
  const editorViewRef = useRef<EditorView | null>(null);
  const isScrollingSyncRef = useRef(false);

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

  const onScrollOrCursorChangeRef = useRef(onScrollOrCursorChange);
  onScrollOrCursorChangeRef.current = onScrollOrCursorChange;

  // Track the note path currently loaded in the editor instance
  const loadedNotePathRef = useRef<string>('');

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
      targetElem.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }, [scrollToAnchor]);

  // Track active heading in view as reader scrolls
  useEffect(() => {
    const reader = readerContainerRef.current;
    if (!reader || !onHeadingInView) return;

    const handleScroll = () => {
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

  // Synchronized scrolling in split view
  useEffect(() => {
    if (viewMode !== 'split') return;

    const editorScroller = editorContainerRef.current?.querySelector('.cm-scroller');
    const reader = readerContainerRef.current;
    if (!editorScroller || !reader) return;

    const handleEditorScroll = () => {
      if (isScrollingSyncRef.current) return;
      isScrollingSyncRef.current = true;

      const editorScrollTop = editorScroller.scrollTop;
      const editorScrollHeight = editorScroller.scrollHeight - editorScroller.clientHeight;
      const progress = editorScrollHeight > 0 ? editorScrollTop / editorScrollHeight : 0;

      const readerScrollHeight = reader.scrollHeight - reader.clientHeight;
      reader.scrollTop = progress * readerScrollHeight;

      requestAnimationFrame(() => {
        isScrollingSyncRef.current = false;
      });
    };

    const handleReaderScroll = () => {
      if (isScrollingSyncRef.current) return;
      isScrollingSyncRef.current = true;

      const readerScrollTop = reader.scrollTop;
      const readerScrollHeight = reader.scrollHeight - reader.clientHeight;
      const progress = readerScrollHeight > 0 ? readerScrollTop / readerScrollHeight : 0;

      const editorScrollHeight = editorScroller.scrollHeight - editorScroller.clientHeight;
      editorScroller.scrollTop = progress * editorScrollHeight;

      requestAnimationFrame(() => {
        isScrollingSyncRef.current = false;
      });
    };

    editorScroller.addEventListener('scroll', handleEditorScroll, { passive: true });
    reader.addEventListener('scroll', handleReaderScroll, { passive: true });

    return () => {
      editorScroller.removeEventListener('scroll', handleEditorScroll);
      reader.removeEventListener('scroll', handleReaderScroll);
    };
  }, [viewMode, note.path]);

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
    if (!editorContainerRef.current) return;
    if (!note.path) {
      if (editorViewRef.current) {
        editorViewRef.current.destroy();
        editorViewRef.current = null;
      }
      loadedNotePathRef.current = '';
      return;
    }

    // Link autocomplete completion source
    const linkCompletionSource = (context: CompletionContext): CompletionResult | null => {
      const line = context.state.doc.lineAt(context.pos);
      const lineBefore = line.text.slice(0, context.pos - line.from);

      // Trigger on `[` or `](`
      const openBracketMatch = /\[([^\]]*)$/.exec(lineBefore);
      const openParenMatch = /\]\(([^)]*)$/.exec(lineBefore);

      const notes = getAllNotePaths(treeDataRef.current);
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

    // If switching to a new note, create/re-create editor
    if (loadedNotePathRef.current !== note.path || !editorViewRef.current) {
      if (editorViewRef.current) {
        editorViewRef.current.destroy();
      }

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
          bracketMatching(),
          highlightActiveLine(),
          EditorView.lineWrapping,
          markdown(),
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
          }),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) {
              onContentChangeRef.current(update.state.doc.toString());
            }
            if (update.focusChanged && !update.view.hasFocus) {
              if (onBlurSaveRef.current) {
                onBlurSaveRef.current();
              }
            }
            if (onScrollOrCursorChangeRef.current) {
              const scroller = update.view.scrollDOM;
              const cursor = update.state.selection.main.head;
              onScrollOrCursorChangeRef.current(scroller.scrollTop, cursor);
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
  }, [note.path, note.content, isDirty]);

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
