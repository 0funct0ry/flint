import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { listen } from '@tauri-apps/api/event';
import { TitleBar, ViewMode } from './components/TitleBar';
import { LeftSidebar, LeftTab, InlineActionState } from './components/LeftSidebar';
import { CenterPane } from './components/CenterPane';
import { TabStrip } from './components/TabStrip';
import { RightSidebar } from './components/RightSidebar';
import { StatusBar } from './components/StatusBar';
import { CommandPalette } from './components/CommandPalette';
import { DiffViewer } from './components/DiffViewer';
import { Toast, ToastMessage } from './components/Toast';
import { DeleteConfirmModal } from './components/DeleteConfirmModal';
import { UnresolvedLinksModal } from './components/UnresolvedLinksModal';
import { NewNoteModal } from './components/NewNoteModal';
import { TemplatesScreen } from './components/TemplatesScreen';
import { FolderVariablesModal } from './components/FolderVariablesModal';
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
import {
  PaneLayout,
  Tab,
  createLayout,
  openNote as layoutOpenNote,
  openInNewTab as layoutOpenInNewTab,
  closeTab as layoutCloseTab,
  closeOthers as layoutCloseOthers,
  closeToRight as layoutCloseToRight,
  togglePin as layoutTogglePin,
  reorderTab,
  moveToOtherPane as layoutMoveToOtherPane,
  newPane as layoutNewPane,
  toggleOrientation,
  renamePath as layoutRenamePath,
  markMissing,
  patchTab,
  patchTabByPath,
  stepHistory,
  setActiveTab as layoutSetActiveTab,
  setActivePane as layoutSetActivePane,
  getActiveTab,
  getPaneActiveTab,
  findTabByPath,
  findTabById,
  tabIdForShortcut,
  tabsClosedByOthers,
  tabsClosedToRight,
  pushMru,
  serializeLayout,
  restoreLayout,
} from './state/panes';

