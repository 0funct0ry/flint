import React, { useState, useEffect, useCallback, useRef } from 'react';
import { TitleBar, ViewMode } from './components/TitleBar';
import { LeftSidebar, LeftTab } from './components/LeftSidebar';
import { CenterPane } from './components/CenterPane';
import { RightSidebar } from './components/RightSidebar';
import { StatusBar } from './components/StatusBar';
import { CommandPalette } from './components/CommandPalette';
import { DiffViewer } from './components/DiffViewer';
import {
  FIXTURE_NOTES,
  FIXTURE_WORKSPACE_NAME,
  FIXTURE_ROOT_PATH,
} from './fixtures/workspace';
import { commandRegistry } from './commands/registry';
import { Fingerprint, NoteContent, NoteFixture, TreeNodeItem, WorkspaceInfo } from './types';
import { api } from './services/ipc';
import { renderMarkdownToHtml } from './services/markdown';

export const App: React.FC = () => {
  const [theme, setTheme] = useState<'light' | 'dark'>('dark');
  const [viewMode, setViewMode] = useState<ViewMode>('split');
  const [leftTab, setLeftTab] = useState<LeftTab>('tree');
  const [leftSidebarVisible, setLeftSidebarVisible] = useState(true);
  const [rightSidebarVisible, setRightSidebarVisible] = useState(true);

  // Live workspace state
  const [workspaceInfo, setWorkspaceInfo] = useState<WorkspaceInfo>({
    name: FIXTURE_WORKSPACE_NAME,
    path: FIXTURE_ROOT_PATH,
    is_empty: false,
  });
  const [treeData, setTreeData] = useState<TreeNodeItem[]>([]);
  const [treeError, setTreeError] = useState<string | null>(null);

  // Active note path & state
  const [currentNotePath, setCurrentNotePath] = useState<string>('');
  const [noteState, setNoteState] = useState<Record<string, NoteFixture>>(FIXTURE_NOTES);
  const [noteFingerprints, setNoteFingerprints] = useState<Record<string, Fingerprint>>({});
  const [isDirty, setIsDirty] = useState(false);

  // Conflict handling state
  const [showConflictBanner, setShowConflictBanner] = useState(false);
  const [diskVersionContent, setDiskVersionContent] = useState<string>('');
  const [diffViewerOpen, setDiffViewerOpen] = useState(false);

  // Palette modal state
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [paletteMode, setPaletteMode] = useState<'notes' | 'commands'>('notes');

  // Navigation history
  const [history, setHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);

  // Autosave timer reference (400ms debounce)
  const autosaveTimerRef = useRef<NodeJS.Timeout | null>(null);
  const currentNoteRef = useRef<{ path: string; content: string; fingerprint?: Fingerprint; isDirty: boolean }>({
    path: currentNotePath,
    content: noteState[currentNotePath]?.content || '',
    fingerprint: noteFingerprints[currentNotePath],
    isDirty: false,
  });

  useEffect(() => {
    currentNoteRef.current = {
      path: currentNotePath,
      content: noteState[currentNotePath]?.content || '',
      fingerprint: noteFingerprints[currentNotePath],
      isDirty,
    };
  }, [currentNotePath, noteState, noteFingerprints, isDirty]);

  // Load note via IPC
  const loadNote = useCallback(async (path: string) => {
    if (!path) return;
    try {
      const noteContent: NoteContent = await api.noteRead(path);
      setNoteFingerprints((prev) => ({
        ...prev,
        [path]: noteContent.fingerprint,
      }));

      const renderedHtml = renderMarkdownToHtml(noteContent.content);

      setNoteState((prev) => {
        const existing = prev[path] || FIXTURE_NOTES[path] || {
          path,
          title: noteContent.meta.title,
          folder: path.split('/').slice(0, -1).join('/'),
          tags: noteContent.meta.tags,
          content: noteContent.content,
          renderedHtml,
          headings: noteContent.meta.headings,
          outgoingLinks: [],
          backlinks: [],
          lastModifiedAgo: 'just now',
        };

        return {
          ...prev,
          [path]: {
            ...existing,
            title: noteContent.meta.title,
            tags: noteContent.meta.tags,
            headings: noteContent.meta.headings,
            content: noteContent.content,
            renderedHtml,
          },
        };
      });

      setIsDirty(false);
      setShowConflictBanner(false);
    } catch (err) {
      console.warn(`Failed to read note ${path}:`, err);
    }
  }, []);

  // Save note via IPC
  const saveNote = useCallback(
    async (force = false) => {
      const { path, content, fingerprint, isDirty: dirty } = currentNoteRef.current;
      if (!path || (!dirty && !force)) return;

      try {
        const newFingerprint = await api.noteWrite(
          path,
          content,
          force ? undefined : fingerprint
        );

        setNoteFingerprints((prev) => ({
          ...prev,
          [path]: newFingerprint,
        }));
        setIsDirty(false);
        setShowConflictBanner(false);
      } catch (err: any) {
        const errMsg = err?.message || String(err);
        if (errMsg.toLowerCase().includes('conflict')) {
          // Note changed on disk externally
          setShowConflictBanner(true);
          try {
            const diskNote = await api.noteRead(path);
            setDiskVersionContent(diskNote.content);
          } catch {
            setDiskVersionContent('');
          }
        } else {
          console.error(`Error saving note ${path}:`, err);
        }
      }
    },
    []
  );

  // Load workspace and tree from real IPC once on mount
  useEffect(() => {
    let mounted = true;

    async function loadWorkspace() {
      try {
        const info = await api.workspaceOpen();
        if (mounted) {
          setWorkspaceInfo(info);
        }
        const tree = await api.workspaceTree(false);
        if (mounted) {
          setTreeData(tree);
          setTreeError(null);
        }
      } catch (err: any) {
        if (mounted) {
          setTreeError(err?.message || String(err));
        }
      }
    }

    loadWorkspace();
    return () => {
      mounted = false;
    };
  }, []);

  // Window blur / beforeunload save
  useEffect(() => {
    const handleBlur = () => {
      saveNote(false);
    };

    window.addEventListener('blur', handleBlur);
    window.addEventListener('beforeunload', handleBlur);
    return () => {
      window.removeEventListener('blur', handleBlur);
      window.removeEventListener('beforeunload', handleBlur);
    };
  }, [saveNote]);

  // Apply theme to html root
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
  }, [theme]);

  // Mode cycle helper (⌘E)
  const cycleViewMode = useCallback(() => {
    setViewMode((prev) => {
      if (prev === 'edit') return 'read';
      if (prev === 'read') return 'split';
      return 'edit';
    });
  }, []);

  // Note selection
  const handleSelectNote = useCallback(
    async (path: string) => {
      if (path === currentNotePath) return;

      // Save previous note if dirty before navigating
      if (isDirty) {
        await saveNote(false);
      }

      setCurrentNotePath(path);
      setHistory((prev) => [...prev.slice(0, historyIndex + 1), path]);
      setHistoryIndex((prev) => prev + 1);

      await loadNote(path);
    },
    [currentNotePath, historyIndex, isDirty, loadNote, saveNote]
  );

  // History back / forward
  const handleBack = useCallback(async () => {
    if (historyIndex > 0) {
      if (isDirty) {
        await saveNote(false);
      }
      const target = history[historyIndex - 1];
      setHistoryIndex(historyIndex - 1);
      setCurrentNotePath(target);
      await loadNote(target);
    }
  }, [history, historyIndex, isDirty, loadNote, saveNote]);

  const handleForward = useCallback(async () => {
    if (historyIndex < history.length - 1) {
      if (isDirty) {
        await saveNote(false);
      }
      const target = history[historyIndex + 1];
      setHistoryIndex(historyIndex + 1);
      setCurrentNotePath(target);
      await loadNote(target);
    }
  }, [history, historyIndex, isDirty, loadNote, saveNote]);

  // Register commands in registry per SPEC §9.3
  useEffect(() => {
    commandRegistry.register({
      id: 'palette.notes',
      title: 'Search notes by name',
      shortcut: '⌘P',
      shortcutDisplay: '⌘P',
      handler: () => {
        setPaletteMode('notes');
        setPaletteOpen(true);
      },
    });

    commandRegistry.register({
      id: 'palette.commands',
      title: 'Show all commands',
      shortcut: '⌘⇧P',
      shortcutDisplay: '⌘⇧P',
      handler: () => {
        setPaletteMode('commands');
        setPaletteOpen(true);
      },
    });

    commandRegistry.register({
      id: 'search.content',
      title: 'Search content in workspace',
      shortcut: '⌘⇧F',
      shortcutDisplay: '⌘⇧F',
      handler: () => {
        setLeftSidebarVisible(true);
        setLeftTab('search');
      },
    });

    commandRegistry.register({
      id: 'file.save',
      title: 'Save note now',
      shortcut: '⌘S',
      shortcutDisplay: '⌘S',
      handler: () => saveNote(false),
    });

    commandRegistry.register({
      id: 'view.cycle_mode',
      title: 'Cycle view mode (edit / read / split)',
      shortcut: '⌘E',
      shortcutDisplay: '⌘E',
      handler: cycleViewMode,
    });

    commandRegistry.register({
      id: 'view.toggle_left_sidebar',
      title: 'Toggle left sidebar',
      shortcut: '⌘B',
      shortcutDisplay: '⌘B',
      handler: () => setLeftSidebarVisible((prev) => !prev),
    });

    commandRegistry.register({
      id: 'view.toggle_right_sidebar',
      title: 'Toggle right sidebar',
      shortcut: '⌘⌥B',
      shortcutDisplay: '⌘⌥B',
      handler: () => setRightSidebarVisible((prev) => !prev),
    });

    commandRegistry.register({
      id: 'theme.toggle',
      title: 'Toggle light / dark theme',
      handler: () => setTheme((prev) => (prev === 'dark' ? 'light' : 'dark')),
    });

    commandRegistry.register({
      id: 'dev.trigger_conflict_banner',
      title: 'Trigger external-change conflict banner (demo)',
      handler: () => {
        setDiskVersionContent('# Disk Title\n\nExternal version changed on disk.');
        setShowConflictBanner(true);
      },
    });
  }, [cycleViewMode, saveNote]);

  // Global keydown listeners
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const isMac = navigator.platform.toUpperCase().indexOf('MAC') >= 0;
      const mod = isMac ? e.metaKey : e.ctrlKey;

      if (mod && e.key.toLowerCase() === 'p' && !e.shiftKey) {
        e.preventDefault();
        setPaletteMode('notes');
        setPaletteOpen(true);
      } else if (mod && e.key.toLowerCase() === 'p' && e.shiftKey) {
        e.preventDefault();
        setPaletteMode('commands');
        setPaletteOpen(true);
      } else if (mod && e.key.toLowerCase() === 'f' && e.shiftKey) {
        e.preventDefault();
        setLeftSidebarVisible(true);
        setLeftTab('search');
      } else if (mod && e.key.toLowerCase() === 'e') {
        e.preventDefault();
        cycleViewMode();
      } else if (mod && e.key.toLowerCase() === 'b' && !e.altKey) {
        e.preventDefault();
        setLeftSidebarVisible((prev) => !prev);
      } else if (mod && e.altKey && e.key.toLowerCase() === 'b') {
        e.preventDefault();
        setRightSidebarVisible((prev) => !prev);
      } else if (mod && e.key === '[') {
        e.preventDefault();
        handleBack();
      } else if (mod && e.key === ']') {
        e.preventDefault();
        handleForward();
      } else if (mod && e.key.toLowerCase() === 's') {
        e.preventDefault();
        saveNote(false);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [cycleViewMode, handleBack, handleForward, saveNote]);

  const currentNote = currentNotePath
    ? noteState[currentNotePath] ||
      FIXTURE_NOTES[currentNotePath] || {
        path: currentNotePath,
        title: currentNotePath.split('/').pop()?.replace(/\.md$/, '') || 'Untitled',
        folder: currentNotePath.split('/').slice(0, -1).join('/'),
        tags: [],
        content: '',
        headings: [],
        outgoingLinks: [],
        backlinks: [],
        renderedHtml: '',
        lastModifiedAgo: 'just now',
      }
    : {
        path: '',
        title: '',
        folder: '',
        tags: [],
        content: '',
        headings: [],
        outgoingLinks: [],
        backlinks: [],
        renderedHtml: '',
        lastModifiedAgo: '',
      };

  const breadcrumb = currentNotePath
    ? `${workspaceInfo.name}/${currentNotePath.replace(/^projects\//, '')}`
    : workspaceInfo.name;

  // Content change handler with 400ms debounced autosave
  const handleContentChange = (newContent: string) => {
    setIsDirty(true);
    const renderedHtml = renderMarkdownToHtml(newContent);
    setNoteState((prev) => ({
      ...prev,
      [currentNotePath]: {
        ...prev[currentNotePath],
        content: newContent,
        renderedHtml,
      },
    }));

    // Debounce autosave 400ms
    if (autosaveTimerRef.current) {
      clearTimeout(autosaveTimerRef.current);
    }
    autosaveTimerRef.current = setTimeout(() => {
      saveNote(false);
    }, 400);
  };

  return (
    <div className="flex flex-col h-screen w-screen bg-[var(--canvas)] text-[var(--text)] overflow-hidden font-ui">
      {/* Title bar */}
      <TitleBar
        breadcrumb={breadcrumb}
        viewMode={viewMode}
        onViewModeChange={setViewMode}
        onOpenPalette={() => {
          setPaletteMode('notes');
          setPaletteOpen(true);
        }}
        onToggleTheme={() =>
          setTheme((prev) => (prev === 'dark' ? 'light' : 'dark'))
        }
        theme={theme}
      />

      {/* Main body with sidebars & editor/reader */}
      <div className="flex-1 flex min-h-0">
        {leftSidebarVisible && (
          <LeftSidebar
            activeTab={leftTab}
            onTabChange={setLeftTab}
            treeData={treeData}
            currentNotePath={currentNotePath}
            onSelectNote={handleSelectNote}
            headings={currentNote.headings}
            isEmpty={workspaceInfo.is_empty}
            error={treeError}
            onCreateNote={() => {
              handleSelectNote('projects/payments/settlement.md');
            }}
          />
        )}

        <CenterPane
          note={currentNote}
          viewMode={viewMode}
          isDirty={isDirty}
          onContentChange={handleContentChange}
          onSaveNow={() => saveNote(false)}
          onBlurSave={() => saveNote(false)}
          onNavigateRelative={handleSelectNote}
          showConflictBanner={showConflictBanner}
          onKeepVersion={() => {
            // Force overwrite on disk
            saveNote(true);
          }}
          onLoadFromDisk={() => {
            // Reload note from disk discarding buffer
            loadNote(currentNotePath);
          }}
          onShowDifferences={() => {
            setDiffViewerOpen(true);
          }}
          onBack={handleBack}
          onForward={handleForward}
        />

        {rightSidebarVisible && (
          <RightSidebar note={currentNote} onNavigate={handleSelectNote} />
        )}
      </div>

      {/* Status bar */}
      <StatusBar
        workspaceName={workspaceInfo.name}
        noteCount={Object.keys(noteState).length}
        linkCount={12803}
        unresolvedCount={1}
        cursorLine={10}
        cursorCol={42}
      />

      {/* Command Palette Modal */}
      <CommandPalette
        isOpen={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        notes={noteState}
        onSelectNote={handleSelectNote}
        initialMode={paletteMode}
      />

      {/* Conflict Diff Viewer */}
      <DiffViewer
        isOpen={diffViewerOpen}
        onClose={() => setDiffViewerOpen(false)}
        notePath={currentNotePath}
        bufferContent={currentNote.content}
        diskContent={diskVersionContent}
        onKeepVersion={() => saveNote(true)}
        onLoadFromDisk={() => loadNote(currentNotePath)}
      />
    </div>
  );
};

