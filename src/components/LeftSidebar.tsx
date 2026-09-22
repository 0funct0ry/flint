import React, { useState, useRef, useEffect } from 'react';
import { TreeNodeItem, HeadingItem } from '../types';
import { FIXTURE_NOTES } from '../fixtures/workspace';
import { ContextMenu, ContextMenuItem } from './ContextMenu';

export type LeftTab = 'tree' | 'search' | 'outline';

export interface InlineActionState {
  type: 'create-note' | 'create-folder' | 'rename';
  targetPath: string; // parent folder path for creation, or item path for rename
  initialValue: string;
  isFolder?: boolean;
}

export interface LeftSidebarProps {
  activeTab: LeftTab;
  onTabChange: (tab: LeftTab) => void;
  treeData: TreeNodeItem[];
  currentNotePath: string;
  onSelectNote: (path: string) => void;
  headings: HeadingItem[];
  isEmpty?: boolean;
  error?: string | null;
  selectedFolderPath?: string;
  onSelectFolder?: (path: string) => void;
  onCreateNote: (parentFolder?: string) => void;
  onCreateFolder: (parentFolder?: string) => void;
  onRenameItem: (itemPath: string, currentName: string) => void;
  onDuplicateNote: (itemPath: string) => Promise<void>;
  onDeleteItem: (itemPath: string, isFolder: boolean, permanent: boolean) => Promise<void>;
  onMoveItem: (fromPath: string, toParentFolder: string) => Promise<void>;
  onRevealInFileManager: (itemPath: string) => Promise<void>;
  onCopyRelativePath: (itemPath: string) => void;
  inlineAction: InlineActionState | null;
  onCommitInlineAction: (name: string) => Promise<void>;
  onCancelInlineAction: () => void;
  activeHeadingAnchor?: string;
  onSelectHeading?: (anchor: string) => void;
}

