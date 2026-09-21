import React, { useState, useEffect, useCallback } from 'react';
import { TitleBar, ViewMode } from './components/TitleBar';
import { LeftSidebar, LeftTab } from './components/LeftSidebar';
import { CenterPane } from './components/CenterPane';
import { RightSidebar } from './components/RightSidebar';
import { StatusBar } from './components/StatusBar';
import { CommandPalette } from './components/CommandPalette';
import {
  FIXTURE_NOTES,
  FIXTURE_TREE,
  FIXTURE_WORKSPACE_NAME,
  FIXTURE_ROOT_PATH,
} from './fixtures/workspace';
import { commandRegistry } from './commands/registry';

export const App: React.FC = () => {
  const [theme, setTheme] = useState<'light' | 'dark'>('dark');
  const [viewMode, setViewMode] = useState<ViewMode>('split');
  const [leftTab, setLeftTab] = useState<LeftTab>('tree');
  const [leftSidebarVisible, setLeftSidebarVisible] = useState(true);
  const [rightSidebarVisible, setRightSidebarVisible] = useState(true);

  // Active note state
  const [currentNotePath, setCurrentNotePath] = useState<string>(
    'projects/payments/settlement.md'
  );
  const [noteState, setNoteState] = useState(FIXTURE_NOTES);
  const [isDirty, setIsDirty] = useState(false);
  const [showConflictBanner, setShowConflictBanner] = useState(false);

  // Palette modal state
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [paletteMode, setPaletteMode] = useState<'notes' | 'commands'>('notes');

  // Navigation history
  const [history, setHistory] = useState<string[]>([currentNotePath]);
  const [historyIndex, setHistoryIndex] = useState(0);

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
    (path: string) => {
      if (path === currentNotePath) return;
      if (noteState[path]) {
        setCurrentNotePath(path);
        setHistory((prev) => [...prev.slice(0, historyIndex + 1), path]);
        setHistoryIndex((prev) => prev + 1);
        setIsDirty(false);
      }
    },
    [currentNotePath, historyIndex, noteState]
  );

  // History back / forward
  const handleBack = useCallback(() => {
    if (historyIndex > 0) {
      const target = history[historyIndex - 1];
      setHistoryIndex(historyIndex - 1);
      setCurrentNotePath(target);
    }
  }, [history, historyIndex]);

  const handleForward = useCallback(() => {
    if (historyIndex < history.length - 1) {
      const target = history[historyIndex + 1];
      setHistoryIndex(historyIndex + 1);
      setCurrentNotePath(target);
    }
  }, [history, historyIndex]);

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
      title: 'Trigger external-change conflict banner (fixture demo)',
      handler: () => setShowConflictBanner(true),
    });
  }, [cycleViewMode]);

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
        setIsDirty(false);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [cycleViewMode, handleBack, handleForward]);

  const currentNote =
    noteState[currentNotePath] || noteState['projects/payments/settlement.md'];

  const breadcrumb = `${FIXTURE_ROOT_PATH}/${currentNotePath.replace(/^projects\//, '')}`;

  // Content change handler
  const handleContentChange = (newContent: string) => {
    setIsDirty(true);
    setNoteState((prev) => ({
      ...prev,
      [currentNotePath]: {
        ...prev[currentNotePath],
        content: newContent,
      },
    }));
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
            treeData={FIXTURE_TREE}
            currentNotePath={currentNotePath}
            onSelectNote={handleSelectNote}
            headings={currentNote.headings}
          />
        )}

        <CenterPane
          note={currentNote}
          viewMode={viewMode}
          isDirty={isDirty}
          onContentChange={handleContentChange}
          onNavigateRelative={handleSelectNote}
          showConflictBanner={showConflictBanner}
          onKeepVersion={() => setShowConflictBanner(false)}
          onLoadFromDisk={() => {
            setShowConflictBanner(false);
            setIsDirty(false);
          }}
          onShowDifferences={() => {
            alert('Diff view: External version differs from buffer.');
            setShowConflictBanner(false);
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
        workspaceName={FIXTURE_WORKSPACE_NAME}
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
    </div>
  );
};
