import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { listen } from '@tauri-apps/api/event';
import { TitleBar, ViewMode } from './components/TitleBar';
import { LeftSidebar, LeftTab, InlineActionState } from './components/LeftSidebar';
import { CenterPane } from './components/CenterPane';
import { RightSidebar } from './components/RightSidebar';
import { StatusBar } from './components/StatusBar';
import { CommandPalette } from './components/CommandPalette';
import { DiffViewer } from './components/DiffViewer';
import { Toast, ToastMessage } from './components/Toast';
import { DeleteConfirmModal } from './components/DeleteConfirmModal';
import { UnresolvedLinksModal } from './components/UnresolvedLinksModal';
import { SettingsPanel } from './components/SettingsPanel';
import { useSettings } from './context/SettingsContext';
import {
  FIXTURE_NOTES,
  FIXTURE_WORKSPACE_NAME,
  FIXTURE_ROOT_PATH,
} from './fixtures/workspace';
import { commandRegistry } from './commands/registry';
import { APP_COMMANDS } from './commands/appCommands';
import {
  Fingerprint,
  FrontMatterField,
  IndexProgressEvent,
  LinkItem,
  McpStatus,
  NoteContent,
  NoteFixture,
  NoteMeta,
  TagCount,
  TreeNodeItem,
  WorkspaceInfo,
  WorkspaceStats,
} from './types';
import { api, isTauriEnvironment } from './services/ipc';
import { renderMarkdownToHtml } from './services/markdown';
import { countWords, countChars } from './services/textStats';

interface HistoryEntry {
  path: string;
  scrollTop?: number;
  cursorPos?: number;
}