const EMPTY_NOTE: NoteFixture = {
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

interface SelectOptions {
  /** Open as a new tab in the other pane (⇧↵ in the palette). */
  newPane?: boolean;
  /** Open as a new tab in the active pane (⌘-click, ⌥↵, "Open in new tab"). */
  newTab?: boolean;
}

export const App: React.FC = () => {
  const { config, loaded: settingsLoaded, refresh: refreshSettings, setField: setSettingsField } = useSettings();
  // Effective theme derives from `config.theme` ('system' follows the OS preference), so the
  // Settings screen and the title-bar toggle share one source of truth that also persists.
  const [systemDark, setSystemDark] = useState(() =>
    typeof window !== 'undefined' && window.matchMedia
      ? window.matchMedia('(prefers-color-scheme: dark)').matches
      : true
  );
  const theme: 'light' | 'dark' =
    config.theme === 'system' ? (systemDark ? 'dark' : 'light') : config.theme === 'light' ? 'light' : 'dark';
  const toggleTheme = useCallback(
    () => setSettingsField('theme', theme === 'dark' ? 'light' : 'dark'),
    [theme, setSettingsField]
  );
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = (e: MediaQueryListEvent) => setSystemDark(e.matches);
    mq.addEventListener?.('change', onChange);
    return () => mq.removeEventListener?.('change', onChange);
  }, []);
  // `viewMode` is per tab (M10.28). This is only the mode a pane shows when it has no tab, and
  // the mode new tabs start in; the live value is always the active tab's (see below).
  const [defaultViewMode, setDefaultViewMode] = useState<ViewMode>('split');
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

  // Panes and tabs (M10.28). `noteState` / `noteFingerprints` stay keyed by path — they are the
  // shared source of truth every tab reads from — while everything that used to be a flat global
  // about "the" open note (path, dirty, history, conflict, view mode) now lives on the tab.
  const [layout, setLayout] = useState<PaneLayout>(createLayout);
  const layoutRef = useRef<PaneLayout>(layout);
  const updateLayout = useCallback((fn: (l: PaneLayout) => PaneLayout): PaneLayout => {
    const next = fn(layoutRef.current);
    layoutRef.current = next;
    setLayout(next);
    return next;
  }, []);
  const [recentNotes, setRecentNotes] = useState<string[]>([]);
  // Live scroll/cursor per tab id — high-frequency, so kept out of React state.
  const tabViewRef = useRef<Map<string, { scrollTop: number; cursorPos: number }>>(new Map());

  const activeTab = getActiveTab(layout);
  const currentNotePath = activeTab?.path ?? '';
  const viewMode: ViewMode = activeTab?.viewMode ?? defaultViewMode;
  const diskVersionContent = activeTab?.diskVersionContent ?? '';
  const defaultViewModeRef = useRef<ViewMode>(defaultViewMode);
  defaultViewModeRef.current = defaultViewMode;

  const setViewMode = useCallback(
    (mode: ViewMode) => {
      setDefaultViewMode(mode);
      const tab = getActiveTab(layoutRef.current);
      if (tab) updateLayout((l) => patchTab(l, tab.id, { viewMode: mode }));
    },
    [updateLayout]
  );

  // Path-keyed tab updates: a path is open in at most one tab, so these are unambiguous even
  // when the tab isn't the active one.
  const setDirtyFor = useCallback(
    (path: string, dirty: boolean) => updateLayout((l) => patchTabByPath(l, path, { isDirty: dirty })),
    [updateLayout]
  );
  const setConflictFor = useCallback(
    (path: string, show: boolean, diskContent?: string) =>
      updateLayout((l) =>
        patchTabByPath(l, path, {
          showConflictBanner: show,
          diskVersionContent: show ? (diskContent ?? '') : null,
        })
      ),
    [updateLayout]
  );

  const [selectedFolderPath, setSelectedFolderPath] = useState<string>('');
  const [noteState, setNoteState] = useState<Record<string, NoteFixture>>(FIXTURE_NOTES);
  const [noteFingerprints, setNoteFingerprints] = useState<Record<string, Fingerprint>>({});
  const noteStateRef = useRef(noteState);
  noteStateRef.current = noteState;
  const noteFingerprintsRef = useRef(noteFingerprints);
  noteFingerprintsRef.current = noteFingerprints;
  const [cursorPosition, setCursorPosition] = useState<{
    line: number;
    col: number;
    selectionLength: number;
  } | null>(null);

  // Conflict handling: the banner state is per tab; only the diff viewer is global.
  const [diffViewerOpen, setDiffViewerOpen] = useState(false);

  // Palette modal state
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [paletteMode, setPaletteMode] = useState<'notes' | 'commands'>('notes');
  // "Open note in new tab…": the palette's plain Enter opens a tab instead of replacing.
  const [paletteNewTab, setPaletteNewTab] = useState(false);

  // Inline tree action state (create-note, create-folder, rename)
  const [inlineAction, setInlineAction] = useState<InlineActionState | null>(null);

  // M10.27 Journey B/C modal state.
  const [newNoteModal, setNewNoteModal] = useState<{ targetFolder: string } | null>(null);
  const [folderVariablesModal, setFolderVariablesModal] = useState<{
    folderPath: string;
    initialVariables: Record<string, string>;
  } | null>(null);

  // Templates management is a first-class screen (not a floating dialog): every entry point
  // (Settings, the tree's context menu, the command palette) navigates here, optionally with an
  // intent so the screen lands directly in create/edit mode instead of the plain list.
  const [templatesScreen, setTemplatesScreen] = useState<
    { open: false } | { open: true; initialCreate?: boolean; initialEditPath?: string }
  >({ open: false });

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

  // M10.29: a template that failed to render is used as written — never silently (persistent
  // toast, so it can't be missed while the new note opens).
  const showTemplateWarning = useCallback(
    (warning?: string) => {
      if (warning) showToast(`Template didn't render — used as written. ${warning}`, undefined, undefined, 10000);
    },
    [showToast]
  );

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

  // Autosave timers (debounced), one per path so typing in two panes never drops a pending save.
  const autosaveTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const clearAutosave = useCallback((path?: string) => {
    const timers = autosaveTimersRef.current;
    if (path === undefined) {
      timers.forEach((t) => clearTimeout(t));
      timers.clear();
    } else {
      const t = timers.get(path);
      if (t) clearTimeout(t);
      timers.delete(path);
    }
  }, []);

  // Clean up autosave timers on unmount
  useEffect(() => {
    const timers = autosaveTimersRef.current;
    return () => {
      timers.forEach((t) => clearTimeout(t));
      timers.clear();
    };
  }, []);

  // Stash a tab's live scroll/cursor into the tab itself (used before it navigates away).
  const stashTabView = useCallback(
    (tabId: string) => {
      const v = tabViewRef.current.get(tabId);
      if (v) updateLayout((l) => patchTab(l, tabId, { scrollTop: v.scrollTop, cursorPos: v.cursorPos }));
    },
    [updateLayout]
  );

  // Rename/move propagation (M10.28): every tab pointing at the path updates in place — same tab
  // ids, no reload — and the path-keyed caches are re-keyed so unsaved buffers survive.
  const applyRename = useCallback(
    (from: string, to: string) => {
      if (!from || from === to) return;
      const remap = (p: string) =>
        p === from ? to : p.startsWith(`${from}/`) ? `${to}${p.slice(from.length)}` : p;
      updateLayout((l) => layoutRenamePath(l, from, to));
      const rekey = <T,>(prev: Record<string, T>, fix?: (v: T, np: string) => T): Record<string, T> => {
        let changed = false;
        const out: Record<string, T> = {};
        for (const [k, v] of Object.entries(prev)) {
          const nk = remap(k);
          if (nk !== k) changed = true;
          out[nk] = nk !== k && fix ? fix(v, nk) : v;
        }
        return changed ? out : prev;
      };
      setNoteState((prev) =>
        rekey(prev, (n, np) => ({ ...n, path: np, folder: np.split('/').slice(0, -1).join('/') }))
      );
      setNoteFingerprints((prev) => rekey(prev));
      const timers = autosaveTimersRef.current;
      for (const [k, t] of Array.from(timers.entries())) {
        if (remap(k) !== k) {
          timers.delete(k);
          // The pending save fires against the old path; cancel it — the buffer is saved on the
          // next edit, blur, or close, all of which use the new path.
          clearTimeout(t);
        }
      }
    },
    [updateLayout]
  );

  // Refresh workspace tree helper
  const refreshTree = useCallback(async () => {
    try {
      const tree = await api.workspaceTree(config.ui.showNonNoteFiles);
      setTreeData(tree);
      setTreeError(null);
    } catch (err: any) {
      setTreeError(err?.message || String(err));
    }
  }, [config.ui.showNonNoteFiles]);

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

      setDirtyFor(path, false);
      setConflictFor(path, false);
    } catch (err) {
      console.warn(`Failed to read note ${path}:`, err);
    }
  }, [theme, setDirtyFor, setConflictFor]);

  // Save note via IPC
  const saveNote = useCallback(
    async (force = false, pathArg?: string) => {
      const path = pathArg ?? getActiveTab(layoutRef.current)?.path ?? '';
      if (!path) return;
      const tabForPath = findTabByPath(layoutRef.current, path)?.tab;
      const dirty = !!tabForPath?.isDirty;
      if (!dirty && !force) return;
      if (tabForPath?.missing) return;
      const content = noteStateRef.current[path]?.content ?? '';
      const fingerprint = noteFingerprintsRef.current[path];

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
        setDirtyFor(path, false);
        setConflictFor(path, false);

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
        {
          api.linksBacklinks(path).then((bls) => {
            setNoteState((prev) => {
              const cur = prev[path];
              if (!cur) return prev;
              return { ...prev, [path]: { ...cur, backlinks: bls } };
            });
          });

          // Refresh note metadata (tags, title, headings, front-matter fields) from backend —
          // keeps the Frontmatter panel in sync with fields added/edited by hand in the buffer.
          api.noteRead(path).then((readNote) => {
            setNoteState((prev) => {
              const cur = prev[path];
              if (!cur) return prev;
              return {
                ...prev,
                [path]: {
                  ...cur,
                  tags: readNote.meta.tags,
                  title: readNote.meta.title,
                  headings: readNote.meta.headings,
                  frontMatterFields: readNote.front_matter_fields,
                },
              };
            });
          }).catch((err) => {
            console.warn(`Failed to refresh metadata after save for ${path}:`, err);
          });
        }
      } catch (err: any) {
        const errMsg = err?.message || String(err);
        if (errMsg.toLowerCase().includes('conflict')) {
          // Note changed on disk externally
          let disk = '';
          try {
            disk = (await api.noteRead(path)).content;
          } catch {
            disk = '';
          }
          setConflictFor(path, true, disk);
        } else {
          console.error(`Error saving note ${path}:`, err);
        }
      }
    },
    [refreshStats, theme, setDirtyFor, setConflictFor]
  );

  // Save every dirty tab (window blur / unload) — with panes, more than one can be dirty.
  const saveAllDirty = useCallback(() => {
    for (const pane of layoutRef.current.panes) {
      for (const tab of pane.tabs) {
        if (tab.isDirty) void saveNote(false, tab.path);
      }
    }
  }, [saveNote]);

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
        const tree = await api.workspaceTree(config.ui.showNonNoteFiles);
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

        // If the changed note is open in any tab (M10.28: not just the active one)
        const openTab = changedPath ? findTabByPath(layoutRef.current, changedPath)?.tab : undefined;
        if (changedPath && openTab) {
          if (!openTab.isDirty) {
            // Unsaved edits absent: reload in place; live scroll/cursor live in `tabViewRef`,
            // which the reload doesn't touch (SPEC §5.3, M8).
            await loadNote(changedPath);
          } else {
            // Note has unsaved edits: show conflict banner (SPEC §5.3)
            let disk = '';
            try {
              disk = (await api.noteRead(changedPath)).content;
            } catch {
              disk = '';
            }
            setConflictFor(changedPath, true, disk);
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
        // A tab whose note vanished stays open with a "no longer exists" state rather than
        // auto-closing under a user who may not be looking at it (data-safety conventions).
        if (removedPath) updateLayout((l) => markMissing(l, removedPath));
      }).then((unsub) => {
        unlistenRemoved = unsub;
      });

      listen<{ from: string; to: string }>('note:renamed', (event) => {
        if (!mounted) return;
        const { from, to } = event.payload || {};
        refreshTree();
        refreshStats();
        if (from && to) applyRename(from, to);
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
      saveAllDirty();
    };

    window.addEventListener('blur', handleBlur);
    window.addEventListener('beforeunload', handleBlur);
    return () => {
      window.removeEventListener('blur', handleBlur);
      window.removeEventListener('beforeunload', handleBlur);
    };
  }, [saveAllDirty]);

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
    setViewMode(config.behaviour.defaultMode as ViewMode);
    setDefaultViewMode(config.behaviour.defaultMode as ViewMode);
    // Fresh workspaces have no saved layout yet — fall back to the configured UI defaults.
    setLeftTab(config.ui.leftSidebar as LeftTab);
    setRightSidebarVisible(config.ui.rightSidebarVisible);
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
    if (Array.isArray(layout.recentNotes)) {
      setRecentNotes(layout.recentNotes.filter((p): p is string => typeof p === 'string').slice(0, 20));
    }
    const persistedPanes = layout.panes;
    if (persistedPanes && Array.isArray(persistedPanes.panes)) {
      // Restore every pane and tab, dropping paths that no longer resolve to a file (silently —
      // nothing to show for them).
      const wanted = Array.from(
        new Set(
          persistedPanes.panes.flatMap((p) =>
            (Array.isArray(p?.tabs) ? p.tabs : []).map((t) => t?.path).filter((x): x is string => typeof x === 'string')
          )
        )
      );
      void (async () => {
        const live = new Set<string>();
        await Promise.all(
          wanted.map(async (path) => {
            try {
              await api.noteRead(path);
              live.add(path);
            } catch {
              /* missing: skipped */
            }
          })
        );
        const restored = restoreLayout(
          persistedPanes,
          (path) => live.has(path),
          config.behaviour.defaultMode as ViewMode
        );
        if (restored) {
          // A note the CLI asked to open (initial_note) may already be showing; keep it.
          const already = getActiveTab(layoutRef.current)?.path;
          updateLayout(() => (already ? layoutOpenInNewTab(restored, already) : restored));
          await Promise.all(
            restored.panes.flatMap((p) => p.tabs.map((t) => loadNote(t.path)))
          );
          return;
        }
        if (layout.lastOpenNote) handleSelectNote(layout.lastOpenNote);
      })();
      return;
    }
    if (layout.lastOpenNote) {
      handleSelectNote(layout.lastOpenNote);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settingsLoaded]);

  // Apply changes to the default-mode / sidebar settings immediately (the initial values are
  // applied by the seeding effect above; these only fire when the setting itself changes).
  const prevUiDefaultsRef = useRef({
    mode: config.behaviour.defaultMode,
    left: config.ui.leftSidebar,
    right: config.ui.rightSidebarVisible,
  });
  useEffect(() => {
    if (!layoutSeededRef.current) return;
    const prev = prevUiDefaultsRef.current;
    if (prev.mode !== config.behaviour.defaultMode) {
      setViewMode(config.behaviour.defaultMode as ViewMode);
    }
    if (prev.left !== config.ui.leftSidebar) setLeftTab(config.ui.leftSidebar as LeftTab);
    if (prev.right !== config.ui.rightSidebarVisible) {
      setRightSidebarVisible(config.ui.rightSidebarVisible);
    }
    prevUiDefaultsRef.current = {
      mode: config.behaviour.defaultMode,
      left: config.ui.leftSidebar,
      right: config.ui.rightSidebarVisible,
    };
  }, [config.behaviour.defaultMode, config.ui.leftSidebar, config.ui.rightSidebarVisible, setViewMode]);

  // Re-fetch the tree when non-note-file visibility changes.
  useEffect(() => {
    if (!layoutSeededRef.current) return;
    void refreshTree();
  }, [config.ui.showNonNoteFiles, refreshTree]);

  // Re-render the open note when the theme or a Markdown extension toggle changes, using the
  // in-memory buffer so unsaved edits are not lost.
  const { math: mdMath, tables: mdTables, footnotes: mdFootnotes, smartPunctuation: mdSmart } =
    config.markdown;
  useEffect(() => {
    // Every open tab, not just the active one — two panes can show two notes at once.
    const paths = layoutRef.current.panes.flatMap((p) => p.tabs.filter((t) => !t.missing).map((t) => t.path));
    if (paths.length === 0) return;
    let cancelled = false;
    for (const path of paths) {
      const content = noteStateRef.current[path]?.content ?? '';
      api
        .noteRender(path, content, theme)
        .then((renderRes) => {
          if (cancelled) return;
          setNoteState((prev) => {
            const cur = prev[path];
            if (!cur) return prev;
            return { ...prev, [path]: { ...cur, renderedHtml: renderRes.html } };
          });
        })
        .catch(() => {});
    }
    return () => {
      cancelled = true;
    };
  }, [theme, mdMath, mdTables, mdFootnotes, mdSmart]);

  // Persist sidebar-visibility / active-tab layout changes, debounced (400-500ms) like the
  // existing autosave pattern, so rapid toggles don't fire a config_set per event.
  // Pane/tab structure and the MRU list ride the same debounce (M10.28). They're compared as
  // JSON so per-keystroke dirty/conflict/history changes — which don't alter the persisted
  // structure — never reset the timer or cause a write.
  const panesJson = useMemo(() => JSON.stringify(serializeLayout(layout)), [layout]);
  const recentJson = useMemo(() => JSON.stringify(recentNotes), [recentNotes]);
  useEffect(() => {
    if (!layoutSeededRef.current) return;
    if (layoutSaveTimerRef.current) clearTimeout(layoutSaveTimerRef.current);
    layoutSaveTimerRef.current = setTimeout(() => {
      setSettingsField('layout.leftSidebarCollapsed', !leftSidebarVisible);
      setSettingsField('layout.rightSidebarCollapsed', !rightSidebarVisible);
      setSettingsField('layout.activeLeftTab', leftTab);
      setSettingsField('layout.panes', JSON.parse(panesJson));
      setSettingsField('layout.recentNotes', JSON.parse(recentJson));
    }, 450);
    return () => {
      if (layoutSaveTimerRef.current) clearTimeout(layoutSaveTimerRef.current);
    };
  }, [leftSidebarVisible, rightSidebarVisible, leftTab, panesJson, recentJson, setSettingsField]);

  // MRU: every tab-focus event (tab switch, pane switch, navigation) bumps the note to the front.
  useEffect(() => {
    if (!currentNotePath) return;
    setRecentNotes((prev) => pushMru(prev, currentNotePath));
  }, [currentNotePath, activeTab?.id]);

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
    const cur = getActiveTab(layoutRef.current)?.viewMode ?? defaultViewModeRef.current;
    setViewMode(cur === 'edit' ? 'read' : cur === 'read' ? 'split' : 'edit');
  }, [setViewMode]);

  // Note selection — the single entry point for opening a note. By default it navigates the
  // active tab (pushing that tab's own history); `{newPane: true}` opens it as a new tab in the
  // other pane; a note already open anywhere is focused, never duplicated.
  const handleSelectNote = useCallback(
    async (
      targetPath: string,
      lineOrOpts?: number | SelectOptions,
      maybeOpts?: SelectOptions
    ) => {
      const targetLine = typeof lineOrOpts === 'number' ? lineOrOpts : undefined;
      const opts: SelectOptions = (typeof lineOrOpts === 'object' ? lineOrOpts : maybeOpts) ?? {};

      // Split anchor if present
      const cleanPath = targetPath.split('#')[0];
      const anchor = targetPath.includes('#') ? targetPath.split('#')[1] : null;

      if (!cleanPath && anchor) {
        setScrollToAnchor(anchor);
        setTimeout(() => setScrollToAnchor(null), 300);
        return;
      }

      const cur = getActiveTab(layoutRef.current);
      if (cleanPath === cur?.path && !opts.newPane) {
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

      const alreadyOpen = !!findTabByPath(layoutRef.current, cleanPath);

      // Save the note being navigated away from if dirty (existing single-note behaviour)
      const replacing = !opts.newPane && !opts.newTab;
      if (cur && !alreadyOpen && replacing && cur.isDirty) {
        clearAutosave(cur.path);
        await saveNote(false, cur.path);
      }
      if (cur && !alreadyOpen && replacing) stashTabView(cur.id);

      const before = getActiveTab(layoutRef.current);
      const mode = before?.viewMode ?? defaultViewModeRef.current;
      updateLayout((l) =>
        opts.newTab && !opts.newPane
          ? layoutOpenInNewTab(l, cleanPath, mode)
          : layoutOpenNote(l, cleanPath, { newPane: opts.newPane, viewMode: mode })
      );
      if (cur && !alreadyOpen && replacing && !cur.pinned) tabViewRef.current.delete(cur.id);
      setCursorPosition(null);

      // A tab that was already open keeps its in-memory buffer (it may be dirty); everything
      // else is read from disk.
      const needsLoad = !alreadyOpen || !noteFingerprintsRef.current[cleanPath];
      if (needsLoad) await loadNote(cleanPath);

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
    [clearAutosave, loadNote, saveNote, stashTabView, updateLayout]
  );

  // Open a given path as the active workspace (M10.04 onboarding)
  const openWorkspacePath = useCallback(
    async (path: string) => {
      try {
        const info = await api.workspaceOpen(path);
        // A different workspace: its panes, tabs, histories and buffers don't carry over.
        clearAutosave();
        tabViewRef.current.clear();
        updateLayout(() => createLayout());
        setNoteFingerprints({});
        setCursorPosition(null);
        setWorkspaceInfo(info);
        setNoWorkspace(false);
        if (info.start_collapsed) {
          setLeftSidebarVisible(false);
        }
        const tree = await api.workspaceTree(config.ui.showNonNoteFiles);
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
    [clearAutosave, handleSelectNote, refreshStats, updateLayout, config.ui.showNonNoteFiles]
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
        const created = await api.noteCreate(targetPath, config.templates.defaultTemplate ?? undefined);
        await refreshTree();
        await refreshStats();
        showToast(`Created note "${targetPath}"`);
        showTemplateWarning(created.templateWarning);
        await handleSelectNote(targetPath);
      } catch (err: any) {
        showToast(`Failed to create note: ${err?.message || String(err)}`);
      }
    },
    [config.templates.defaultTemplate, handleSelectNote, refreshStats, refreshTree, showToast, showTemplateWarning]
  );

  // Open (creating on first use) a daily note (M10.26). Only ever invoked from an explicit
  // command — never on startup — per the milestone's data-safety note.
  const handleDailyNoteOpen = useCallback(
    async (offsetDays?: number, date?: string) => {
      try {
        const meta = await api.dailyNoteOpen(offsetDays, date);
        await refreshTree();
        await handleSelectNote(meta.path);
        showTemplateWarning(meta.templateWarning);
      } catch (err: any) {
        showToast(`Failed to open daily note: ${err?.message || String(err)}`);
      }
    },
    [handleSelectNote, refreshTree, showToast, showTemplateWarning]
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
          let disk = '';
          try {
            disk = (await api.noteRead(path)).content;
          } catch {
            disk = '';
          }
          setConflictFor(path, true, disk);
        } else {
          showToast(`Failed to save front matter: ${errMsg}`);
        }
      }
    },
    [currentNotePath, noteFingerprints, setConflictFor, showToast]
  );

  // History back / forward (per tab) with cursor and scroll restoration
  const stepTabHistory = useCallback(
    async (tabId: string | undefined, delta: -1 | 1) => {
      const tab = tabId
        ? findTabById(layoutRef.current, tabId)?.tab
        : getActiveTab(layoutRef.current) ?? undefined;
      if (!tab) return;
      const target = tab.history[tab.historyIndex + delta];
      if (!target) return;
      clearAutosave(tab.path);
      if (tab.isDirty) await saveNote(false, tab.path);
      stashTabView(tab.id);
      const res = stepHistory(layoutRef.current, tab.id, delta);
      if (!res) return;
      updateLayout(() => res.layout);
      tabViewRef.current.delete(tab.id);
      setCursorPosition(null);
      await loadNote(res.entry.path);
    },
    [clearAutosave, loadNote, saveNote, stashTabView, updateLayout]
  );
  const handleBack = useCallback((tabId?: string) => stepTabHistory(tabId, -1), [stepTabHistory]);
  const handleForward = useCallback((tabId?: string) => stepTabHistory(tabId, 1), [stepTabHistory]);

  /** Render `newNote.filenamePattern`'s `{{ title }}` placeholder against a filler title, used as
   * both the inline-create field's initial value and the New Note modal's initial name field —
   * the real render (with the user's chosen name as `{{ title }}`) happens once, in Rust, inside
   * `note_create`. */
  const newNoteInitialName = useMemo(() => {
    const pattern = config.newNote.filenamePattern || '{{ title }}';
    const rendered = pattern.replace(/\{\{\s*title\s*\}\}/gi, 'Untitled');
    return rendered.endsWith('.md') || rendered.endsWith('.markdown') ? rendered : `${rendered}.md`;
  }, [config.newNote.filenamePattern]);

  // Action handlers for tree. M10.27 originally routed all note creation through `NewNoteModal`;
  // per follow-up feedback, "New Note" is back to the pre-M10.27 fast inline-rename flow (blank or
  // `templates.defaultTemplate`, no dialog), and the modal (with its template picker + variable
  // form) is now a separate "New Note from Template…" entry point. Both still honor the
  // M10.26-deferred `newNote.targetFolder` override.
  const handleStartCreateNote = useCallback((parentFolder?: string) => {
    setLeftSidebarVisible(true);
    setLeftTab('tree');
    const clicked = parentFolder !== undefined ? parentFolder : selectedFolderPath;
    const folder = config.newNote.targetFolder || config.behaviour.newNoteFolder || clicked;
    setInlineAction({
      type: 'create-note',
      targetPath: folder,
      initialValue: newNoteInitialName,
    });
  }, [selectedFolderPath, config.newNote.targetFolder, config.behaviour.newNoteFolder, newNoteInitialName]);

  const handleStartCreateNoteFromTemplate = useCallback((parentFolder?: string) => {
    setLeftSidebarVisible(true);
    setLeftTab('tree');
    const clicked = parentFolder !== undefined ? parentFolder : selectedFolderPath;
    const folder = config.newNote.targetFolder || config.behaviour.newNoteFolder || clicked;
    setNewNoteModal({ targetFolder: folder });
  }, [selectedFolderPath, config.newNote.targetFolder, config.behaviour.newNoteFolder]);

  const handleCreateNoteFromModal = useCallback(
    async (name: string, templatePath: string | undefined, variables: Record<string, string>) => {
      if (!newNoteModal) return;
      const noteFileName = name.endsWith('.md') || name.endsWith('.markdown') ? name : `${name}.md`;
      const folder = newNoteModal.targetFolder;
      const relativePath = folder ? `${folder}/${noteFileName}` : noteFileName;
      const hasVariables = Object.keys(variables).length > 0;
      try {
        const created = await api.noteCreate(relativePath, templatePath, hasVariables ? variables : undefined);
        await refreshTree();
        setNewNoteModal(null);
        await handleSelectNote(relativePath);
        showToast(`Created note "${noteFileName}"`);
        showTemplateWarning(created.templateWarning);
      } catch (e) {
        showToast(`Could not create note: ${e}`);
      }
    },
    [newNoteModal, refreshTree, handleSelectNote, showToast, showTemplateWarning]
  );

  const handleSaveFolderVariables = useCallback(
    async (variables: Record<string, string>) => {
      if (!folderVariablesModal) return;
      try {
        await api.folderVariablesSet(folderVariablesModal.folderPath, variables);
        setFolderVariablesModal(null);
        showToast('Updated folder variables');
      } catch (e) {
        showToast(`Could not update folder variables: ${e}`);
      }
    },
    [folderVariablesModal, showToast]
  );

  // Templates management is one first-class screen (`TemplatesScreen`); every entry point just
  // navigates there, optionally with an intent so it lands directly in create/edit mode.
  const handleOpenTemplatesScreen = useCallback(
    (intent?: { initialCreate?: boolean; initialEditPath?: string }) => {
      setTemplatesScreen({ open: true, ...intent });
    },
    []
  );

  const handleOpenFolderVariables = useCallback(async (folderPath: string) => {
    try {
      const variables = await api.folderVariablesGet(folderPath);
      setFolderVariablesModal({ folderPath, initialVariables: variables });
    } catch (e) {
      showToast(`Could not load folder variables: ${e}`);
    }
  }, [showToast]);

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
        const relativePath = inlineAction.targetPath
          ? `${inlineAction.targetPath}/${noteFileName}`
          : noteFileName;
        const created = await api.noteCreate(relativePath, config.templates.defaultTemplate ?? undefined);
        await refreshTree();
        setInlineAction(null);
        await handleSelectNote(relativePath);
        showToast(`Created note "${noteFileName}"`);
        showTemplateWarning(created.templateWarning);
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

          // Every open tab on the renamed note (or inside a renamed folder) updates in place.
          applyRename(fromPath, toPath);

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
  }, [
    showTemplateWarning,
    config.templates.defaultTemplate,
    applyRename,
    handleSelectNote,
    inlineAction,
    refreshStats,
    refreshTree,
    showToast,
  ]);

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
    // `behaviour.deleteToTrash` off: every delete is permanent, so it always asks first.
    if (permanent || !config.behaviour.deleteToTrash) {
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
      updateLayout((l) => markMissing(l, itemPath));
      showToast(`Moved "${itemPath.split('/').pop()}" to Trash`);
    } catch (err: any) {
      showToast(`Delete failed: ${err?.message || String(err)}`);
    }
  }, [refreshTree, showToast, updateLayout, config.behaviour.deleteToTrash]);

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
      updateLayout((l) => markMissing(l, itemPath));
      showToast(`Permanently deleted "${itemPath.split('/').pop()}"`);
    } catch (err: any) {
      showToast(`Permanent delete failed: ${err?.message || String(err)}`);
    }
  }, [deleteModalState, refreshTree, showToast, updateLayout]);

  const handleMoveItem = useCallback(async (fromPath: string, toParentFolder: string) => {
    const itemName = fromPath.split('/').pop()!;
    const toPath = toParentFolder ? `${toParentFolder}/${itemName}` : itemName;

    try {
      const res = await api.noteRename(fromPath, toPath);
      await refreshTree();
      await refreshStats();

      applyRename(fromPath, toPath);

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
            applyRename(toPath, fromPath);
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
  }, [applyRename, refreshStats, refreshTree, showToast]);

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

  // Saves a tab's unsaved edits before it closes — the same save-then-leave flow the single-note
  // app had, never a second dirty-close dialog. A save that hits a conflict leaves the tab dirty;
  // closing it then would silently drop the buffer, so the close is refused instead.
  const saveBeforeClose = useCallback(
    async (tabs: Tab[]): Promise<boolean> => {
      for (const tab of tabs) {
        clearAutosave(tab.path);
        if (tab.isDirty && !tab.missing) await saveNote(false, tab.path);
      }
      const stillDirty = tabs.some((t) => {
        const cur = findTabById(layoutRef.current, t.id)?.tab;
        return !!cur && cur.isDirty && !cur.missing;
      });
      if (stillDirty) {
        showToast('Unsaved changes could not be saved (the note changed on disk). Resolve the conflict first.');
        return false;
      }
      return true;
    },
    [clearAutosave, saveNote, showToast]
  );

  const handleCloseNote = useCallback(
    async (tabId?: string) => {
      const tab = tabId
        ? findTabById(layoutRef.current, tabId)?.tab
        : getActiveTab(layoutRef.current) ?? undefined;
      if (!tab) return;
      if (!(await saveBeforeClose([tab]))) return;
      tabViewRef.current.delete(tab.id);
      updateLayout((l) => layoutCloseTab(l, tab.id));
      setCursorPosition(null);
    },
    [saveBeforeClose, updateLayout]
  );

  const handleCloseOthers = useCallback(
    async (tabId?: string) => {
      const id = tabId ?? getActiveTab(layoutRef.current)?.id;
      if (!id) return;
      const closing = tabsClosedByOthers(layoutRef.current, id);
      if (!(await saveBeforeClose(closing))) return;
      closing.forEach((t) => tabViewRef.current.delete(t.id));
      updateLayout((l) => layoutCloseOthers(l, id));
    },
    [saveBeforeClose, updateLayout]
  );

  const handleCloseToRight = useCallback(
    async (tabId: string) => {
      const closing = tabsClosedToRight(layoutRef.current, tabId);
      if (!(await saveBeforeClose(closing))) return;
      closing.forEach((t) => tabViewRef.current.delete(t.id));
      updateLayout((l) => layoutCloseToRight(l, tabId));
    },
    [saveBeforeClose, updateLayout]
  );

  const handleActivateTab = useCallback(
    (tabId: string) => {
      updateLayout((l) => layoutSetActiveTab(l, tabId));
      setCursorPosition(null);
    },
    [updateLayout]
  );

  const handleFocusPane = useCallback(
    (paneId: string) => {
      if (layoutRef.current.activePaneId !== paneId) {
        updateLayout((l) => layoutSetActivePane(l, paneId));
        setCursorPosition(null);
      }
    },
    [updateLayout]
  );

  const handleTogglePin = useCallback(
    (tabId?: string) => {
      const id = tabId ?? getActiveTab(layoutRef.current)?.id;
      if (id) updateLayout((l) => layoutTogglePin(l, id));
    },
    [updateLayout]
  );

  const handleMoveToOtherPane = useCallback(
    (tabId?: string) => {
      const id = tabId ?? getActiveTab(layoutRef.current)?.id;
      if (id) updateLayout((l) => layoutMoveToOtherPane(l, id));
    },
    [updateLayout]
  );

  const handleNewPane = useCallback(() => updateLayout((l) => layoutNewPane(l)), [updateLayout]);
  const handleToggleOrientation = useCallback(() => updateLayout((l) => toggleOrientation(l)), [updateLayout]);

  // ⌘1–⌘9: jump to the Nth tab in the active pane (⌘9 = the last tab).
  const handleJumpToTab = useCallback(
    (n: number) => {
      const pane = layoutRef.current.panes.find((p) => p.id === layoutRef.current.activePaneId);
      const id = pane ? tabIdForShortcut(pane, n) : null;
      if (id) handleActivateTab(id);
    },
    [handleActivateTab]
  );

  // Register commands in registry per SPEC §9.3 & M4. Metadata (id/title/shortcut) lives in
  // src/commands/appCommands.ts — the single source of truth the docs site's shortcut table is
  // generated from — and only the live handlers are wired up here.
  useEffect(() => {
    const handlers: Partial<Record<string, () => void>> = {
      'file.new_note': () => handleStartCreateNote(),
      'file.new_folder': () => handleStartCreateFolder(),
      'file.new_template': () => handleOpenTemplatesScreen({ initialCreate: true }),
      'view.manage_templates': () => handleOpenTemplatesScreen(),
      'file.close': () => handleCloseNote(),
      'pane.new': handleNewPane,
      'tab.open_note_in_new_tab': () => {
        setPaletteMode('notes');
        setPaletteNewTab(true);
        setPaletteOpen(true);
      },
      'pane.toggle_orientation': handleToggleOrientation,
      'tab.close_others': () => handleCloseOthers(),
      'tab.toggle_pin': () => handleTogglePin(),
      'tab.move_to_other_pane': () => handleMoveToOtherPane(),
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
      'theme.toggle': toggleTheme,
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
    handleCloseOthers,
    handleMoveToOtherPane,
    handleNewPane,
    handleToggleOrientation,
    handleTogglePin,
    handleDailyNoteOpen,
    handleDailyNotePickDate,
    handleStartCreateFolder,
    handleStartCreateNote,
    handleOpenTemplatesScreen,
    saveNote,
    toggleTheme,
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
      } else if (mod && e.shiftKey && e.key.toLowerCase() === 'r') {
        e.preventDefault();
        const path = getActiveTab(layoutRef.current)?.path;
        if (path) handleRevealInFileManager(path);
      } else if (mod && e.key.toLowerCase() === 's') {
        e.preventDefault();
        saveNote(false);
      } else if (mod && e.key.toLowerCase() === 'o') {
        e.preventDefault();
        handleOpenFolder();
      } else if (mod && e.key === ',') {
        e.preventDefault();
        setSettingsOpen((prev) => !prev);
      } else if (mod && !e.shiftKey && !e.altKey && /^[1-9]$/.test(e.key)) {
        e.preventDefault();
        handleJumpToTab(parseInt(e.key, 10));
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [cycleViewMode, handleBack, handleCloseNote, handleForward, handleJumpToTab, handleOpenFolder, handleRevealInFileManager, handleStartCreateFolder, handleStartCreateNote, saveNote]);

  const noteFor = useCallback(
    (path: string): NoteFixture =>
      path
        ? noteState[path] ||
          FIXTURE_NOTES[path] || {
            path,
            title: path.split('/').pop()?.replace(/\.md$/, '') || 'Untitled',
            folder: path.split('/').slice(0, -1).join('/'),
            tags: [],
            content: '',
            headings: [],
            outgoingLinks: [],
            backlinks: [],
            renderedHtml: '',
            lastModifiedAgo: 'just now',
          }
        : EMPTY_NOTE,
    [noteState]
  );
  const currentNote = noteFor(currentNotePath);

  const tabTitle = useCallback(
    (tab: Tab) =>
      noteState[tab.path]?.title || tab.path.split('/').pop()?.replace(/\.(md|markdown)$/i, '') || tab.path,
    [noteState]
  );

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

  // Content change handler with 400ms debounced autosave and live outgoing links extraction.
  // Keyed by path (not "the current note"): with panes, the edit can come from a non-active tab.
  const handleContentChange = (targetPath: string, newContent: string) => {
    if (!targetPath) return;
    setDirtyFor(targetPath, true);
    const renderedHtml = renderMarkdownToHtml(newContent);
    setNoteState((prev) => {
      const current = prev[targetPath];
      return {
        ...prev,
        [targetPath]: {
          ...current,
          content: newContent,
          renderedHtml,
        },
      };
    });

    // Extract outgoing links live for the right sidebar
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
    clearAutosave(targetPath);
    autosaveTimersRef.current.set(
      targetPath,
      setTimeout(() => {
        autosaveTimersRef.current.delete(targetPath);
        saveNote(false, targetPath);
      }, config.behaviour.autosaveMs)
    );
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
      {/* Title bar — hidden while a full-pane modal screen (Settings, Templates) is open */}
      {!settingsOpen && !templatesScreen.open && (
      <TitleBar
        breadcrumb={breadcrumb}
        viewMode={viewMode}
        onViewModeChange={setViewMode}
        onOpenPalette={() => {
          setPaletteMode('notes');
          setPaletteOpen(true);
        }}
        onToggleTheme={toggleTheme}
        theme={theme}
        leftSidebarVisible={leftSidebarVisible}
        onToggleLeftSidebar={() => setLeftSidebarVisible((prev) => !prev)}
        rightSidebarVisible={rightSidebarVisible}
        onToggleRightSidebar={() => setRightSidebarVisible((prev) => !prev)}
        onOpenSettings={() => setSettingsOpen((prev) => !prev)}
        onOpenTemplates={() => handleOpenTemplatesScreen()}
      />
      )}

      {/* Main body with sidebars & editor/reader, or a full-pane screen (Settings, Templates) */}
      <div className="flex-1 flex min-h-0">
        {settingsOpen ? (
          <SettingsPanel
            onClose={() => setSettingsOpen(false)}
            onOpenTemplates={() => {
              setSettingsOpen(false);
              handleOpenTemplatesScreen();
            }}
          />
        ) : templatesScreen.open ? (
          <TemplatesScreen
            onClose={() => setTemplatesScreen({ open: false })}
            initialCreate={templatesScreen.initialCreate}
            initialEditPath={templatesScreen.initialEditPath}
          />
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
            onCreateNoteFromTemplate={handleStartCreateNoteFromTemplate}
            onCreateFolder={handleStartCreateFolder}
            onRenameItem={handleStartRename}
            onDuplicateNote={handleDuplicateNote}
            onDeleteItem={handleDeleteItem}
            onMoveItem={handleMoveItem}
            onRevealInFileManager={handleRevealInFileManager}
            onCopyRelativePath={handleCopyRelativePath}
            onCreateTemplate={() => handleOpenTemplatesScreen({ initialCreate: true })}
            onEditTemplateVariables={(templatePath) =>
              handleOpenTemplatesScreen({ initialEditPath: templatePath })
            }
            onEditFolderVariables={handleOpenFolderVariables}
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

        <div
          className={`flex-1 flex min-w-0 min-h-0 ${layout.orientation === 'vertical' ? 'flex-row' : 'flex-col'}`}
        >
          {layout.panes.map((pane, paneIndex) => {
            const tab = getPaneActiveTab(pane);
            const isActivePane = pane.id === layout.activePaneId;
            const multiPane = layout.panes.length > 1;
            const tabNote = tab ? noteFor(tab.path) : EMPTY_NOTE;
            const view = tab ? tabViewRef.current.get(tab.id) : undefined;
            return (
              <div
                key={pane.id}
                data-testid={`pane-${paneIndex}`}
                className={`flex-1 flex flex-col min-w-0 min-h-0 ${
                  paneIndex > 0
                    ? layout.orientation === 'vertical'
                      ? 'border-l border-[var(--border)]'
                      : 'border-t border-[var(--border)]'
                    : ''
                } ${multiPane && isActivePane ? 'shadow-[inset_0_2px_0_var(--accent)]' : ''}`}
              >
                <TabStrip
                  paneId={pane.id}
                  tabs={pane.tabs}
                  activeTabId={pane.activeTabId}
                  isActivePane={isActivePane}
                  titleFor={tabTitle}
                  onActivate={handleActivateTab}
                  onClose={(id) => void handleCloseNote(id)}
                  onCloseOthers={(id) => void handleCloseOthers(id)}
                  onCloseToRight={(id) => void handleCloseToRight(id)}
                  onTogglePin={handleTogglePin}
                  onMoveToOtherPane={handleMoveToOtherPane}
                  onReorder={(from, to) => updateLayout((l) => reorderTab(l, pane.id, from, to))}
                />
                <CenterPane
                  note={tabNote}
                  tabId={tab?.id}
                  hideNoteIdentity
                  onReveal={() => tab?.path && handleRevealInFileManager(tab.path)}
                  isActivePane={isActivePane}
                  missing={!!tab?.missing}
                  onPaneFocus={() => handleFocusPane(pane.id)}
                  viewMode={tab?.viewMode ?? defaultViewMode}
                  theme={theme}
                  isDirty={tab?.isDirty ?? false}
                  onContentChange={(content) => handleContentChange(tab?.path ?? '', content)}
                  onSaveNow={() => saveNote(false, tab?.path)}
                  onBlurSave={() => saveNote(false, tab?.path)}
                  onNavigateRelative={handleSelectNote}
                  onCreateNote={handleCreateBrokenNote}
                  onOpenExternal={handleOpenExternal}
                  onCloseNote={() => void handleCloseNote(tab?.id)}
                  showConflictBanner={tab?.showConflictBanner ?? false}
                  onKeepVersion={() => {
                    // Force overwrite on disk
                    saveNote(true, tab?.path);
                  }}
                  onLoadFromDisk={async () => {
                    if (tab) await loadNote(tab.path);
                  }}
                  onShowDifferences={() => {
                    handleFocusPane(pane.id);
                    setDiffViewerOpen(true);
                  }}
                  onBack={() => void handleBack(tab?.id)}
                  onForward={() => void handleForward(tab?.id)}
                  onHeadingInView={isActivePane ? (anchor) => setActiveHeadingAnchor(anchor) : undefined}
                  scrollToAnchor={isActivePane ? scrollToAnchor : null}
                  scrollToLine={isActivePane ? scrollToLine : null}
                  treeData={treeData}
                  indexedNotes={indexedNotes}
                  savedScrollTop={view?.scrollTop ?? tab?.scrollTop}
                  savedCursorPos={view?.cursorPos ?? tab?.cursorPos}
                  onScrollOrCursorChange={(scrollTop, cursorPos, cursorLine, cursorCol, selectionLength) => {
                    if (!tab) return;
                    tabViewRef.current.set(tab.id, { scrollTop, cursorPos });
                    if (isActivePane) {
                      setCursorPosition({ line: cursorLine, col: cursorCol, selectionLength });
                    }
                  }}
                />
              </div>
            );
          })}
        </div>

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
        onClose={() => {
          setPaletteOpen(false);
          setPaletteNewTab(false);
        }}
        notes={noteState}
        newTabByDefault={paletteNewTab}
        indexedNotes={indexedNotes}
        onSelectNote={handleSelectNote}
        initialMode={paletteMode}
        recentNotes={recentNotes}
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
        onKeepVersion={() => saveNote(true, currentNotePath)}
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

      {/* New Note modal (M10.27 Journey B) */}
      <NewNoteModal
        isOpen={!!newNoteModal}
        targetFolder={newNoteModal?.targetFolder ?? ''}
        initialName={newNoteInitialName}
        defaultTemplatePath={config.templates.defaultTemplate ?? undefined}
        onCreate={handleCreateNoteFromModal}
        onCancel={() => setNewNoteModal(null)}
      />

      {/* Folder variables modal (M10.27 Journey C) */}
      <FolderVariablesModal
        isOpen={!!folderVariablesModal}
        folderPath={folderVariablesModal?.folderPath ?? ''}
        initialVariables={folderVariablesModal?.initialVariables ?? {}}
        onSave={handleSaveFolderVariables}
        onCancel={() => setFolderVariablesModal(null)}
      />

      {/* Toast Notification Container with Undo */}
      <Toast toasts={toasts} onDismiss={dismissToast} />
    </div>
      )}
    </>
  );
};

