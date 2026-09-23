import React, { useState, useEffect, useCallback, useRef } from 'react';
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
import {
  FIXTURE_NOTES,
  FIXTURE_WORKSPACE_NAME,
  FIXTURE_ROOT_PATH,
} from './fixtures/workspace';
import { commandRegistry } from './commands/registry';
import {
  Fingerprint,
  IndexProgressEvent,
  LinkItem,
  NoteContent,
  NoteFixture,
  NoteMeta,
  TreeNodeItem,
  WorkspaceInfo,
  WorkspaceStats,
} from './types';
import { api, isTauriEnvironment } from './services/ipc';
import { renderMarkdownToHtml } from './services/markdown';

interface HistoryEntry {
  path: string;
  scrollTop?: number;
  cursorPos?: number;
}

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

  // Indexing and Stats state (SPEC §6.1, §6.2, M7)
  const [workspaceStats, setWorkspaceStats] = useState<WorkspaceStats>({
    note_count: Object.keys(FIXTURE_NOTES).length,
    link_count: 12,
    unresolved_count: 1,
  });
  const [indexingProgress, setIndexingProgress] = useState<IndexProgressEvent | null>(null);
  const [isWatcherDegraded, setIsWatcherDegraded] = useState(false);
  const [indexedNotes, setIndexedNotes] = useState<NoteMeta[]>([]);
  const [unresolvedLinks, setUnresolvedLinks] = useState<LinkItem[]>([]);
  const [unresolvedModalOpen, setUnresolvedModalOpen] = useState(false);

  // Active note path & selected folder state
  const [currentNotePath, setCurrentNotePath] = useState<string>('');
  const [selectedFolderPath, setSelectedFolderPath] = useState<string>('');
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

  // Navigation history with scroll and cursor restoration (SPEC §6.3, M6)
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const [activeScrollTop, setActiveScrollTop] = useState<number | undefined>(undefined);
  const [activeCursorPos, setActiveCursorPos] = useState<number | undefined>(undefined);

  // Inline tree action state (create-note, create-folder, rename)
  const [inlineAction, setInlineAction] = useState<InlineActionState | null>(null);

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
    [currentNotePath, refreshStats]
  );

  // Load workspace, tree, and listen to index events on mount (SPEC §6.2, §11, M7)
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
        await refreshStats();
      } catch (err: any) {
        if (mounted) {
          setTreeError(err?.message || String(err));
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
    };
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

        const stem = targetPath.split('/').pop()?.replace(/\.md$/, '') || 'Untitled';
        const templateContent = `# ${stem}\n\n`;

        await api.noteCreate(targetPath, templateContent);
        await refreshTree();
        await refreshStats();
        showToast(`Created note "${targetPath}"`);
        await handleSelectNote(targetPath);
      } catch (err: any) {
        showToast(`Failed to create note: ${err?.message || String(err)}`);
      }
    },
    [handleSelectNote, refreshStats, refreshTree, showToast]
  );

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

  // History back / forward with cursor and scroll restoration
  const handleBack = useCallback(async () => {
    if (historyIndex > 0) {
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
        const stem = noteFileName.replace(/\.md$/, '');
        const template = `# ${stem}\n\n`;

        await api.noteCreate(relativePath, template);
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
  }, [currentNotePath, handleSelectNote, inlineAction, loadNote, refreshStats, refreshTree, showToast]);

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
    if (isDirty) {
      await saveNote(false);
    }
    setCurrentNotePath('');
  }, [isDirty, saveNote]);

  // Register commands in registry per SPEC §9.3 & M4
  useEffect(() => {
    commandRegistry.register({
      id: 'file.new_note',
      title: 'New note',
      shortcut: '⌘N',
      shortcutDisplay: '⌘N',
      handler: () => handleStartCreateNote(),
    });

    commandRegistry.register({
      id: 'file.new_folder',
      title: 'New folder',
      shortcut: '⌘⇧N',
      shortcutDisplay: '⌘⇧N',
      handler: () => handleStartCreateFolder(),
    });

    commandRegistry.register({
      id: 'file.close',
      title: 'Close active note',
      shortcut: '⌘W',
      shortcutDisplay: '⌘W',
      handler: () => handleCloseNote(),
    });

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
  }, [cycleViewMode, handleCloseNote, handleStartCreateFolder, handleStartCreateNote, saveNote]);

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
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [cycleViewMode, handleBack, handleCloseNote, handleForward, handleStartCreateFolder, handleStartCreateNote, saveNote]);

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
        leftSidebarVisible={leftSidebarVisible}
        onToggleLeftSidebar={() => setLeftSidebarVisible((prev) => !prev)}
        rightSidebarVisible={rightSidebarVisible}
        onToggleRightSidebar={() => setRightSidebarVisible((prev) => !prev)}
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
            onSelectHeading={(anchor) => {
              setActiveHeadingAnchor(anchor);
              setScrollToAnchor(anchor);
              // Clear scrollToAnchor after scrolling
              setTimeout(() => setScrollToAnchor(null), 300);
            }}
            onClose={() => setLeftSidebarVisible(false)}
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
          onScrollOrCursorChange={(scrollTop, cursorPos) => {
            currentScrollTopRef.current = scrollTop;
            currentCursorPosRef.current = cursorPos;
          }}
        />

        {rightSidebarVisible && (
          <RightSidebar
            note={currentNote}
            onNavigate={handleSelectNote}
            onCreateNote={handleCreateBrokenNote}
            onOpenExternal={handleOpenExternal}
            onClose={() => setRightSidebarVisible(false)}
          />
        )}
      </div>

      {/* Status bar (SPEC §6.1, §6.2, §9.1, M7, M8) */}
      <StatusBar
        workspaceName={workspaceInfo.name}
        noteCount={workspaceStats.note_count}
        linkCount={workspaceStats.link_count}
        unresolvedCount={workspaceStats.unresolved_count}
        indexingProgress={indexingProgress}
        isWatcherDegraded={isWatcherDegraded}
        onClickUnresolved={() => setUnresolvedModalOpen(true)}
        cursorLine={1}
        cursorCol={1}
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
  );
};