export const LeftSidebar: React.FC<LeftSidebarProps> = ({
  activeTab,
  onTabChange,
  treeData,
  currentNotePath,
  onSelectNote,
  headings,
  isEmpty = false,
  error = null,
  selectedFolderPath = '',
  onSelectFolder,
  onCreateNote,
  onCreateFolder,
  onRenameItem,
  onDuplicateNote,
  onDeleteItem,
  onMoveItem,
  onRevealInFileManager,
  onCopyRelativePath,
  inlineAction,
  onCommitInlineAction,
  onCancelInlineAction,
  activeHeadingAnchor,
  onSelectHeading,
}) => {
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(
    new Set(['projects', 'projects/payments', 'archive', 'reading', 'guides'])
  );

  // Context menu state
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    item: TreeNodeItem | null;
  } | null>(null);

  // Drag and drop state
  const [draggedItem, setDraggedItem] = useState<TreeNodeItem | null>(null);
  const [dragOverTarget, setDragOverTarget] = useState<string | null>(null);

  // Inline input state
  const [inlineValue, setInlineValue] = useState('');
  const [validationError, setValidationError] = useState<string | null>(null);
  const inlineInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (inlineAction) {
      setInlineValue(inlineAction.initialValue);
      setValidationError(null);
      setTimeout(() => {
        if (inlineInputRef.current) {
          inlineInputRef.current.focus();
          if (inlineAction.type === 'rename' && !inlineAction.isFolder) {
            // Select only the file stem, not extension
            const stem = inlineAction.initialValue.replace(/\.md$/, '');
            inlineInputRef.current.setSelectionRange(0, stem.length);
          } else {
            inlineInputRef.current.select();
          }
        }
      }, 30);
    }
  }, [inlineAction]);

  // Search panel state
  const [searchQuery, setSearchQuery] = useState('settlement window');
  const [caseSensitive, setCaseSensitive] = useState(true);
  const [wholeWord, setWholeWord] = useState(false);
  const [isRegex, setIsRegex] = useState(false);
  const [folderScope, setFolderScope] = useState(false);

  const toggleFolder = (path: string) => {
    setExpandedFolders((prev) => {
      const next = new Set(prev);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  };

  // Live inline validation
  const validateName = (name: string, targetPath: string, type: 'create-note' | 'create-folder' | 'rename'): string | null => {
    const trimmed = name.trim();
    if (!trimmed) {
      return 'Name cannot be empty';
    }
    if (trimmed.includes('/') || trimmed.includes('\\')) {
      return 'Name cannot contain path separators (/ or \\)';
    }
    if (trimmed.includes('\0')) {
      return 'Name cannot contain null bytes';
    }

    const reserved = ['CON', 'PRN', 'AUX', 'NUL', 'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7', 'COM8', 'COM9', 'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9'];
    const stem = trimmed.split('.')[0].toUpperCase();
    if (reserved.includes(stem)) {
      return `"${stem}" is a reserved system name`;
    }

    // Check sibling collisions
    // Helper to find siblings
    const findSiblings = (items: TreeNodeItem[], parentPath: string): string[] => {
      if (!parentPath) {
        return items.map((i) => i.name.toLowerCase());
      }
      for (const item of items) {
        if (item.path === parentPath && item.is_folder && item.children) {
          return item.children.map((c) => c.name.toLowerCase());
        }
        if (item.children) {
          const found = findSiblings(item.children, parentPath);
          if (found.length > 0) return found;
        }
      }
      return [];
    };

    let parentDir = '';
    if (type === 'create-note' || type === 'create-folder') {
      parentDir = targetPath;
    } else {
      parentDir = targetPath.split('/').slice(0, -1).join('/');
    }

    const siblings = findSiblings(treeData, parentDir);
    const candidateFullName = (type === 'create-note' && !trimmed.endsWith('.md')) ? `${trimmed}.md` : trimmed;
    
    if (type === 'rename' && candidateFullName.toLowerCase() === inlineAction?.initialValue.toLowerCase()) {
      return null; // Same name unchanged is valid
    }

    if (siblings.includes(candidateFullName.toLowerCase())) {
      return 'An item with this name already exists in this folder';
    }

    return null;
  };

  const handleInlineChange = (val: string) => {
    setInlineValue(val);
    if (inlineAction) {
      const err = validateName(val, inlineAction.targetPath, inlineAction.type);
      setValidationError(err);
    }
  };

  const handleInlineSubmit = () => {
    if (!inlineAction) return;
    const err = validateName(inlineValue, inlineAction.targetPath, inlineAction.type);
    if (err) {
      setValidationError(err);
      return;
    }
    onCommitInlineAction(inlineValue.trim());
  };

  // Context menu builder
  const handleContextMenu = (e: React.MouseEvent, item: TreeNodeItem | null) => {
    e.preventDefault();
    e.stopPropagation();
    setContextMenu({
      x: e.clientX,
      y: e.clientY,
      item,
    });
  };

  const getContextMenuItems = (): ContextMenuItem[] => {
    const item = contextMenu?.item;

    if (!item) {
      // Background / Root context menu
      return [
        {
          id: 'new-note',
          label: 'New Note',
          shortcut: '⌘N',
          onClick: () => onCreateNote(''),
        },
        {
          id: 'new-folder',
          label: 'New Folder',
          shortcut: '⌘⇧N',
          onClick: () => onCreateFolder(''),
        },
      ];
    }

    const isFolder = item.is_folder;
    const parentFolder = isFolder ? item.path : item.path.split('/').slice(0, -1).join('/');

    return [
      {
        id: 'new-note',
        label: 'New Note',
        shortcut: '⌘N',
        onClick: () => onCreateNote(parentFolder),
      },
      {
        id: 'new-folder',
        label: 'New Folder',
        shortcut: '⌘⇧N',
        onClick: () => onCreateFolder(parentFolder),
      },
      { id: 'sep1', label: '', separator: true, onClick: () => {} },
      {
        id: 'rename',
        label: 'Rename',
        shortcut: 'F2',
        onClick: () => onRenameItem(item.path, item.name),
      },
      ...(!isFolder
        ? [
            {
              id: 'duplicate',
              label: 'Duplicate',
              shortcut: '⌘D',
              onClick: () => onDuplicateNote(item.path),
            },
          ]
        : []),
      { id: 'sep2', label: '', separator: true, onClick: () => {} },
      {
        id: 'copy-path',
        label: 'Copy Relative Path',
        onClick: () => onCopyRelativePath(item.path),
      },
      {
        id: 'reveal',
        label: 'Reveal in File Manager',
        onClick: () => onRevealInFileManager(item.path),
      },
      { id: 'sep3', label: '', separator: true, onClick: () => {} },
      {
        id: 'delete-trash',
        label: 'Move to Trash',
        shortcut: '⌫',
        danger: true,
        onClick: () => onDeleteItem(item.path, isFolder, false),
      },
      {
        id: 'delete-permanent',
        label: 'Delete Permanently...',
        danger: true,
        onClick: () => onDeleteItem(item.path, isFolder, true),
      },
    ];
  };

  // Drag and drop handlers
  const handleDragStart = (e: React.DragEvent, item: TreeNodeItem) => {
    e.stopPropagation();
    setDraggedItem(item);
    e.dataTransfer.setData('text/plain', item.path);
    e.dataTransfer.effectAllowed = 'move';
  };

  const handleDragOver = (e: React.DragEvent, targetItem: TreeNodeItem | null) => {
    e.preventDefault();
    e.stopPropagation();
    if (!draggedItem) return;

    if (targetItem) {
      if (targetItem.path === draggedItem.path) {
        setDragOverTarget(null);
        return;
      }
      // If target is folder, highlight folder
      if (targetItem.is_folder) {
        setDragOverTarget(targetItem.path);
      } else {
        // Target is a file -> drop into target file's parent folder
        const parent = targetItem.path.split('/').slice(0, -1).join('/');
        setDragOverTarget(parent);
      }
    } else {
      // Dropping into root
      setDragOverTarget('');
    }
  };

  const handleDrop = async (e: React.DragEvent, targetFolder: string) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOverTarget(null);
    if (!draggedItem) return;

    // Check if moving to same parent
    const currentParent = draggedItem.path.split('/').slice(0, -1).join('/');
    if (currentParent === targetFolder) {
      setDraggedItem(null);
      return;
    }

    // Prevent dropping a folder into itself or its own subfolder
    if (draggedItem.is_folder && (targetFolder === draggedItem.path || targetFolder.startsWith(`${draggedItem.path}/`))) {
      setDraggedItem(null);
      return;
    }

    await onMoveItem(draggedItem.path, targetFolder);
    setDraggedItem(null);
  };

  // Compute search hits across fixture notes
  const searchHits = React.useMemo(() => {
    if (!searchQuery.trim()) return [];
    const results: Array<{
      notePath: string;
      matches: Array<{ line: number; text: string; matchSpan: [number, number] }>;
    }> = [];

    Object.values(FIXTURE_NOTES).forEach((note) => {
      const lines = note.content.split('\n');
      const noteMatches: Array<{ line: number; text: string; matchSpan: [number, number] }> = [];

      lines.forEach((line, idx) => {
        let matchIdx = -1;
        if (caseSensitive) {
          matchIdx = line.indexOf(searchQuery);
        } else {
          matchIdx = line.toLowerCase().indexOf(searchQuery.toLowerCase());
        }

        if (matchIdx !== -1) {
          noteMatches.push({
            line: idx + 1,
            text: line,
            matchSpan: [matchIdx, matchIdx + searchQuery.length],
          });
        }
      });

      if (noteMatches.length > 0) {
        results.push({
          notePath: note.path,
          matches: noteMatches,
        });
      }
    });

    return results;
  }, [searchQuery, caseSensitive]);

  // Render recursive tree rows
  const renderTree = (items: TreeNodeItem[], depth = 0, currentParent = '') => {
    const isCreatingInThisFolder =
      inlineAction &&
      (inlineAction.type === 'create-note' || inlineAction.type === 'create-folder') &&
      inlineAction.targetPath === currentParent;

    return (
      <>
        {/* Inline Create Input for current folder context */}
        {isCreatingInThisFolder && (
          <div
            style={{ paddingLeft: `${depth * 14 + 10}px` }}
            className="flex flex-col my-0.5 mx-1 relative z-20"
          >
            <div className="flex items-center gap-2 h-[26px] pr-2 bg-[var(--panel-2)] rounded-[4px] border border-[var(--accent)]">
              <span className="w-4 h-4 flex items-center justify-center shrink-0">
                {inlineAction.type === 'create-folder' ? (
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="opacity-80">
                    <path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.93a2 2 0 0 1-1.66-.9l-.82-1.2A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z" />
                  </svg>
                ) : (
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="opacity-85">
                    <path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H20v20H6.5a2.5 2.5 0 0 1-2.5-2.5Z" />
                  </svg>
                )}
              </span>
              <input
                ref={inlineInputRef}
                type="text"
                value={inlineValue}
                onChange={(e) => handleInlineChange(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    handleInlineSubmit();
                  } else if (e.key === 'Escape') {
                    onCancelInlineAction();
                  }
                }}
                onBlur={handleInlineSubmit}
                placeholder={inlineAction.type === 'create-folder' ? 'folder-name' : 'note-name'}
                className="w-full bg-transparent text-[13px] text-[var(--text)] focus:outline-none"
              />
            </div>
            {validationError && (
              <div className="mt-1 px-2 py-1 bg-[#e06c75]/15 border border-[#e06c75]/40 rounded text-[11px] text-[#e06c75] font-medium leading-tight shadow-sm animate-in fade-in duration-100">
                {validationError}
              </div>
            )}
          </div>
        )}

        {items.map((item) => {
          const isExpanded = expandedFolders.has(item.path);
          const isSelected = currentNotePath === item.path || (item.is_folder && selectedFolderPath === item.path);
          const isFolder = item.is_folder;
          const isNote = Boolean(item.is_note);
          const isRenaming = inlineAction?.type === 'rename' && inlineAction.targetPath === item.path;
          const isDropTarget = dragOverTarget === item.path;

          const isGitIgnore = item.name === '.gitignore';
          const isMarkdownDoc = item.name.endsWith('.md');
          const isSpecialFolder = item.name === 'crates' || item.name === 'src';
          const isGreenFolder = item.name === '.flint';

          return (
            <React.Fragment key={item.id}>
              {isRenaming ? (
                <div
                  style={{ paddingLeft: `${depth * 14 + 10}px` }}
                  className="flex flex-col my-0.5 mx-1 relative z-20"
                >
                  <div className="flex items-center gap-2 h-[26px] pr-2 bg-[var(--panel-2)] rounded-[4px] border border-[var(--accent)]">
                    <span className="w-4 h-4 flex items-center justify-center shrink-0">
                      {isFolder ? (
                        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="opacity-80">
                          <path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.93a2 2 0 0 1-1.66-.9l-.82-1.2A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z" />
                        </svg>
                      ) : (
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="opacity-85">
                          <path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H20v20H6.5a2.5 2.5 0 0 1-2.5-2.5Z" />
                        </svg>
                      )}
                    </span>
                    <input
                      ref={inlineInputRef}
                      type="text"
                      value={inlineValue}
                      onChange={(e) => handleInlineChange(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          handleInlineSubmit();
                        } else if (e.key === 'Escape') {
                          onCancelInlineAction();
                        }
                      }}
                      onBlur={handleInlineSubmit}
                      className="w-full bg-transparent text-[13px] text-[var(--text)] focus:outline-none"
                    />
                  </div>
                  {validationError && (
                    <div className="mt-1 px-2 py-1 bg-[#e06c75]/15 border border-[#e06c75]/40 rounded text-[11px] text-[#e06c75] font-medium leading-tight shadow-sm animate-in fade-in duration-100">
                      {validationError}
                    </div>
                  )}
                </div>
              ) : (
                <div
                  role="treeitem"
                  aria-selected={isSelected}
                  aria-expanded={isFolder ? isExpanded : undefined}
                  draggable
                  onDragStart={(e) => handleDragStart(e, item)}
                  onDragOver={(e) => handleDragOver(e, item)}
                  onDrop={(e) => handleDrop(e, isFolder ? item.path : currentParent)}
                  onContextMenu={(e) => handleContextMenu(e, item)}
                  onClick={() => {
                    if (isFolder) {
                      toggleFolder(item.path);
                      onSelectFolder?.(item.path);
                    } else if (isNote) {
                      onSelectNote(item.path);
                      onSelectFolder?.(item.path.split('/').slice(0, -1).join('/'));
                    }
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'F2') {
                      e.preventDefault();
                      onRenameItem(item.path, item.name);
                    } else if (e.key === 'Delete' || e.key === 'Backspace') {
                      e.preventDefault();
                      onDeleteItem(item.path, isFolder, e.shiftKey || e.altKey);
                    }
                  }}
                  tabIndex={0}
                  style={{ paddingLeft: `${depth * 14 + 10}px` }}
                  className={`group flex items-center gap-2 h-[26px] pr-2 text-[var(--text-2)] cursor-pointer whitespace-nowrap select-none rounded-[4px] mx-1 hover:bg-[var(--panel-2)] transition-colors focus:outline-none focus-visible:ring-1 focus-visible:ring-[var(--accent)] ${
                    isSelected ? 'bg-[#2b3040] text-[#ffffff] font-medium' : ''
                  } ${isDropTarget ? 'ring-2 ring-[var(--accent)] bg-[var(--accent-soft)]' : ''} ${
                    !isNote && !isFolder ? 'text-[var(--text-2)] opacity-80' : ''
                  }`}
                >
                  {/* Folder / File Icon */}
                  <span className="w-4 h-4 flex items-center justify-center shrink-0">
                    {isFolder ? (
                      <svg
                        width="15"
                        height="15"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke={isExpanded ? 'var(--text)' : 'currentColor'}
                        strokeWidth="1.8"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        className="opacity-80 group-hover:opacity-100"
                      >
                        <path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.93a2 2 0 0 1-1.66-.9l-.82-1.2A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z" />
                      </svg>
                    ) : isGitIgnore ? (
                      <svg
                        width="14"
                        height="14"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.8"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        className="opacity-85"
                      >
                        <line x1="6" y1="3" x2="6" y2="15" />
                        <circle cx="18" cy="6" r="3" />
                        <circle cx="6" cy="18" r="3" />
                        <path d="M18 9a9 9 0 0 1-9 9" />
                      </svg>
                    ) : isMarkdownDoc ? (
                      <svg
                        width="14"
                        height="14"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.8"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        className="opacity-85"
                      >
                        <path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H20v20H6.5a2.5 2.5 0 0 1-2.5-2.5Z" />
                        <path d="M6 6h10" />
                        <path d="M6 10h10" />
                      </svg>
                    ) : (
                      <svg
                        width="14"
                        height="14"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.8"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        className="opacity-60"
                      >
                        <path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z" />
                        <polyline points="14 2 14 8 20 8" />
                      </svg>
                    )}
                  </span>

                  {/* Name */}
                  <span
                    className={`truncate text-[13px] leading-none ${
                      isSpecialFolder
                        ? 'text-[#f6c177]'
                        : isGreenFolder
                        ? 'text-[#a6da95]'
                        : isSelected
                        ? 'text-white'
                        : 'text-[var(--text-2)] group-hover:text-[var(--text)]'
                    }`}
                  >
                    {item.name}
                  </span>
                </div>
              )}

              {isFolder && isExpanded && item.children && renderTree(item.children, depth + 1, item.path)}
            </React.Fragment>
          );
        })}
      </>
    );
  };

  return (
    <aside className="w-[236px] shrink-0 flex flex-col bg-[var(--panel)] border-r border-[var(--border)] min-h-0 select-none">
      {/* Tabs */}
      <div className="flex h-[31px] shrink-0 border-b border-[var(--border)]" role="tablist">
        <button
          role="tab"
          aria-selected={activeTab === 'tree'}
          onClick={() => onTabChange('tree')}
          className={`px-3 text-[11.5px] tracking-wide transition-colors ${
            activeTab === 'tree'
              ? 'text-[var(--text)] font-medium shadow-[inset_0_-2px_0_var(--accent)]'
              : 'text-[var(--muted)] hover:text-[var(--text)]'
          }`}
        >
          Workspace
        </button>
        <button
          role="tab"
          aria-selected={activeTab === 'search'}
          onClick={() => onTabChange('search')}
          className={`px-3 text-[11.5px] tracking-wide transition-colors ${
            activeTab === 'search'
              ? 'text-[var(--text)] font-medium shadow-[inset_0_-2px_0_var(--accent)]'
              : 'text-[var(--muted)] hover:text-[var(--text)]'
          }`}
        >
          Search
        </button>
        <button
          role="tab"
          aria-selected={activeTab === 'outline'}
          onClick={() => onTabChange('outline')}
          className={`px-3 text-[11.5px] tracking-wide transition-colors ${
            activeTab === 'outline'
              ? 'text-[var(--text)] font-medium shadow-[inset_0_-2px_0_var(--accent)]'
              : 'text-[var(--muted)] hover:text-[var(--text)]'
          }`}
        >
          Outline
        </button>
      </div>

      {/* Pane Content */}
      <div className="flex-1 overflow-auto py-1.5 min-h-0">
        {/* WORKSPACE TREE TAB */}
        {activeTab === 'tree' && (
          <div
            role="tree"
            aria-label="Workspace file tree"
            tabIndex={0}
            onContextMenu={(e) => handleContextMenu(e, null)}
            onDragOver={(e) => handleDragOver(e, null)}
            onDrop={(e) => handleDrop(e, '')}
            className={`focus:outline-none h-full ${dragOverTarget === '' ? 'bg-[var(--accent-soft)]/20' : ''}`}
          >
            {error ? (
              <div className="p-4 text-center">
                <div className="text-xs text-[var(--spark)] mb-2 font-medium">
                  {error}
                </div>
                <div className="text-[11px] text-[var(--muted)]">
                  Check workspace path and folder permissions.
                </div>
              </div>
            ) : isEmpty && !inlineAction ? (
              <div className="p-4 flex flex-col items-center justify-center text-center h-48">
                <div className="text-xs text-[var(--muted)] mb-3 font-medium">
                  Workspace is empty
                </div>
                <button
                  onClick={() => onCreateNote('')}
                  className="px-2.5 py-1 text-xs bg-[var(--accent)] text-white rounded-[5px] hover:opacity-90 font-medium transition-opacity"
                >
                  Create your first note
                </button>
              </div>
            ) : (
              renderTree(treeData, 0, '')
            )}
          </div>
        )}

        {/* SEARCH TAB */}
        {activeTab === 'search' && (
          <div className="flex flex-col h-full">
            <div className="p-2.5 pb-2 border-b border-[var(--border)]">
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search in workspace..."
                aria-label="Search note contents"
                className="w-full px-2 py-1 text-xs text-[var(--text)] bg-[var(--canvas)] border border-[var(--border)] rounded-[5px] focus:outline-none focus:border-[var(--accent)]"
              />
              <div className="flex gap-1.5 mt-2">
                <button
                  aria-pressed={caseSensitive}
                  onClick={() => setCaseSensitive(!caseSensitive)}
                  title="Match Case"
                  className={`font-mono text-[11px] px-1.5 py-0.5 border rounded ${
                    caseSensitive
                      ? 'border-[var(--accent)] text-[var(--accent)] bg-[var(--accent-soft)]'
                      : 'border-[var(--border)] text-[var(--muted)] hover:text-[var(--text)]'
                  }`}
                >
                  Aa
                </button>
                <button
                  aria-pressed={wholeWord}
                  onClick={() => setWholeWord(!wholeWord)}
                  title="Match Whole Word"
                  className={`font-mono text-[11px] px-1.5 py-0.5 border rounded ${
                    wholeWord
                      ? 'border-[var(--accent)] text-[var(--accent)] bg-[var(--accent-soft)]'
                      : 'border-[var(--border)] text-[var(--muted)] hover:text-[var(--text)]'
                  }`}
                >
                  ab
                </button>
                <button
                  aria-pressed={isRegex}
                  onClick={() => setIsRegex(!isRegex)}
                  title="Use Regular Expression"
                  className={`font-mono text-[11px] px-1.5 py-0.5 border rounded ${
                    isRegex
                      ? 'border-[var(--accent)] text-[var(--accent)] bg-[var(--accent-soft)]'
                      : 'border-[var(--border)] text-[var(--muted)] hover:text-[var(--text)]'
                  }`}
                >
                  .*
                </button>
                <button
                  aria-pressed={folderScope}
                  onClick={() => setFolderScope(!folderScope)}
                  title="Scope to active folder"
                  className={`font-mono text-[11px] px-1.5 py-0.5 border rounded ${
                    folderScope
                      ? 'border-[var(--accent)] text-[var(--accent)] bg-[var(--accent-soft)]'
                      : 'border-[var(--border)] text-[var(--muted)] hover:text-[var(--text)]'
                  }`}
                >
                  ▤
                </button>
              </div>
            </div>

            <div className="flex-1 overflow-auto p-1">
              {searchHits.length === 0 ? (
                <div className="p-4 text-center text-xs text-[var(--faint)]">
                  No matching results found.
                </div>
              ) : (
                searchHits.map((group) => (
                  <div key={group.notePath} className="mb-2">
                    <div className="px-2.5 py-1 text-[11.5px] font-medium text-[var(--muted)] truncate">
                      {group.notePath} · {group.matches.length}
                    </div>
                    {group.matches.map((hit, idx) => (
                      <div
                        key={idx}
                        onClick={() => onSelectNote(group.notePath)}
                        className="flex gap-2 px-2.5 py-1 text-[11.5px] font-mono text-[var(--text-2)] hover:bg-[var(--panel-2)] cursor-pointer truncate rounded"
                      >
                        <span className="text-[var(--faint)] min-w-[20px] text-right shrink-0">
                          {hit.line}
                        </span>
                        <span className="truncate">
                          {hit.text.slice(0, hit.matchSpan[0])}
                          <mark className="bg-[rgba(201,138,46,0.28)] text-inherit rounded-sm px-0.5">
                            {hit.text.slice(hit.matchSpan[0], hit.matchSpan[1])}
                          </mark>
                          {hit.text.slice(hit.matchSpan[1])}
                        </span>
                      </div>
                    ))}
                  </div>
                ))
              )}
            </div>
          </div>
        )}

        {/* OUTLINE TAB */}
        {activeTab === 'outline' && (
          <div className="flex flex-col">
            <div className="px-3 py-1.5 text-[11px] font-medium text-[var(--faint)] truncate">
              {currentNotePath.split('/').pop()}
            </div>
            {headings.length === 0 ? (
              <div className="p-4 text-center text-xs text-[var(--faint)]">
                No headings in this note.
              </div>
            ) : (
              headings.map((h, i) => {
                const indentClass =
                  h.level === 1 ? 'pl-2.5' : h.level === 2 ? 'pl-6' : 'pl-9';
                const isActive = activeHeadingAnchor === h.anchor;
                return (
                  <div
                    key={i}
                    onClick={() => onSelectHeading && onSelectHeading(h.anchor)}
                    className={`flex items-center gap-1.5 h-6 pr-2 text-[12px] cursor-pointer select-none transition-colors ${indentClass} ${
                      isActive
                        ? 'bg-[var(--accent-soft)] text-[var(--accent)] font-medium'
                        : 'text-[var(--text-2)] hover:bg-[var(--panel-2)] hover:text-[var(--text)]'
                    }`}
                    title={h.text}
                  >
                    <span className={`text-xs ${isActive ? 'text-[var(--accent)]' : 'text-[var(--faint)]'}`}>§</span>
                    <span className="truncate">{h.text}</span>
                  </div>
                );
              })
            )}
          </div>
        )}
      </div>

      {/* Context Menu floating overlay */}
      {contextMenu && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          items={getContextMenuItems()}
          onClose={() => setContextMenu(null)}
        />
      )}
    </aside>
  );
};