export const App: React.FC = () => {
  const { config, loaded: settingsLoaded, refresh: refreshSettings, setField: setSettingsField } = useSettings();
  const [theme, setTheme] = useState<'light' | 'dark'>('dark');
  const [viewMode, setViewMode] = useState<ViewMode>('split');
  const [leftTab, setLeftTab] = useState<LeftTab>('tree');
  const [leftSidebarVisible, setLeftSidebarVisible] = useState(true);
  const [rightSidebarVisible, setRightSidebarVisible] = useState(true);
  const [settingsOpen, setSettingsOpen] = useState(false);

  // Layout persistence (SPEC §12 `layout`, M10.1 task 7). Seeded from config.layout once the
  // config first loads (see the settingsLoaded effect below) — a one-frame flash to these
  // defaults is possible since the config fetch is async and happens after first mount.
  const layoutSeededRef = useRef(false);
  const layoutSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Live workspace state
  const [workspaceInfo, setWorkspaceInfo] = useState<WorkspaceInfo>({
    name: FIXTURE_WORKSPACE_NAME,
    path: FIXTURE_ROOT_PATH,
    is_empty: false,
  });
  const [noWorkspace, setNoWorkspace] = useState(false);
  const [treeData, setTreeData] = useState<TreeNodeItem[]>([]);
  const [treeError, setTreeError] = useState<string | null>(null);

  // Indexing and Stats state (SPEC §6.1, §6.2, M7)
  const [workspaceStats, setWorkspaceStats] = useState<WorkspaceStats>({
    note_count: Object.keys(FIXTURE_NOTES).length,
    link_count: 12,
    unresolved_count: 1,
  });
  const [indexingProgress, setIndexingProgress] = useState<IndexProgressEvent | null>(null);
  const [isWatcherDegraded, setIsWatcherDegraded] = useState(false);
  const [mcpStatus, setMcpStatus] = useState<McpStatus>({
    state: 'off',
    requiresAuth: false,
    hasToken: false,
  });
  const [indexedNotes, setIndexedNotes] = useState<NoteMeta[]>([]);
  const [unresolvedLinks, setUnresolvedLinks] = useState<LinkItem[]>([]);
  const [unresolvedModalOpen, setUnresolvedModalOpen] = useState(false);

  // Active note path & selected folder state
  const [currentNotePath, setCurrentNotePath] = useState<string>('');
  const [selectedFolderPath, setSelectedFolderPath] = useState<string>('');
  const [noteState, setNoteState] = useState<Record<string, NoteFixture>>(FIXTURE_NOTES);
  const [noteFingerprints, setNoteFingerprints] = useState<Record<string, Fingerprint>>({});
  const [isDirty, setIsDirty] = useState(false);
  const [cursorPosition, setCursorPosition] = useState<{
    line: number;
    col: number;
    selectionLength: number;
  } | null>(null);

  // Conflict handling state
  const [showConflictBanner, setShowConflictBanner] = useState(false);
  const [diskVersionContent, setDiskVersionContent] = useState<string>('');
  const [diffViewerOpen, setDiffViewerOpen] = useState(false);

  // Palette modal state
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [paletteMode, setPaletteMode] = useState<'notes' | 'commands'>('notes');

  // Navigation history with scroll and cursor restoration (SPEC §6.3, M6)
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const [activeScrollTop, setActiveScrollTop] = useState<number | undefined>(undefined);
  const [activeCursorPos, setActiveCursorPos] = useState<number | undefined>(undefined);

  // Inline tree action state (create-note, create-folder, rename)
  const [inlineAction, setInlineAction] = useState<InlineActionState | null>(null);

  // Tag click-to-filter state (M10.25) — no precedent among the note-navigation callbacks above,
  // since a tag click filters the tree rather than navigating to a single note.
  const [activeTagFilter, setActiveTagFilter] = useState<string | null>(null);

  // Outline heading & search target line state
  const [activeHeadingAnchor, setActiveHeadingAnchor] = useState<string>('');
  const [scrollToAnchor, setScrollToAnchor] = useState<string | null>(null);
  const [scrollToLine, setScrollToLine] = useState<number | null>(null);

  // Toast notifications
  const [toasts, setToasts] = useState<ToastMessage[]>([]);

  const showToast = useCallback(
    (message: string, actionLabel?: string, onAction?: () => void, duration = 4000) => {
      const id = 'toast-' + Date.now() + '-' + Math.random().toString(36).substring(2, 6);
      setToasts((prev) => [...prev, { id, message, actionLabel, onAction, duration }]);
      if (duration > 0) {
        setTimeout(() => {
          setToasts((prev) => prev.filter((t) => t.id !== id));
        }, duration);
      }
    },
    []
  );

  const dismissToast = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  // Delete modal confirmation state
  const [deleteModalState, setDeleteModalState] = useState<{
    isOpen: boolean;
    itemPath: string;
    isFolder: boolean;
  }>({
    isOpen: false,
    itemPath: '',
    isFolder: false,
  });

  // Autosave timer reference (400ms debounce)
  const autosaveTimerRef = useRef<NodeJS.Timeout | null>(null);
  const currentNoteRef = useRef<{ path: string; content: string; fingerprint?: Fingerprint; isDirty: boolean }>({
    path: currentNotePath,
    content: noteState[currentNotePath]?.content || '',
    fingerprint: noteFingerprints[currentNotePath],
    isDirty: false,
  });

  // Current scroll & cursor tracking
  const currentScrollTopRef = useRef<number>(0);
  const currentCursorPosRef = useRef<number>(0);

  useEffect(() => {
    currentNoteRef.current = {
      path: currentNotePath,
      content: noteState[currentNotePath]?.content || '',
      fingerprint: noteFingerprints[currentNotePath],
      isDirty,
    };
  }, [currentNotePath, noteState, noteFingerprints, isDirty]);

  // Clean up autosave timer on unmount
  useEffect(() => {
    return () => {
      if (autosaveTimerRef.current) {
        clearTimeout(autosaveTimerRef.current);
        autosaveTimerRef.current = null;
      }
    };
  }, []);

  // Refresh workspace tree helper
  const refreshTree = useCallback(async () => {
    try {
      const tree = await api.workspaceTree(false);
      setTreeData(tree);
      setTreeError(null);
    } catch (err: any) {
      setTreeError(err?.message || String(err));
    }
  }, []);

  // Refresh workspace stats helper (SPEC §6.1, M7)
  const refreshStats = useCallback(async () => {
    try {
      const stats = await api.workspaceStats();
      setWorkspaceStats(stats);
      const notes = await api.indexNotes();
      setIndexedNotes(notes);
      const unresolved = await api.indexUnresolved();
      setUnresolvedLinks(unresolved);
    } catch (err) {
      console.warn('Failed to fetch workspace stats / index:', err);
    }
  }, []);

  // Workspace-wide tag counts, derived client-side from `indexedNotes` (which already carries
  // each note's merged front-matter ∪ inline tags) rather than a dedicated backend endpoint
  // (SPEC/M10.25). Case-insensitively de-duped, first-seen casing kept, sorted count desc then
  // alpha for the left-sidebar Tags tab; right-sidebar per-tag counts read the same map.
  const tagCounts = useMemo<TagCount[]>(() => {
    const counts = new Map<string, number>();
    const canonicalCasing = new Map<string, string>();
    for (const note of indexedNotes) {
      for (const tag of note.tags || []) {
        const key = tag.toLowerCase();
        counts.set(key, (counts.get(key) || 0) + 1);
        if (!canonicalCasing.has(key)) {
          canonicalCasing.set(key, tag);
        }
      }
    }
    return Array.from(counts.entries())
      .map(([key, count]) => ({ tag: canonicalCasing.get(key) || key, count }))
      .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
  }, [indexedNotes]);

  const handleFilterByTag = useCallback((tag: string) => {
    setActiveTagFilter(tag);
    setLeftTab('tree');
  }, []);

  const handleClearTagFilter = useCallback(() => {
    setActiveTagFilter(null);
  }, []);

  const handleTagRename = useCallback(
    async (oldTag: string, newTag: string) => {
      if (!oldTag || !newTag || oldTag === newTag) return;
      try {
        const res = await api.tagRename(oldTag, newTag);
        await refreshTree();
        await refreshStats();
        if (activeTagFilter && activeTagFilter.toLowerCase() === oldTag.toLowerCase()) {
          setActiveTagFilter(newTag);
        }
        showToast(
          `Renamed tag "#${oldTag}" to "#${newTag}". Updated ${res.notes_updated} note${
            res.notes_updated === 1 ? '' : 's'
          }`
        );
      } catch (err: any) {
        showToast(`Failed to rename tag: ${err?.message || String(err)}`);
      }
    },
    [activeTagFilter, refreshStats, refreshTree, showToast]
  );

  // Load note via IPC
  const loadNote = useCallback(async (path: string) => {
    if (!path) return;
    try {
      const noteContent: NoteContent = await api.noteRead(path);
      setNoteFingerprints((prev) => ({
        ...prev,
        [path]: noteContent.fingerprint,
      }));

      // Render through the Rust backend pulldown-cmark + syntect + ammonia pipeline
      let renderedHtml = '';
      let headings = noteContent.meta.headings;

      try {
        const renderRes = await api.noteRender(path, noteContent.content, theme);
        renderedHtml = renderRes.html;
        if (renderRes.headings && renderRes.headings.length > 0) {
          headings = renderRes.headings;
        }
      } catch {
        renderedHtml = renderMarkdownToHtml(noteContent.content);
      }

      // Fetch real outgoing links via IPC (M6)
      let outgoingLinks: any[] = [];
      try {
        outgoingLinks = await api.linksOutgoing(path, noteContent.content);
      } catch (err) {
        console.warn(`Failed to extract links for ${path}:`, err);
      }

      // Fetch real backlinks from index via IPC (M7)
      let backlinks: any[] = [];
      try {
        backlinks = await api.linksBacklinks(path);
      } catch (err) {
        console.warn(`Failed to fetch backlinks for ${path}:`, err);
      }

      setNoteState((prev) => {
        const existing = prev[path] || FIXTURE_NOTES[path] || {
          path,
          title: noteContent.meta.title,
          folder: path.split('/').slice(0, -1).join('/'),
          tags: noteContent.meta.tags,
          content: noteContent.content,
          renderedHtml,
          headings,
          outgoingLinks,
          backlinks,
          lastModifiedAgo: 'just now',
        };

        return {
          ...prev,
          [path]: {
            ...existing,
            title: noteContent.meta.title,
            tags: noteContent.meta.tags,
            headings,
            content: noteContent.content,
            renderedHtml,
            outgoingLinks,
            backlinks,
            frontMatterFields: noteContent.front_matter_fields,
          },
        };
      });

      setIsDirty(false);
      setShowConflictBanner(false);
    } catch (err) {
      console.warn(`Failed to read note ${path}:`, err);
    }
  }, [theme]);

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

        // Re-render through the real backend pipeline so the reader pane picks up anything the
        // JS fallback renderer can't reflect live (e.g. table column alignment) — mirrors
        // `loadNote`'s render call, but keyed on the just-saved content rather than a fresh read.
        api.noteRender(path, content, theme).then((renderRes) => {
          setNoteState((prev) => {
            const cur = prev[path];
            if (!cur) return prev;
            return {
              ...prev,
              [path]: {
                ...cur,
                renderedHtml: renderRes.html,
                headings: renderRes.headings && renderRes.headings.length > 0 ? renderRes.headings : cur.headings,
              },
            };
          });
        }).catch((err) => {
          console.warn(`Failed to re-render note ${path} after save:`, err);
        });

        // Update stats and backlinks after save (M7)
        refreshStats();
        if (currentNotePath) {
          api.linksBacklinks(currentNotePath).then((bls) => {
            setNoteState((prev) => {
              const cur = prev[currentNotePath];
              if (!cur) return prev;
              return { ...prev, [currentNotePath]: { ...cur, backlinks: bls } };
            });
          });

          // Refresh note metadata (tags, title, headings, front-matter fields) from backend —
          // keeps the Frontmatter panel in sync with fields added/edited by hand in the buffer.
          api.noteRead(currentNotePath).then((readNote) => {
            setNoteState((prev) => {
              const cur = prev[currentNotePath];
              if (!cur) return prev;
              return {
                ...prev,
                [currentNotePath]: {
                  ...cur,
                  tags: readNote.meta.tags,
                  title: readNote.meta.title,
                  headings: readNote.meta.headings,
                  frontMatterFields: readNote.front_matter_fields,
                },
              };
            });
          }).catch((err) => {
            console.warn(`Failed to refresh metadata after save for ${currentNotePath}:`, err);
          });
        }
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
    [currentNotePath, refreshStats, theme]
  );

  // Load workspace, tree, and listen to index events on mount (SPEC §6.2, §11, M7)
  useEffect(() => {
    let mounted = true;

    async function loadWorkspace() {
      try {
        const info = await api.workspaceOpen();
        if (mounted) {
          setWorkspaceInfo(info);
          setNoWorkspace(false);
          if (info.start_collapsed) {
            setLeftSidebarVisible(false);
          }
          void refreshSettings();
        }
        const tree = await api.workspaceTree(false);
        if (mounted) {
          setTreeData(tree);
          setTreeError(null);
        }
        await refreshStats();
        if (mounted && info.initial_note) {
          handleSelectNote(info.initial_note);
        }
      } catch (err: any) {
        const errMsg = err?.message || String(err);
        if (mounted) {
          // 'No workspace open' means first launch or last workspace gone — show onboarding
          if (errMsg.includes('No workspace open') || errMsg.includes('no_workspace')) {
            setNoWorkspace(true);
          } else {
            setTreeError(errMsg);
          }
        }
      }
    }

    loadWorkspace();

    // Listen to Tauri index and watcher events if in desktop environment
    let unlistenProgress: (() => void) | undefined;
    let unlistenReady: (() => void) | undefined;
    let unlistenChanged: (() => void) | undefined;
    let unlistenCreated: (() => void) | undefined;
    let unlistenRemoved: (() => void) | undefined;
    let unlistenRenamed: (() => void) | undefined;
    let unlistenDegraded: (() => void) | undefined;
    let unlistenMcpStatus: (() => void) | undefined;

    if (isTauriEnvironment()) {
      listen<IndexProgressEvent>('index:progress', (event) => {
        if (mounted) {
          setIndexingProgress(event.payload);
        }
      }).then((unsub) => {
        unlistenProgress = unsub;
      });

      listen<WorkspaceStats>('index:ready', (event) => {
        if (mounted) {
          setWorkspaceStats(event.payload);
          setIndexingProgress(null);
          refreshStats();
        }
      }).then((unsub) => {
        unlistenReady = unsub;
      });

      listen<{ path: string }>('note:changed', async (event) => {
        if (!mounted) return;
        const changedPath = event.payload?.path;
        refreshStats();

        // If the changed note is the currently open note
        if (changedPath && currentNoteRef.current.path === changedPath) {
          if (!currentNoteRef.current.isDirty) {
            // Unsaved edits absent: reload in-place preserving scroll and cursor (SPEC §5.3, M8)
            const prevScroll = currentScrollTopRef.current;
            const prevCursor = currentCursorPosRef.current;
            await loadNote(changedPath);
            setActiveScrollTop(prevScroll);
            setActiveCursorPos(prevCursor);
          } else {
            // Note has unsaved edits: show conflict banner (SPEC §5.3)
            setShowConflictBanner(true);
            try {
              const diskNote = await api.noteRead(changedPath);
              setDiskVersionContent(diskNote.content);
            } catch {
              setDiskVersionContent('');
            }
          }
        }
      }).then((unsub) => {
        unlistenChanged = unsub;
      });

      listen<{ path: string }>('note:created', () => {
        if (!mounted) return;
        refreshTree();
        refreshStats();
      }).then((unsub) => {
        unlistenCreated = unsub;
      });

      listen<{ path: string }>('note:removed', (event) => {
        if (!mounted) return;
        const removedPath = event.payload?.path;
        refreshTree();
        refreshStats();
        if (removedPath && currentNoteRef.current.path === removedPath) {
          setCurrentNotePath('');
        }
      }).then((unsub) => {
        unlistenRemoved = unsub;
      });

      listen<{ from: string; to: string }>('note:renamed', (event) => {
        if (!mounted) return;
        const { from, to } = event.payload || {};
        refreshTree();
        refreshStats();
        if (from && currentNoteRef.current.path === from && to) {
          setCurrentNotePath(to);
          loadNote(to);
        }
      }).then((unsub) => {
        unlistenRenamed = unsub;
      });

      listen<{ reason: string }>('watcher:degraded', () => {
        if (mounted) {
          setIsWatcherDegraded(true);
        }
      }).then((unsub) => {
        unlistenDegraded = unsub;
      });

      listen<McpStatus>('mcp:status', (event) => {
        if (mounted) {
          setMcpStatus(event.payload);
        }
      }).then((unsub) => {
        unlistenMcpStatus = unsub;
      });
      api.mcpStatus().then((status) => {
        if (mounted) {
          setMcpStatus(status);
        }
      });
    }

    return () => {
      mounted = false;
      if (unlistenProgress) unlistenProgress();
      if (unlistenReady) unlistenReady();
      if (unlistenChanged) unlistenChanged();
      if (unlistenCreated) unlistenCreated();
      if (unlistenRemoved) unlistenRemoved();
      if (unlistenRenamed) unlistenRenamed();
      if (unlistenDegraded) unlistenDegraded();
      if (unlistenMcpStatus) unlistenMcpStatus();
    };
    // Mount-only: must run exactly once regardless of later identity changes to its callbacks,
    // including handleSelectNote (used only for M10.06's initial_note focus on first load).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadNote, refreshStats, refreshTree]);

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

  // Seed layout state (left/right sidebar visibility + active left tab) from config.layout the
  // first time settings finish loading. Deferred to a `useEffect` rather than the initial
  // `useState` value since the config fetch is async — this accepts a possible one-frame flash
  // to the hardcoded defaults above rather than blocking first paint on the config round-trip.
  useEffect(() => {
    if (!settingsLoaded || layoutSeededRef.current) return;
    layoutSeededRef.current = true;
    const layout = config.layout;
    if (!layout) return;
    if (typeof layout.leftSidebarCollapsed === 'boolean') {
      setLeftSidebarVisible(!layout.leftSidebarCollapsed);
    }
    if (typeof layout.rightSidebarCollapsed === 'boolean') {
      setRightSidebarVisible(!layout.rightSidebarCollapsed);
    }
    if (layout.activeLeftTab) {
      setLeftTab(layout.activeLeftTab as LeftTab);
    }
    if (layout.lastOpenNote) {
      handleSelectNote(layout.lastOpenNote);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settingsLoaded]);

  // Persist sidebar-visibility / active-tab layout changes, debounced (400-500ms) like the
  // existing autosave pattern, so rapid toggles don't fire a config_set per event.
  useEffect(() => {
    if (!layoutSeededRef.current) return;
    if (layoutSaveTimerRef.current) clearTimeout(layoutSaveTimerRef.current);
    layoutSaveTimerRef.current = setTimeout(() => {
      setSettingsField('layout.leftSidebarCollapsed', !leftSidebarVisible);
      setSettingsField('layout.rightSidebarCollapsed', !rightSidebarVisible);
      setSettingsField('layout.activeLeftTab', leftTab);
    }, 450);
    return () => {
      if (layoutSaveTimerRef.current) clearTimeout(layoutSaveTimerRef.current);
    };
  }, [leftSidebarVisible, rightSidebarVisible, leftTab, setSettingsField]);

  // Note navigation is low-frequency: persist `lastOpenNote` immediately, no debounce.
  useEffect(() => {
    if (!layoutSeededRef.current) return;
    if (currentNotePath) {
      setSettingsField('layout.lastOpenNote', currentNotePath);
    }
  }, [currentNotePath, setSettingsField]);

  // Recently opened workspaces, shown on the onboarding screen (M10.04)
  const [recentWorkspaces, setRecentWorkspaces] = useState<string[]>([]);
  useEffect(() => {
    if (!noWorkspace) return;
    let mounted = true;
    api.recentWorkspaces().then((list) => {
      if (mounted) setRecentWorkspaces(list);
    });
    return () => {
      mounted = false;
    };
  }, [noWorkspace]);

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
    async (targetPath: string, targetLine?: number) => {
      // Clear pending autosave timer on navigation
      if (autosaveTimerRef.current) {
        clearTimeout(autosaveTimerRef.current);
        autosaveTimerRef.current = null;
      }

      // Split anchor if present
      const cleanPath = targetPath.split('#')[0];
      const anchor = targetPath.includes('#') ? targetPath.split('#')[1] : null;

      if (!cleanPath && anchor) {
        setScrollToAnchor(anchor);
        setTimeout(() => setScrollToAnchor(null), 300);
        return;
      }

      if (cleanPath === currentNotePath) {
        if (anchor) {
          setScrollToAnchor(anchor);
          setTimeout(() => setScrollToAnchor(null), 300);
        }
        if (targetLine !== undefined) {
          setScrollToLine(targetLine);
          setTimeout(() => setScrollToLine(null), 300);
        }
        return;
      }

      // Save previous note if dirty before navigating
      if (isDirty) {
        await saveNote(false);
      }

      // Save current scroll/cursor to current history entry before moving
      if (historyIndex >= 0 && historyIndex < history.length) {
        history[historyIndex] = {
          ...history[historyIndex],
          scrollTop: currentScrollTopRef.current,
          cursorPos: currentCursorPosRef.current,
        };
      }

      const newEntry: HistoryEntry = { path: cleanPath };
      setHistory((prev) => [...prev.slice(0, historyIndex + 1), newEntry]);
      setHistoryIndex((prev) => prev + 1);
      setCurrentNotePath(cleanPath);
      setActiveScrollTop(undefined);
      setActiveCursorPos(undefined);
      setCursorPosition(null);

      await loadNote(cleanPath);

      if (anchor) {
        setTimeout(() => {
          setScrollToAnchor(anchor);
          setTimeout(() => setScrollToAnchor(null), 300);
        }, 100);
      }

      if (targetLine !== undefined) {
        setTimeout(() => {
          setScrollToLine(targetLine);
          setTimeout(() => setScrollToLine(null), 300);
        }, 100);
      }
    },
    [currentNotePath, history, historyIndex, isDirty, loadNote, saveNote]
  );

  // Open a given path as the active workspace (M10.04 onboarding)
  const openWorkspacePath = useCallback(
    async (path: string) => {
      try {
        const info = await api.workspaceOpen(path);
        setWorkspaceInfo(info);
        setNoWorkspace(false);
        if (info.start_collapsed) {
          setLeftSidebarVisible(false);
        }
        const tree = await api.workspaceTree(false);
        setTreeData(tree);
        setTreeError(null);
        await refreshStats();
        if (info.initial_note) {
          handleSelectNote(info.initial_note);
        }
      } catch (err: any) {
        console.error('Failed to open workspace:', err);
      }
    },
    [handleSelectNote, refreshStats]
  );

  // Open a folder via native picker and load it as workspace (M10.04 onboarding)
  const handleOpenFolder = useCallback(async () => {
    const chosen = await api.chooseFolder();
    if (!chosen) return;
    await openWorkspacePath(chosen);
  }, [openWorkspacePath]);

  // Create broken note target and navigate to it (SPEC §6.3, M6, M7)
  const handleCreateBrokenNote = useCallback(
    async (rawPath: string, sourcePath?: string) => {
      try {
        let cleanPath = rawPath.split('#')[0].replace(/^\.\//, '');
        if (!cleanPath.endsWith('.md') && !cleanPath.endsWith('.markdown')) {
          cleanPath = `${cleanPath}.md`;
        }
        // If sourcePath provided and cleanPath is relative
        let targetPath = cleanPath;
        if (sourcePath && !rawPath.startsWith('/')) {
          const folder = sourcePath.split('/').slice(0, -1).join('/');
          targetPath = folder ? `${folder}/${cleanPath}` : cleanPath;
        }

        // `template` is a path under .flint/templates/ (M10.26), not literal content — the
        // backend renders it (or, with no template, applies `newNote.insertHeading`).
        await api.noteCreate(targetPath, config.templates.defaultTemplate ?? undefined);
        await refreshTree();
        await refreshStats();
        showToast(`Created note "${targetPath}"`);
        await handleSelectNote(targetPath);
      } catch (err: any) {
        showToast(`Failed to create note: ${err?.message || String(err)}`);
      }
    },
    [config.templates.defaultTemplate, handleSelectNote, refreshStats, refreshTree, showToast]
  );

  // Open (creating on first use) a daily note (M10.26). Only ever invoked from an explicit
  // command — never on startup — per the milestone's data-safety note.
  const handleDailyNoteOpen = useCallback(
    async (offsetDays?: number, date?: string) => {
      try {
        const meta = await api.dailyNoteOpen(offsetDays, date);
        await refreshTree();
        await handleSelectNote(meta.path);
      } catch (err: any) {
        showToast(`Failed to open daily note: ${err?.message || String(err)}`);
      }
    },
    [handleSelectNote, refreshTree, showToast]
  );

  // "Daily note: Pick a date…" — a lightweight native prompt rather than a bespoke popover,
  // validated before it ever reaches the IPC call.
  const handleDailyNotePickDate = useCallback(() => {
    const input = window.prompt('Open daily note for date (YYYY-MM-DD):');
    if (!input) return;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(input.trim())) {
      showToast('Enter a date as YYYY-MM-DD');
      return;
    }
    handleDailyNoteOpen(undefined, input.trim());
  }, [handleDailyNoteOpen, showToast]);

  // Rotate the local MCP server's bearer token without restarting Flint (M10.21)
  const handleRotateMcpToken = useCallback(async () => {
    try {
      await api.mcpRotateToken();
      showToast('MCP token rotated. Update any connected client with the new token.');
    } catch (err: any) {
      showToast(`Failed to rotate MCP token: ${err?.message || String(err)}`);
    }
  }, [showToast]);

  // Open external URL in system browser (SPEC §6.3, M6)
  const handleOpenExternal = useCallback(
    async (url: string) => {
      try {
        await api.openExternal(url);
      } catch (err: any) {
        showToast(`Failed to open link: ${err?.message || String(err)}`);
      }
    },
    [showToast]
  );

  // Frontmatter panel: persist an edited/added/deleted field set through the same
  // atomic-write + fingerprint-conflict path as `note_write` (SPEC §5.3, M10.10).
  const handleFrontmatterSave = useCallback(
    async (fields: FrontMatterField[]) => {
      const path = currentNotePath;
      if (!path) return;
      try {
        const newFingerprint = await api.frontmatterSet(
          path,
          fields,
          noteFingerprints[path]
        );
        setNoteFingerprints((prev) => ({ ...prev, [path]: newFingerprint }));

        const refreshed = await api.noteRead(path);
        setNoteState((prev) => {
          const cur = prev[path];
          if (!cur) return prev;
          return {
            ...prev,
            [path]: {
              ...cur,
              title: refreshed.meta.title,
              tags: refreshed.meta.tags,
              headings: refreshed.meta.headings,
              content: refreshed.content,
              frontMatterFields: refreshed.front_matter_fields,
            },
          };
        });
      } catch (err: any) {
        const errMsg = err?.message || String(err);
        if (errMsg.toLowerCase().includes('conflict')) {
          setShowConflictBanner(true);
          try {
            const diskNote = await api.noteRead(path);
            setDiskVersionContent(diskNote.content);
          } catch {
            setDiskVersionContent('');
          }
        } else {
          showToast(`Failed to save front matter: ${errMsg}`);
        }
      }
    },
    [currentNotePath, noteFingerprints, showToast]
  );

  // History back / forward with cursor and scroll restoration
  const handleBack = useCallback(async () => {
    if (historyIndex > 0) {
      if (autosaveTimerRef.current) {
        clearTimeout(autosaveTimerRef.current);
        autosaveTimerRef.current = null;
      }
      if (isDirty) {
        await saveNote(false);
      }
      // Save current position
      if (historyIndex < history.length) {
        history[historyIndex] = {
          ...history[historyIndex],
          scrollTop: currentScrollTopRef.current,
          cursorPos: currentCursorPosRef.current,
        };
      }

      const targetEntry = history[historyIndex - 1];
      setHistoryIndex(historyIndex - 1);
      setCurrentNotePath(targetEntry.path);
      setActiveScrollTop(targetEntry.scrollTop);
      setActiveCursorPos(targetEntry.cursorPos);
      await loadNote(targetEntry.path);
    }
  }, [history, historyIndex, isDirty, loadNote, saveNote]);

  const handleForward = useCallback(async () => {
    if (historyIndex < history.length - 1) {
      if (autosaveTimerRef.current) {
        clearTimeout(autosaveTimerRef.current);
        autosaveTimerRef.current = null;
      }
      if (isDirty) {
        await saveNote(false);
      }
      // Save current position
      if (historyIndex >= 0 && historyIndex < history.length) {
        history[historyIndex] = {
          ...history[historyIndex],
          scrollTop: currentScrollTopRef.current,
          cursorPos: currentCursorPosRef.current,
        };
      }

      const targetEntry = history[historyIndex + 1];
      setHistoryIndex(historyIndex + 1);
      setCurrentNotePath(targetEntry.path);
      setActiveScrollTop(targetEntry.scrollTop);
      setActiveCursorPos(targetEntry.cursorPos);
      await loadNote(targetEntry.path);
    }
  }, [history, historyIndex, isDirty, loadNote, saveNote]);

  // Action handlers for tree
  const handleStartCreateNote = useCallback((parentFolder?: string) => {
    setLeftSidebarVisible(true);
    setLeftTab('tree');
    const folder = parentFolder !== undefined ? parentFolder : selectedFolderPath;
    setInlineAction({
      type: 'create-note',
      targetPath: folder,
      initialValue: 'Untitled.md',
    });
  }, [selectedFolderPath]);

  const handleStartCreateFolder = useCallback((parentFolder?: string) => {
    setLeftSidebarVisible(true);
    setLeftTab('tree');
    const folder = parentFolder !== undefined ? parentFolder : selectedFolderPath;
    setInlineAction({
      type: 'create-folder',
      targetPath: folder,
      initialValue: 'new-folder',
    });
  }, [selectedFolderPath]);

  const handleStartRename = useCallback((itemPath: string, currentName: string) => {
    const isFolder = !itemPath.endsWith('.md') && !itemPath.endsWith('.markdown');
    setInlineAction({
      type: 'rename',
      targetPath: itemPath,
      initialValue: currentName,
      isFolder,
    });
  }, []);

  const handleCommitInlineAction = useCallback(async (name: string) => {
    if (!inlineAction) return;

    try {
      if (inlineAction.type === 'create-note') {
        const noteFileName = name.endsWith('.md') || name.endsWith('.markdown') ? name : `${name}.md`;
        const relativePath = inlineAction.targetPath ? `${inlineAction.targetPath}/${noteFileName}` : noteFileName;

        // `template` is a path under .flint/templates/ (M10.26); the configured default (if
        // any) is what the new-note picker would have pre-selected.
        await api.noteCreate(relativePath, config.templates.defaultTemplate ?? undefined);
        await refreshTree();
        setInlineAction(null);
        await handleSelectNote(relativePath);
        showToast(`Created note "${noteFileName}"`);
      } else if (inlineAction.type === 'create-folder') {
        const relativePath = inlineAction.targetPath ? `${inlineAction.targetPath}/${name}` : name;
        await api.folderCreate(relativePath);
        await refreshTree();
        setInlineAction(null);
        setSelectedFolderPath(relativePath);
        showToast(`Created folder "${name}"`);
      } else if (inlineAction.type === 'rename') {
        const fromPath = inlineAction.targetPath;
        const parentDir = fromPath.split('/').slice(0, -1).join('/');
        const isFolder = inlineAction.isFolder;
        const finalName = !isFolder && !name.endsWith('.md') && !name.endsWith('.markdown') ? `${name}.md` : name;
        const toPath = parentDir ? `${parentDir}/${finalName}` : finalName;

        if (fromPath !== toPath) {
          const res = await api.noteRename(fromPath, toPath);
          await refreshTree();
          await refreshStats();

          // If currently viewing the renamed note, update current path
          if (currentNotePath === fromPath) {
            setCurrentNotePath(toPath);
            await loadNote(toPath);
          } else if (currentNotePath.startsWith(`${fromPath}/`)) {
            // Note inside a renamed folder
            const sub = currentNotePath.slice(fromPath.length);
            const newCurrent = `${toPath}${sub}`;
            setCurrentNotePath(newCurrent);
            await loadNote(newCurrent);
          }

          if (res?.links_updated && res.links_updated > 0) {
            showToast(`Renamed. Updated ${res.links_updated} link${res.links_updated === 1 ? '' : 's'}`);
          } else {
            showToast(`Renamed to "${finalName}"`);
          }
        }
        setInlineAction(null);
      }
    } catch (err: any) {
      showToast(`Error: ${err?.message || String(err)}`);
    }
  }, [config.templates.defaultTemplate, currentNotePath, handleSelectNote, inlineAction, loadNote, refreshStats, refreshTree, showToast]);

  const handleDuplicateNote = useCallback(async (itemPath: string) => {
    try {
      const meta = await api.noteDuplicate(itemPath);
      await refreshTree();
      await handleSelectNote(meta.path);
      showToast(`Duplicated to "${meta.path.split('/').pop()}"`);
    } catch (err: any) {
      showToast(`Failed to duplicate: ${err?.message || String(err)}`);
    }
  }, [handleSelectNote, refreshTree, showToast]);

  const handleDeleteItem = useCallback(async (itemPath: string, isFolder: boolean, permanent: boolean) => {
    if (permanent) {
      setDeleteModalState({
        isOpen: true,
        itemPath,
        isFolder,
      });
      return;
    }

    // Default: OS Trash
    try {
      if (isFolder) {
        await api.folderDelete(itemPath, false);
      } else {
        await api.noteDelete(itemPath, false);
      }

      await refreshTree();
      if (currentNotePath === itemPath || currentNotePath.startsWith(`${itemPath}/`)) {
        setCurrentNotePath('');
      }
      showToast(`Moved "${itemPath.split('/').pop()}" to Trash`);
    } catch (err: any) {
      showToast(`Delete failed: ${err?.message || String(err)}`);
    }
  }, [currentNotePath, refreshTree, showToast]);

  const handleConfirmPermanentDelete = useCallback(async () => {
    const { itemPath, isFolder } = deleteModalState;
    setDeleteModalState({ isOpen: false, itemPath: '', isFolder: false });

    try {
      if (isFolder) {
        await api.folderDelete(itemPath, true);
      } else {
        await api.noteDelete(itemPath, true);
      }

      await refreshTree();
      if (currentNotePath === itemPath || currentNotePath.startsWith(`${itemPath}/`)) {
        setCurrentNotePath('');
      }
      showToast(`Permanently deleted "${itemPath.split('/').pop()}"`);
    } catch (err: any) {
      showToast(`Permanent delete failed: ${err?.message || String(err)}`);
    }
  }, [currentNotePath, deleteModalState, refreshTree, showToast]);

  const handleMoveItem = useCallback(async (fromPath: string, toParentFolder: string) => {
    const itemName = fromPath.split('/').pop()!;
    const toPath = toParentFolder ? `${toParentFolder}/${itemName}` : itemName;

    try {
      const res = await api.noteRename(fromPath, toPath);
      await refreshTree();
      await refreshStats();

      if (currentNotePath === fromPath) {
        setCurrentNotePath(toPath);
      } else if (currentNotePath.startsWith(`${fromPath}/`)) {
        const sub = currentNotePath.slice(fromPath.length);
        setCurrentNotePath(`${toPath}${sub}`);
      }

      // Show toast with undo affordance
      const folderDisplayName = toParentFolder || 'workspace root';
      const moveMsg =
        res?.links_updated && res.links_updated > 0
          ? `Moved "${itemName}" to ${folderDisplayName} (updated ${res.links_updated} link${res.links_updated === 1 ? '' : 's'})`
          : `Moved "${itemName}" to ${folderDisplayName}`;

      showToast(
        moveMsg,
        'Undo',
        async () => {
          try {
            await api.noteRename(toPath, fromPath);
            await refreshTree();
            await refreshStats();
            if (currentNotePath === toPath) {
              setCurrentNotePath(fromPath);
            }
            showToast(`Restored "${itemName}" to original location`);
          } catch (undoErr: any) {
            showToast(`Undo failed: ${undoErr?.message || String(undoErr)}`);
          }
        },
        6000
      );
    } catch (err: any) {
      showToast(`Failed to move: ${err?.message || String(err)}`);
    }
  }, [currentNotePath, refreshStats, refreshTree, showToast]);

  const handleRevealInFileManager = useCallback(async (itemPath: string) => {
    try {
      await api.revealInFileManager(itemPath);
    } catch (err: any) {
      showToast(`Could not reveal in file manager: ${err?.message || String(err)}`);
    }
  }, [showToast]);

  const handleCopyRelativePath = useCallback((itemPath: string) => {
    navigator.clipboard.writeText(itemPath);
    showToast(`Copied path "${itemPath}" to clipboard`);
  }, [showToast]);

  const handleCloseNote = useCallback(async () => {
    if (autosaveTimerRef.current) {
      clearTimeout(autosaveTimerRef.current);
      autosaveTimerRef.current = null;
    }
    if (isDirty) {
      await saveNote(false);
    }
    setCurrentNotePath('');
    setCursorPosition(null);
  }, [isDirty, saveNote]);

  // Register commands in registry per SPEC §9.3 & M4. Metadata (id/title/shortcut) lives in
  // src/commands/appCommands.ts — the single source of truth the docs site's shortcut table is
  // generated from — and only the live handlers are wired up here.
  useEffect(() => {
    const handlers: Partial<Record<string, () => void>> = {
      'file.new_note': () => handleStartCreateNote(),
      'file.new_folder': () => handleStartCreateFolder(),
      'file.close': () => handleCloseNote(),
      'palette.notes': () => {
        setPaletteMode('notes');
        setPaletteOpen(true);
      },
      'palette.commands': () => {
        setPaletteMode('commands');
        setPaletteOpen(true);
      },
      'search.content': () => {
        setLeftSidebarVisible(true);
        setLeftTab('search');
      },
      'file.save': () => saveNote(false),
      'view.cycle_mode': cycleViewMode,
      'view.toggle_left_sidebar': () => setLeftSidebarVisible((prev) => !prev),
      'view.toggle_right_sidebar': () => setRightSidebarVisible((prev) => !prev),
      'theme.toggle': () => setTheme((prev) => (prev === 'dark' ? 'light' : 'dark')),
      'view.open_settings': () => setSettingsOpen((prev) => !prev),
    };

    if (config.dailyNotes.enabled) {
      handlers['daily.today'] = () => handleDailyNoteOpen(0);
      handlers['daily.yesterday'] = () => handleDailyNoteOpen(-1);
      handlers['daily.tomorrow'] = () => handleDailyNoteOpen(1);
      handlers['daily.pick_date'] = () => handleDailyNotePickDate();
    }

    for (const meta of APP_COMMANDS) {
      const handler = handlers[meta.id];
      if (handler) {
        commandRegistry.register({ ...meta, handler });
      } else if (meta.id.startsWith('daily.')) {
        // Daily notes turned off: don't leave a stale registration a keyboard/palette lookup
        // could still find.
        commandRegistry.unregister(meta.id);
      }
    }
  }, [
    config.dailyNotes.enabled,
    cycleViewMode,
    handleCloseNote,
    handleDailyNoteOpen,
    handleDailyNotePickDate,
    handleStartCreateFolder,
    handleStartCreateNote,
    saveNote,
  ]);

  // Global keydown listeners
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const isMac = navigator.platform.toUpperCase().indexOf('MAC') >= 0;
      const mod = isMac ? e.metaKey : e.ctrlKey;

      if (mod && e.key.toLowerCase() === 'n' && !e.shiftKey) {
        e.preventDefault();
        handleStartCreateNote();
      } else if (mod && e.key.toLowerCase() === 'n' && e.shiftKey) {
        e.preventDefault();
        handleStartCreateFolder();
      } else if (mod && e.key.toLowerCase() === 'w') {
        e.preventDefault();
        handleCloseNote();
      } else if (mod && e.key.toLowerCase() === 'p' && !e.shiftKey) {
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
      } else if (mod && e.key.toLowerCase() === 'o') {
        e.preventDefault();
        handleOpenFolder();
      } else if (mod && e.key === ',') {
        e.preventDefault();
        setSettingsOpen((prev) => !prev);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [cycleViewMode, handleBack, handleCloseNote, handleForward, handleOpenFolder, handleStartCreateFolder, handleStartCreateNote, saveNote]);

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

  const textStats = React.useMemo(() => {
    if (!currentNotePath) {
      return { wordCount: 0, charCount: 0, lineEnding: 'LF' as const };
    }
    return {
      wordCount: countWords(currentNote.content),
      charCount: countChars(currentNote.content),
      lineEnding: currentNote.content.includes('\r\n') ? ('CRLF' as const) : ('LF' as const),
    };
  }, [currentNotePath, currentNote.content]);

  const breadcrumb = currentNotePath
    ? `${workspaceInfo.name}/${currentNotePath.replace(/^projects\//, '')}`
    : workspaceInfo.name;

  // Content change handler with 400ms debounced autosave and live outgoing links extraction
  const handleContentChange = (newContent: string) => {
    setIsDirty(true);
    const renderedHtml = renderMarkdownToHtml(newContent);
    setNoteState((prev) => {
      const current = prev[currentNotePath];
      return {
        ...prev,
        [currentNotePath]: {
          ...current,
          content: newContent,
          renderedHtml,
        },
      };
    });

    // Extract outgoing links live for the right sidebar
    const targetPath = currentNotePath;
    api.linksOutgoing(targetPath, newContent)
      .then((outgoingLinks) => {
        setNoteState((prev) => {
          const current = prev[targetPath];
          if (!current) return prev;
          return {
            ...prev,
            [targetPath]: {
              ...current,
              outgoingLinks,
            },
          };
        });
      })
      .catch((err) => {
        console.warn(`Failed to update outgoing links for ${targetPath}:`, err);
      });

    // Debounce autosave per config.behaviour.autosaveMs (settings-configurable, M10.1)
    if (autosaveTimerRef.current) {
      clearTimeout(autosaveTimerRef.current);
    }
    autosaveTimerRef.current = setTimeout(() => {
      saveNote(false);
    }, config.behaviour.autosaveMs);
  };

  return (
    <>
      {/* Onboarding / empty-state screen (M10.04): shown when no workspace is remembered */}
      {noWorkspace && (
        <div
          className="flex flex-col h-screen w-screen bg-[var(--canvas)] text-[var(--text)] items-center justify-center font-ui"
          style={{ gap: '2rem' }}
        >
          {/* Logo / wordmark */}
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '0.75rem' }}>
            <div
              style={{
                width: '64px',
                height: '64px',
                borderRadius: '16px',
                background: 'var(--panel-2)',
                border: '1px solid var(--border)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <img
                src="/flint-icon.png"
                alt=""
                aria-hidden="true"
                width={48}
                height={48}
                style={{ borderRadius: '10px' }}
              />
            </div>
            <span style={{ fontSize: '2rem', fontWeight: 700, letterSpacing: '-0.02em', color: 'var(--text)' }}>Flint</span>
          </div>

          {/* Welcome message */}
          <div style={{ textAlign: 'center', display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
            <h1 style={{ fontSize: '1.5rem', fontWeight: 600, margin: 0, color: 'var(--text)' }}>
              Welcome to Flint
            </h1>
            <p style={{ fontSize: '1rem', color: 'var(--text-2)', margin: 0, maxWidth: '28rem' }}>
              Open a folder on disk to start editing your notes.
              <br />
              Your notes stay as plain Markdown files — no lock-in.
            </p>
          </div>

          {/* Create / open workspace buttons */}
          <div className="flex items-center gap-2">
            <button
              id="onboarding-create-workspace"
              onClick={handleOpenFolder}
              className="px-3.5 py-1.5 text-[12.5px] font-medium bg-[var(--accent)] text-white hover:opacity-85 rounded-[5px] transition-opacity shadow-sm flex items-center gap-1.5"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M12 5v14M5 12h14"/>
              </svg>
              Create Workspace
            </button>
            <button
              id="onboarding-open-folder"
              onClick={handleOpenFolder}
              className="px-3.5 py-1.5 text-[12.5px] font-medium border border-[var(--border)] bg-[var(--panel)] text-[var(--text)] hover:bg-[var(--panel-2)] rounded-[5px] transition-colors flex items-center gap-1.5"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
              </svg>
              Open Workspace
              <kbd style={{ fontSize: '0.7rem', opacity: 0.7, fontFamily: 'inherit', marginLeft: '0.125rem' }}>⌘O</kbd>
            </button>
          </div>

          {/* Recently opened workspaces */}
          {recentWorkspaces.length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.375rem', width: '22rem' }}>
              <span className="text-[11px] font-medium text-[var(--text-2)] uppercase tracking-wide text-center">
                Recent workspaces
              </span>
              <div className="flex flex-col gap-1">
                {recentWorkspaces.map((path) => {
                  const name = path.split('/').filter(Boolean).pop() || path;
                  return (
                    <button
                      key={path}
                      onClick={() => openWorkspacePath(path)}
                      title={path}
                      className="flex items-center gap-2 px-2.5 py-1.5 text-[12.5px] text-left border border-[var(--border)] bg-[var(--panel)] text-[var(--text)] hover:bg-[var(--panel-2)] rounded-[5px] transition-colors truncate"
                    >
                      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="shrink-0 text-[var(--text-2)]">
                        <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
                      </svg>
                      <span className="truncate font-medium">{name}</span>
                      <span className="truncate text-[var(--text-2)] text-[11px]">{path}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Main app shell — hidden until a workspace is open */}
      {!noWorkspace && (
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
        leftSidebarVisible={leftSidebarVisible}
        onToggleLeftSidebar={() => setLeftSidebarVisible((prev) => !prev)}
        rightSidebarVisible={rightSidebarVisible}
        onToggleRightSidebar={() => setRightSidebarVisible((prev) => !prev)}
        onOpenSettings={() => setSettingsOpen((prev) => !prev)}
      />

      {/* Main body with sidebars & editor/reader, or the full-pane Settings panel (M10.1) */}
      <div className="flex-1 flex min-h-0">
        {settingsOpen ? (
          <SettingsPanel onClose={() => setSettingsOpen(false)} />
        ) : (
        <>
        {leftSidebarVisible && (
          <LeftSidebar
            activeTab={leftTab}
            onTabChange={setLeftTab}
            treeData={treeData}
            currentNotePath={currentNotePath}
            onSelectNote={handleSelectNote}
            isEmpty={treeData.length === 0}
            error={treeError}
            selectedFolderPath={selectedFolderPath}
            onSelectFolder={setSelectedFolderPath}
            onCreateNote={handleStartCreateNote}
            onCreateFolder={handleStartCreateFolder}
            onRenameItem={handleStartRename}
            onDuplicateNote={handleDuplicateNote}
            onDeleteItem={handleDeleteItem}
            onMoveItem={handleMoveItem}
            onRevealInFileManager={handleRevealInFileManager}
            onCopyRelativePath={handleCopyRelativePath}
            inlineAction={inlineAction}
            onCommitInlineAction={handleCommitInlineAction}
            onCancelInlineAction={() => setInlineAction(null)}
            activeHeadingAnchor={activeHeadingAnchor}
            onSelectHeading={(heading) => {
              setActiveHeadingAnchor(heading.anchor);
              setScrollToAnchor(heading.anchor);
              // Clear scrollToAnchor after scrolling
              setTimeout(() => setScrollToAnchor(null), 300);
              if (typeof heading.line === 'number') {
                // heading.line is 0-based; scrollToLine is 1-based
                setScrollToLine(heading.line + 1);
                setTimeout(() => setScrollToLine(null), 300);
              }
            }}
            onClose={() => setLeftSidebarVisible(false)}
            noteContent={currentNote.content}
            onSectionMovedToNewNote={(newNotePath) => {
              showToast(`Moved section to new note "${newNotePath}"`);
              void refreshTree();
              void refreshStats();
            }}
            onSectionMoveFailed={(message) => {
              showToast(`Could not move section: ${message}`);
            }}
            indexedNotes={indexedNotes}
            tagCounts={tagCounts}
            activeTagFilter={activeTagFilter}
            onFilterByTag={handleFilterByTag}
            onClearTagFilter={handleClearTagFilter}
            onTagRename={handleTagRename}
          />
        )}

        <CenterPane
          note={currentNote}
          viewMode={viewMode}
          theme={theme}
          isDirty={isDirty}
          onContentChange={handleContentChange}
          onSaveNow={() => saveNote(false)}
          onBlurSave={() => saveNote(false)}
          onNavigateRelative={handleSelectNote}
          onCreateNote={handleCreateBrokenNote}
          onOpenExternal={handleOpenExternal}
          onCloseNote={handleCloseNote}
          showConflictBanner={showConflictBanner}
          onKeepVersion={() => {
            // Force overwrite on disk
            saveNote(true);
          }}
          onLoadFromDisk={async () => {
            await loadNote(currentNotePath);
          }}
          onShowDifferences={() => {
            setDiffViewerOpen(true);
          }}
          onBack={handleBack}
          onForward={handleForward}
          onHeadingInView={(anchor) => setActiveHeadingAnchor(anchor)}
          scrollToAnchor={scrollToAnchor}
          scrollToLine={scrollToLine}
          treeData={treeData}
          indexedNotes={indexedNotes}
          savedScrollTop={activeScrollTop}
          savedCursorPos={activeCursorPos}
          onScrollOrCursorChange={(scrollTop, cursorPos, cursorLine, cursorCol, selectionLength) => {
            currentScrollTopRef.current = scrollTop;
            currentCursorPosRef.current = cursorPos;
            setCursorPosition({ line: cursorLine, col: cursorCol, selectionLength });
          }}
        />

        {rightSidebarVisible && (
          <RightSidebar
            note={currentNote}
            onNavigate={handleSelectNote}
            onCreateNote={handleCreateBrokenNote}
            onOpenExternal={handleOpenExternal}
            onClose={() => setRightSidebarVisible(false)}
            onFrontmatterSave={handleFrontmatterSave}
            tagCounts={tagCounts}
            onFilterByTag={handleFilterByTag}
            onTagRename={handleTagRename}
          />
        )}
        </>
        )}
      </div>

      {/* Status bar (SPEC §6.1, §6.2, §9.1, M7, M8) */}
      <StatusBar
        workspaceName={workspaceInfo.name}
        noteCount={workspaceStats.note_count}
        linkCount={workspaceStats.link_count}
        unresolvedCount={workspaceStats.unresolved_count}
        wordCount={textStats.wordCount}
        charCount={textStats.charCount}
        lineEnding={textStats.lineEnding}
        indexingProgress={indexingProgress}
        isWatcherDegraded={isWatcherDegraded}
        mcpStatus={mcpStatus}
        onRotateMcpToken={handleRotateMcpToken}
        onClickUnresolved={() => setUnresolvedModalOpen(true)}
        cursorLine={
          currentNotePath && viewMode !== 'read' && cursorPosition ? cursorPosition.line : undefined
        }
        cursorCol={
          currentNotePath && viewMode !== 'read' && cursorPosition ? cursorPosition.col : undefined
        }
        selectionLength={cursorPosition?.selectionLength}
      />

      {/* Command Palette Modal */}
      <CommandPalette
        isOpen={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        notes={noteState}
        indexedNotes={indexedNotes}
        onSelectNote={handleSelectNote}
        initialMode={paletteMode}
      />

      {/* Unresolved Links Modal (M7) */}
      <UnresolvedLinksModal
        isOpen={unresolvedModalOpen}
        onClose={() => setUnresolvedModalOpen(false)}
        unresolvedLinks={unresolvedLinks}
        onNavigateToSource={handleSelectNote}
        onCreateMissingNote={(rawTarget, sourcePath) => {
          handleCreateBrokenNote(rawTarget, sourcePath);
        }}
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

      {/* Permanent Delete Confirmation Modal */}
      <DeleteConfirmModal
        isOpen={deleteModalState.isOpen}
        itemName={deleteModalState.itemPath}
        isFolder={deleteModalState.isFolder}
        message={`Are you sure you want to permanently delete this ${deleteModalState.isFolder ? 'folder' : 'note'}? This action cannot be undone.`}
        onConfirm={handleConfirmPermanentDelete}
        onCancel={() => setDeleteModalState({ isOpen: false, itemPath: '', isFolder: false })}
      />

      {/* Toast Notification Container with Undo */}
      <Toast toasts={toasts} onDismiss={dismissToast} />
    </div>
      )}
    </>
  );
};

