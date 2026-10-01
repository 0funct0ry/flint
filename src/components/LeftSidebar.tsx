import React, { useState, useRef, useEffect, useMemo } from 'react';
import { TreeNodeItem, HeadingItem, ContentHitGroup, NoteMeta, TagCount } from '../types';
import { api } from '../services/ipc';
import { slugify } from '../services/markdown';
import {
  buildOutlineTree,
  OutlineNode,
  parseHeadingsFromContent,
  reorderSiblingsChange,
  removeSectionChange,
  sectionText,
  siblingGroup,
  swapWithAdjacentSibling,
} from '../services/outline';
import { ContextMenu, ContextMenuItem } from './ContextMenu';
import { DeleteConfirmModal } from './DeleteConfirmModal';
import { applyOutlineEdit } from '../services/outlineEditBridge';

const CONFIRM_MOVE_TO_NEW_NOTE_KEY = 'outline.confirmMoveToNewNote';

/** Prune a workspace tree to notes in `matching`, keeping ancestor folders with a matching
 * descendant and dropping non-matching siblings (M10.25 tag click-to-filter). */
function filterTreeByTag(nodes: TreeNodeItem[], matching: Set<string>): TreeNodeItem[] {
  const result: TreeNodeItem[] = [];
  for (const node of nodes) {
    if (node.is_folder) {
      const children = node.children ? filterTreeByTag(node.children, matching) : [];
      if (children.length > 0) {
        result.push({ ...node, children });
      }
    } else if (matching.has(node.path)) {
      result.push(node);
    }
  }
  return result;
}

export type LeftTab = 'tree' | 'search' | 'outline' | 'tags';

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
  onSelectNote: (path: string, targetLineOrOpts?: number | { newTab?: boolean }) => void;
  isEmpty?: boolean;
  error?: string | null;
  selectedFolderPath?: string;
  onSelectFolder?: (path: string) => void;
  onCreateNote: (parentFolder?: string) => void;
  /** "New Note from Template…" — opens the template-picker/variable-form modal, as opposed to
   * `onCreateNote`'s fast inline-rename flow for a blank/default-template note. */
  onCreateNoteFromTemplate?: (parentFolder?: string) => void;
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
  onSelectHeading?: (heading: HeadingItem) => void;
  onClose?: () => void;
  /** Raw Markdown of the currently open note, used for outline copy/reorder/extract/delete (M10.09). */
  noteContent?: string;
  /** Fired after "Move to new note" successfully creates the new note, so the host can toast/refresh. */
  onSectionMovedToNewNote?: (newNotePath: string) => void;
  /** Fired if "Move to new note" fails (e.g. destination already exists). */
  onSectionMoveFailed?: (message: string) => void;
  /** Full workspace note index (path + tags), used to filter the tree by `activeTagFilter` (M10.25). */
  indexedNotes?: NoteMeta[];
  /** Every workspace tag with its total note count, sorted count desc then alpha (M10.25). */
  tagCounts?: TagCount[];
  /** The tag currently filtering the tree view, if any (M10.25). */
  activeTagFilter?: string | null;
  onFilterByTag?: (tag: string) => void;
  onClearTagFilter?: () => void;
  onTagRename?: (oldTag: string, newTag: string) => void;
  /** "New Template…" (M10.27 Journey A) — from the workspace root or any folder in the tree. */
  onCreateTemplate?: (parentFolder?: string) => void;
  /** "Edit template variables…" (M10.27 Journey A) — only offered for files under
   * `.flint/templates/`. */
  onEditTemplateVariables?: (templatePath: string) => void;
  /** "Folder variables…" (M10.27 Journey C) — only offered for folders. */
  onEditFolderVariables?: (folderPath: string) => void;
}

export const LeftSidebar: React.FC<LeftSidebarProps> = ({
  activeTab,
  onTabChange,
  treeData,
  currentNotePath,
  onSelectNote,
  isEmpty = false,
  error = null,
  selectedFolderPath = '',
  onSelectFolder,
  onCreateNote,
  onCreateNoteFromTemplate,
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
  onClose,
  noteContent = '',
  onSectionMovedToNewNote,
  onSectionMoveFailed,
  indexedNotes = [],
  tagCounts = [],
  activeTagFilter = null,
  onFilterByTag,
  onClearTagFilter,
  onTagRename,
  onCreateTemplate,
  onEditTemplateVariables,
  onEditFolderVariables,
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
  const treeContainerRef = useRef<HTMLDivElement>(null);

  // Outline tab state (M10.09)
  const [collapsedOutlineNodes, setCollapsedOutlineNodes] = useState<Set<string>>(new Set());
  const [outlineContextMenu, setOutlineContextMenu] = useState<{ x: number; y: number; index: number } | null>(null);
  const [draggedOutlineIndex, setDraggedOutlineIndex] = useState<number | null>(null);
  const [outlineDropTarget, setOutlineDropTarget] = useState<{ groupIndices: number[]; beforePos: number } | null>(null);
  const [deleteSectionIndex, setDeleteSectionIndex] = useState<number | null>(null);
  const [extractState, setExtractState] = useState<{ index: number; value: string; error: string | null } | null>(null);
  const [confirmExtractState, setConfirmExtractState] = useState<{ index: number; destPath: string } | null>(null);
  const extractInputRef = useRef<HTMLInputElement>(null);

  // Tags tab state (M10.25)
  const [tagFilterQuery, setTagFilterQuery] = useState('');
  const [tagContextMenu, setTagContextMenu] = useState<{ x: number; y: number; tag: string } | null>(null);
  const [renamingTag, setRenamingTag] = useState<string | null>(null);
  const [renameTagValue, setRenameTagValue] = useState('');
  const renameTagInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (renamingTag !== null) {
      renameTagInputRef.current?.focus();
      renameTagInputRef.current?.select();
    }
  }, [renamingTag]);

  const filteredTagCounts = useMemo(() => {
    const q = tagFilterQuery.trim().toLowerCase();
    if (!q) return tagCounts;
    return tagCounts.filter((t) => t.tag.toLowerCase().includes(q));
  }, [tagCounts, tagFilterQuery]);

  const tagFilteredNoteSet = useMemo(() => {
    if (!activeTagFilter) return null;
    const lower = activeTagFilter.toLowerCase();
    const set = new Set<string>();
    indexedNotes.forEach((n) => {
      if ((n.tags || []).some((t) => t.toLowerCase() === lower)) {
        set.add(n.path);
      }
    });
    return set;
  }, [activeTagFilter, indexedNotes]);

  const displayedTreeData = useMemo(() => {
    if (!tagFilteredNoteSet) return treeData;
    return filterTreeByTag(treeData, tagFilteredNoteSet);
  }, [treeData, tagFilteredNoteSet]);

  const startTagRename = (tag: string) => {
    setRenamingTag(tag);
    setRenameTagValue(tag);
    setTagContextMenu(null);
  };

  const commitTagRename = () => {
    if (renamingTag !== null) {
      const trimmed = renameTagValue.trim().replace(/^#/, '');
      if (trimmed && trimmed !== renamingTag) {
        onTagRename?.(renamingTag, trimmed);
      }
    }
    setRenamingTag(null);
  };

  const buildTagMenuItems = (tag: string): ContextMenuItem[] => [
    {
      id: 'rename-tag',
      label: 'Rename tag…',
      onClick: () => startTagRename(tag),
    },
  ];

  // Keyboard tree navigation (Up/Down move focus between visible rows in document order;
  // Left/Right collapse/expand a focused folder, or hop to its parent when already collapsed).
  const getVisibleTreeItems = (): HTMLElement[] =>
    Array.from(treeContainerRef.current?.querySelectorAll('[role="treeitem"]') ?? []) as HTMLElement[];

  const focusTreeItemByPath = (path: string) => {
    if (!path) return;
    const el = treeContainerRef.current?.querySelector<HTMLElement>(`[data-path="${CSS.escape(path)}"]`);
    el?.focus();
  };

  useEffect(() => {
    if (inlineAction) {
      setInlineValue(inlineAction.initialValue);
      setValidationError(null);

      // The inline create-note/create-folder row only renders inside its parent's expanded
      // children — expand that parent now, or a create action started on a collapsed folder
      // would mount nowhere and stay invisible until the user happens to toggle it open.
      if (
        (inlineAction.type === 'create-note' || inlineAction.type === 'create-folder') &&
        inlineAction.targetPath
      ) {
        setExpandedFolders((prev) =>
          prev.has(inlineAction.targetPath) ? prev : new Set(prev).add(inlineAction.targetPath)
        );
      }

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

  // Auto-expand parent folders for current active note (M10.06)
  useEffect(() => {
    if (!currentNotePath) return;
    const parts = currentNotePath.split('/');
    if (parts.length > 1) {
      const parentPaths: string[] = [];
      let acc = '';
      for (let i = 0; i < parts.length - 1; i++) {
        acc = acc ? `${acc}/${parts[i]}` : parts[i];
        parentPaths.push(acc);
      }
      setExpandedFolders((prev) => {
        const next = new Set(prev);
        let changed = false;
        for (const p of parentPaths) {
          if (!next.has(p)) {
            next.add(p);
            changed = true;
          }
        }
        return changed ? next : prev;
      });
    }

    // Scroll selected treeitem into view if present
    const timer = setTimeout(() => {
      const selectedEl = document.querySelector('[role="treeitem"][aria-selected="true"]');
      if (selectedEl) {
        selectedEl.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      }
    }, 50);
    return () => clearTimeout(timer);
  }, [currentNotePath]);

  // Search panel state
  const [searchQuery, setSearchQuery] = useState('');
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [wholeWord, setWholeWord] = useState(false);
  const [isRegex, setIsRegex] = useState(false);
  const [folderScope, setFolderScope] = useState(false);
  const [searchHits, setSearchHits] = useState<ContentHitGroup[]>([]);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [isSearching, setIsSearching] = useState(false);

  // Debounced searchContent query (120ms debounce per PROMPTS.md / SPEC §8.2)
  useEffect(() => {
    if (!searchQuery.trim()) {
      setSearchHits([]);
      setSearchError(null);
      setIsSearching(false);
      return;
    }

    setIsSearching(true);
    const timer = setTimeout(async () => {
      try {
        const folder = folderScope ? (selectedFolderPath || currentNotePath.split('/').slice(0, -1).join('/')) : undefined;
        const results = await api.searchContent(searchQuery, {
          case_sensitive: caseSensitive,
          whole_word: wholeWord,
          is_regex: isRegex,
          folder_scope: folder || undefined,
          includes: [],
          excludes: [],
        });
        setSearchHits(results);
        setSearchError(null);
      } catch (err: any) {
        setSearchHits([]);
        setSearchError(err?.message || String(err));
      } finally {
        setIsSearching(false);
      }
    }, 120);

    return () => clearTimeout(timer);
  }, [searchQuery, caseSensitive, wholeWord, isRegex, folderScope, selectedFolderPath, currentNotePath]);

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
        ...(onCreateNoteFromTemplate
          ? [
              {
                id: 'new-note-from-template',
                label: 'New Note from Template…',
                onClick: () => onCreateNoteFromTemplate(''),
              },
            ]
          : []),
        {
          id: 'new-folder',
          label: 'New Folder',
          shortcut: '⌘⇧N',
          onClick: () => onCreateFolder(''),
        },
        ...(onCreateTemplate
          ? [
              {
                id: 'new-template',
                label: 'New Template…',
                onClick: () => onCreateTemplate(''),
              },
            ]
          : []),
      ];
    }

    const isFolder = item.is_folder;
    const parentFolder = isFolder ? item.path : item.path.split('/').slice(0, -1).join('/');
    const isTemplateFile = !isFolder && item.path.startsWith('.flint/templates/');

    return [
      {
        id: 'new-note',
        label: 'New Note',
        shortcut: '⌘N',
        onClick: () => onCreateNote(parentFolder),
      },
      ...(onCreateNoteFromTemplate
        ? [
            {
              id: 'new-note-from-template',
              label: 'New Note from Template…',
              onClick: () => onCreateNoteFromTemplate(parentFolder),
            },
          ]
        : []),
      {
        id: 'new-folder',
        label: 'New Folder',
        shortcut: '⌘⇧N',
        onClick: () => onCreateFolder(parentFolder),
      },
      ...(onCreateTemplate
        ? [
            {
              id: 'new-template',
              label: 'New Template…',
              onClick: () => onCreateTemplate(parentFolder),
            },
          ]
        : []),
      ...(isTemplateFile && onEditTemplateVariables
        ? [
            {
              id: 'edit-template-variables',
              label: 'Edit template variables…',
              onClick: () =>
                onEditTemplateVariables(item.path.replace(/^\.flint\/templates\//, '')),
            },
          ]
        : []),
      ...(isFolder && onEditFolderVariables
        ? [
            {
              id: 'folder-variables',
              label: 'Folder variables…',
              onClick: () => onEditFolderVariables(item.path),
            },
          ]
        : []),
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
              id: 'open-new-tab',
              label: 'Open in new tab',
              onClick: () => onSelectNote(item.path, { newTab: true }),
            },
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

  // Focus the "Move to new note" destination input as soon as it opens — keyed on whether the
  // dialog is open, not on `extractState` itself, which gets a new object identity on every
  // keystroke; re-running this (and re-selecting all text) on every keystroke made it impossible
  // to type more than one character before the selection swallowed it.
  const isExtractOpen = extractState !== null;
  useEffect(() => {
    if (isExtractOpen) {
      setTimeout(() => {
        extractInputRef.current?.focus();
        extractInputRef.current?.select();
      }, 30);
    }
  }, [isExtractOpen]);

  const liveHeadings = React.useMemo(() => parseHeadingsFromContent(noteContent), [noteContent]);
  const outlineTree = React.useMemo(() => buildOutlineTree(liveHeadings), [liveHeadings]);

  const isOutlineNodeVisible = (ancestors: string[]): boolean =>
    !ancestors.some((anchor) => collapsedOutlineNodes.has(anchor));

  const toggleOutlineNodeCollapsed = (anchor: string) => {
    setCollapsedOutlineNodes((prev) => {
      const next = new Set(prev);
      if (next.has(anchor)) next.delete(anchor);
      else next.add(anchor);
      return next;
    });
  };

  const allCollapsibleAnchors = (nodes: OutlineNode[]): string[] => {
    const anchors: string[] = [];
    for (const n of nodes) {
      if (n.children.length > 0) {
        anchors.push(n.heading.anchor);
        anchors.push(...allCollapsibleAnchors(n.children));
      }
    }
    return anchors;
  };

  const outlineHasCollapsibleNodes = allCollapsibleAnchors(outlineTree).length > 0;
  const anyOutlineNodeCollapsed = collapsedOutlineNodes.size > 0;

  const handleToggleCollapseAll = () => {
    if (anyOutlineNodeCollapsed) {
      setCollapsedOutlineNodes(new Set());
    } else {
      setCollapsedOutlineNodes(new Set(allCollapsibleAnchors(outlineTree)));
    }
  };

  // Outline drag-to-reorder (M10.09). Deliberately NOT native HTML5 drag-and-drop (unlike the
  // file tree above): native DnD's "drop only completes if the last dragover before release
  // called preventDefault on exactly the released-over element" contract proved unreliable in
  // practice (confirmed interactively — dragstart/dragover fired but drop silently never did),
  // and is a well-known source of flakiness in embedded webviews. This is a self-contained
  // mousedown/mousemove/mouseup implementation instead: full control over exactly when a drop is
  // considered valid, no dependency on native drag semantics at all.
  const commitOutlineReorder = (groupIndices: number[], beforePos: number, draggedIndex: number) => {
    const fromPos = groupIndices.indexOf(draggedIndex);
    if (fromPos === -1) return;
    const withoutDragged = groupIndices.filter((_, i) => i !== fromPos);
    const insertAt = fromPos < beforePos ? beforePos - 1 : beforePos;
    const newOrder = [...withoutDragged.slice(0, insertAt), draggedIndex, ...withoutDragged.slice(insertAt)];
    if (JSON.stringify(newOrder) !== JSON.stringify(groupIndices)) {
      const change = reorderSiblingsChange(liveHeadings, noteContent, groupIndices, newOrder);
      if (change) applyOutlineEdit([change]);
    }
  };

  const outlineRowRefs = useRef<Map<number, HTMLDivElement>>(new Map());
  const pointerDragRef = useRef<{
    index: number;
    startX: number;
    startY: number;
    active: boolean;
  } | null>(null);

  const computeOutlineDropTarget = (index: number, clientY: number) => {
    const group = siblingGroup(liveHeadings, index);
    let beforePos = group.length;
    for (let pos = 0; pos < group.length; pos++) {
      const rowEl = outlineRowRefs.current.get(group[pos]);
      if (!rowEl) continue;
      const rect = rowEl.getBoundingClientRect();
      if (clientY < rect.top + rect.height / 2) {
        beforePos = pos;
        break;
      }
    }
    return { groupIndices: group, beforePos };
  };

  const handleOutlinePointerMove = (e: MouseEvent) => {
    const drag = pointerDragRef.current;
    if (!drag) return;
    if (!drag.active) {
      if (Math.abs(e.clientY - drag.startY) < 4 && Math.abs(e.clientX - drag.startX) < 4) return;
      drag.active = true;
      setDraggedOutlineIndex(drag.index);
    }
    setOutlineDropTarget(computeOutlineDropTarget(drag.index, e.clientY));
  };

  const endOutlinePointerDrag = (commit: boolean) => {
    const drag = pointerDragRef.current;
    pointerDragRef.current = null;
    window.removeEventListener('mousemove', handleOutlinePointerMove);
    window.removeEventListener('mouseup', handleOutlinePointerUp);
    window.removeEventListener('keydown', handleOutlinePointerKeyDown);
    if (commit && drag?.active) {
      setOutlineDropTarget((target) => {
        if (target) commitOutlineReorder(target.groupIndices, target.beforePos, drag.index);
        return null;
      });
    } else {
      setOutlineDropTarget(null);
    }
    setDraggedOutlineIndex(null);
  };

  function handleOutlinePointerUp() {
    endOutlinePointerDrag(true);
  }

  function handleOutlinePointerKeyDown(e: KeyboardEvent) {
    if (e.key === 'Escape') endOutlinePointerDrag(false);
  }

  const handleOutlineMouseDown = (e: React.MouseEvent, index: number) => {
    if (e.button !== 0) return;
    if ((e.target as HTMLElement).closest('button')) return; // don't hijack the collapse toggle
    pointerDragRef.current = { index, startX: e.clientX, startY: e.clientY, active: false };
    window.addEventListener('mousemove', handleOutlinePointerMove);
    window.addEventListener('mouseup', handleOutlinePointerUp);
    window.addEventListener('keydown', handleOutlinePointerKeyDown);
  };

  useEffect(() => {
    return () => {
      window.removeEventListener('mousemove', handleOutlinePointerMove);
      window.removeEventListener('mouseup', handleOutlinePointerUp);
      window.removeEventListener('keydown', handleOutlinePointerKeyDown);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleOutlineKeyDown = (e: React.KeyboardEvent, index: number) => {
    if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
      e.preventDefault();
      const change = swapWithAdjacentSibling(liveHeadings, noteContent, index, e.key === 'ArrowUp' ? 'up' : 'down');
      if (change) applyOutlineEdit([change]);
    } else if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) {
      e.preventDefault();
      const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
      setOutlineContextMenu({ x: rect.left + 20, y: rect.bottom, index });
    }
  };

  // Outline right-click context menu actions
  const handleOutlineContextMenu = (e: React.MouseEvent, index: number) => {
    e.preventDefault();
    e.stopPropagation();
    setOutlineContextMenu({ x: e.clientX, y: e.clientY, index });
  };

  const buildOutlineMenuItems = (index: number): ContextMenuItem[] => {
    const heading = liveHeadings[index];
    return [
      {
        id: 'copy-heading',
        label: 'Copy heading',
        onClick: () => {
          navigator.clipboard.writeText(heading.text);
        },
      },
      {
        id: 'copy-section',
        label: 'Copy section',
        onClick: () => {
          navigator.clipboard.writeText(sectionText(liveHeadings, index, noteContent));
        },
      },
      {
        id: 'copy-link',
        label: 'Copy link to section',
        onClick: () => {
          navigator.clipboard.writeText(`[${heading.text}](${currentNotePath}#${heading.anchor})`);
        },
      },
      { id: 'sep1', label: '', separator: true, onClick: () => {} },
      {
        id: 'move-to-new-note',
        label: 'Move to new note',
        onClick: () => {
          setExtractState({ index, value: `${slugify(heading.text) || 'untitled'}.md`, error: null });
        },
      },
      { id: 'sep2', label: '', separator: true, onClick: () => {} },
      {
        id: 'delete',
        label: 'Delete',
        danger: true,
        onClick: () => setDeleteSectionIndex(index),
      },
    ];
  };

  const performExtract = async (index: number, destPath: string) => {
    const body = sectionText(liveHeadings, index, noteContent);
    try {
      await api.noteCreate(destPath, body);
      const link = `[${liveHeadings[index].text}](${destPath})`;
      applyOutlineEdit([{ ...removeSectionChange(liveHeadings, index, noteContent), insert: `${link}\n` }]);
      onSectionMovedToNewNote?.(destPath);
    } catch (err: any) {
      onSectionMoveFailed?.(err?.message || String(err));
    }
  };

  const handleExtractSubmit = async () => {
    if (!extractState) return;
    const trimmed = extractState.value.trim();
    if (!trimmed) {
      setExtractState({ ...extractState, error: 'Name cannot be empty' });
      return;
    }
    const destPath = trimmed.endsWith('.md') ? trimmed : `${trimmed}.md`;
    const index = extractState.index;
    setExtractState(null);

    const confirmFirst = (await api.configGet<boolean>(CONFIRM_MOVE_TO_NEW_NOTE_KEY)) ?? true;
    if (confirmFirst) {
      setConfirmExtractState({ index, destPath });
    } else {
      await performExtract(index, destPath);
    }
  };
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
                autoComplete="off"
                autoCorrect="off"
                autoCapitalize="off"
                spellCheck={false}
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
                      autoComplete="off"
                      autoCorrect="off"
                      autoCapitalize="off"
                      spellCheck={false}
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
                  data-path={item.path}
                  data-parent={currentParent}
                  draggable
                  onDragStart={(e) => handleDragStart(e, item)}
                  onDragOver={(e) => handleDragOver(e, item)}
                  onDrop={(e) => handleDrop(e, isFolder ? item.path : currentParent)}
                  onContextMenu={(e) => handleContextMenu(e, item)}
                  onClick={(e) => {
                    if (isFolder) {
                      toggleFolder(item.path);
                      onSelectFolder?.(item.path);
                    } else if (isNote) {
                      // ⌘/Ctrl-click opens in a new tab instead of replacing the active one.
                      if (e.metaKey || e.ctrlKey) onSelectNote(item.path, { newTab: true });
                      else onSelectNote(item.path);
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
                    } else if (e.key === 'Enter') {
                      e.preventDefault();
                      if (isFolder) {
                        toggleFolder(item.path);
                        onSelectFolder?.(item.path);
                      } else if (isNote) {
                        if (e.metaKey || e.ctrlKey) onSelectNote(item.path, { newTab: true });
                      else onSelectNote(item.path);
                        onSelectFolder?.(currentParent);
                      }
                    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                      e.preventDefault();
                      const items = getVisibleTreeItems();
                      const idx = items.indexOf(e.currentTarget);
                      const next = items[idx + (e.key === 'ArrowDown' ? 1 : -1)];
                      next?.focus();
                    } else if (e.key === 'ArrowRight') {
                      if (isFolder) {
                        e.preventDefault();
                        if (!isExpanded) {
                          toggleFolder(item.path);
                        } else {
                          const items = getVisibleTreeItems();
                          items[items.indexOf(e.currentTarget) + 1]?.focus();
                        }
                      }
                    } else if (e.key === 'ArrowLeft') {
                      if (isFolder && isExpanded) {
                        e.preventDefault();
                        toggleFolder(item.path);
                      } else if (currentParent) {
                        e.preventDefault();
                        focusTreeItemByPath(currentParent);
                      }
                    }
                  }}
                  tabIndex={0}
                  style={{ paddingLeft: `${depth * 14 + 10}px` }}
                  className={`group flex items-center gap-2 h-[26px] pr-2 text-[var(--text-2)] cursor-pointer whitespace-nowrap select-none rounded-[4px] mx-1 hover:bg-[var(--panel-2)] transition-colors focus:outline-none focus:ring-1 focus:ring-inset focus:ring-[var(--accent)] ${
                    isSelected ? 'bg-[#2b3040] text-[#ffffff] font-medium' : 'focus:bg-[var(--sel)] focus:text-[var(--text)]'
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
          title="Workspace"
          aria-label="Workspace"
          className={`w-9 flex items-center justify-center transition-colors ${
            activeTab === 'tree'
              ? 'text-[var(--text)] shadow-[inset_0_-2px_0_var(--accent)]'
              : 'text-[var(--muted)] hover:text-[var(--text)]'
          }`}
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z" />
          </svg>
        </button>
        <button
          role="tab"
          aria-selected={activeTab === 'search'}
          onClick={() => onTabChange('search')}
          title="Search"
          aria-label="Search"
          className={`w-9 flex items-center justify-center transition-colors ${
            activeTab === 'search'
              ? 'text-[var(--text)] shadow-[inset_0_-2px_0_var(--accent)]'
              : 'text-[var(--muted)] hover:text-[var(--text)]'
          }`}
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="11" cy="11" r="7" />
            <path d="m20 20-3.5-3.5" />
          </svg>
        </button>
        <button
          role="tab"
          aria-selected={activeTab === 'outline'}
          onClick={() => onTabChange('outline')}
          title="Outline"
          aria-label="Outline"
          className={`w-9 flex items-center justify-center transition-colors ${
            activeTab === 'outline'
              ? 'text-[var(--text)] shadow-[inset_0_-2px_0_var(--accent)]'
              : 'text-[var(--muted)] hover:text-[var(--text)]'
          }`}
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <path d="M8 6h13M8 12h13M8 18h13" />
            <path d="M3 6h.01M3 12h.01M3 18h.01" />
          </svg>
        </button>
        <button
          role="tab"
          aria-selected={activeTab === 'tags'}
          onClick={() => onTabChange('tags')}
          title="Tags"
          aria-label="Tags"
          className={`w-9 flex items-center justify-center transition-colors ${
            activeTab === 'tags'
              ? 'text-[var(--text)] shadow-[inset_0_-2px_0_var(--accent)]'
              : 'text-[var(--muted)] hover:text-[var(--text)]'
          }`}
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <path d="M20.59 13.41 12 21.99a2 2 0 0 1-2.83 0L2.59 14.4a2 2 0 0 1 0-2.83l8.58-8.58A2 2 0 0 1 12.58 2H19a2 2 0 0 1 2 2v6.41a2 2 0 0 1-.41 1Z" />
            <circle cx="7.5" cy="7.5" r="1" fill="currentColor" stroke="none" />
          </svg>
        </button>

        {onClose && (
          <button
            onClick={onClose}
            className="ml-auto mr-1.5 self-center w-5 h-5 flex items-center justify-center rounded text-[var(--muted)] hover:bg-[var(--panel-2)] hover:text-[var(--text)] transition-colors text-xs font-semibold"
            title="Collapse sidebar (⌘B)"
            aria-label="Collapse sidebar"
          >
            -
          </button>
        )}
      </div>

      {/* Pane Content */}
      <div className="flex-1 overflow-auto py-1.5 min-h-0">
        {/* WORKSPACE TREE TAB */}
        {activeTab === 'tree' && (
          <div className="flex flex-col h-full">
            {activeTagFilter && (
              <div className="flex items-center gap-1.5 px-2.5 py-1.5 border-b border-[var(--border)]">
                <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full bg-[var(--accent-soft)] text-[var(--accent)] text-[11px] font-medium">
                  <span>#{activeTagFilter}</span>
                  <button
                    onClick={onClearTagFilter}
                    aria-label={`Clear filter for tag ${activeTagFilter}`}
                    className="hover:opacity-70"
                  >
                    ×
                  </button>
                </span>
              </div>
            )}
            <div
              ref={treeContainerRef}
              role="tree"
              aria-label="Workspace file tree"
              tabIndex={0}
              onContextMenu={(e) => handleContextMenu(e, null)}
              onDragOver={(e) => handleDragOver(e, null)}
              onDrop={(e) => handleDrop(e, '')}
              className={`flex-1 overflow-auto focus:outline-none ${dragOverTarget === '' ? 'bg-[var(--accent-soft)]/20' : ''}`}
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
              ) : activeTagFilter && displayedTreeData.length === 0 ? (
                <div className="p-4 text-center text-xs text-[var(--faint)]">
                  No notes tagged #{activeTagFilter}.
                </div>
              ) : (
                renderTree(displayedTreeData, 0, '')
              )}
            </div>
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
              {searchError ? (
                <div className="p-3 m-2 bg-[var(--danger-soft)]/20 border border-[var(--spark)] rounded-[5px]">
                  <div className="text-[11.5px] font-semibold text-[var(--spark)] mb-1 flex items-center gap-1">
                    <span>⚠</span> {isRegex ? 'Invalid Regular Expression' : 'Search Error'}
                  </div>
                  <div className="text-[11px] font-mono text-[var(--text-2)] break-words">
                    {searchError}
                  </div>
                </div>
              ) : isSearching ? (
                <div className="p-4 text-center text-xs text-[var(--faint)]">
                  Searching workspace...
                </div>
              ) : !searchQuery.trim() ? (
                <div className="p-4 text-center text-xs text-[var(--faint)]">
                  Type a query to search across all notes.
                </div>
              ) : searchHits.length === 0 ? (
                <div className="p-4 text-center text-xs text-[var(--faint)]">
                  No matching results found for "{searchQuery}".
                </div>
              ) : (
                searchHits.map((group) => (
                  <div key={group.path} className="mb-2">
                    <div
                      onClick={() => onSelectNote(group.path)}
                      className="px-2.5 py-1 text-[11.5px] font-medium text-[var(--muted)] hover:text-[var(--text)] cursor-pointer truncate flex items-center justify-between"
                      title={group.path}
                    >
                      <span className="truncate">{group.path}</span>
                      <span className="text-[10.5px] font-mono text-[var(--faint)] ml-1 shrink-0">
                        {group.matches.length}
                      </span>
                    </div>
                    {group.matches.map((hit, idx) => {
                      const start = Math.max(0, hit.col - 1);
                      const end = start + hit.match_length;
                      return (
                        <div
                          key={idx}
                          onClick={() => onSelectNote(group.path, hit.line)}
                          className="flex gap-2 px-2.5 py-1 text-[11.5px] font-mono text-[var(--text-2)] hover:bg-[var(--panel-2)] cursor-pointer truncate rounded"
                        >
                          <span className="text-[var(--faint)] min-w-[20px] text-right shrink-0">
                            {hit.line}
                          </span>
                          <span className="truncate">
                            {hit.line_text.slice(0, start)}
                            <mark className="bg-[rgba(201,138,46,0.28)] text-inherit rounded-sm px-0.5">
                              {hit.line_text.slice(start, end)}
                            </mark>
                            {hit.line_text.slice(end)}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                ))
              )}
            </div>
          </div>
        )}

        {/* OUTLINE TAB */}
        {activeTab === 'outline' && (
          <div className="flex flex-col">
            <div className="flex items-center gap-1.5 px-3 py-1.5">
              <div className="flex-1 text-[11px] font-medium text-[var(--faint)] truncate">
                {currentNotePath.split('/').pop()}
              </div>
              {outlineHasCollapsibleNodes && (
                <button
                  onClick={handleToggleCollapseAll}
                  aria-pressed={anyOutlineNodeCollapsed}
                  title={anyOutlineNodeCollapsed ? 'Expand all' : 'Collapse all'}
                  aria-label={anyOutlineNodeCollapsed ? 'Expand all sections' : 'Collapse all sections'}
                  className="w-5 h-5 flex items-center justify-center rounded text-[var(--muted)] hover:bg-[var(--panel-2)] hover:text-[var(--text)] transition-colors shrink-0"
                >
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    {anyOutlineNodeCollapsed ? (
                      // Expand all: two chevrons pointing down (unfold)
                      <>
                        <polyline points="7 13 12 18 17 13" />
                        <polyline points="7 6 12 11 17 6" />
                      </>
                    ) : (
                      // Collapse all: two chevrons pointing up (fold)
                      <>
                        <polyline points="17 11 12 6 7 11" />
                        <polyline points="17 18 12 13 7 18" />
                      </>
                    )}
                  </svg>
                </button>
              )}
            </div>
            {liveHeadings.length === 0 ? (
              <div className="p-4 text-center text-xs text-[var(--faint)]">
                No headings in this note.
              </div>
            ) : (
              <div role="tree" aria-label="Note outline">
                {(function renderNodes(nodes: OutlineNode[], ancestors: string[]): React.ReactNode {
                  if (!isOutlineNodeVisible(ancestors)) return null;
                  return nodes.map((node) => {
                    const { heading: h, index: i } = node;
                    // Indent by tree depth (ancestors.length), not raw heading level, so a document
                    // that jumps straight from H1 to H4 (or any other level gap) still nests one
                    // step per actual tree depth instead of clamping every level ≥3 to the same
                    // indent.
                    const indentPx = 10 + ancestors.length * 14;
                    const isActive = activeHeadingAnchor === h.anchor;
                    const isCollapsed = collapsedOutlineNodes.has(h.anchor);
                    const hasChildren = node.children.length > 0;
                    const isDropBefore =
                      outlineDropTarget &&
                      outlineDropTarget.groupIndices[outlineDropTarget.beforePos] === i;

                    return (
                      <React.Fragment key={h.anchor + i}>
                        {isDropBefore && (
                          <div className="h-0.5 mx-2 bg-[var(--accent)] rounded" />
                        )}
                        <div
                          role="treeitem"
                          aria-selected={isActive}
                          aria-expanded={hasChildren ? !isCollapsed : undefined}
                          data-outline-index={i}
                          ref={(el) => {
                            if (el) outlineRowRefs.current.set(i, el);
                            else outlineRowRefs.current.delete(i);
                          }}
                          tabIndex={0}
                          onMouseDown={(e) => handleOutlineMouseDown(e, i)}
                          onContextMenu={(e) => handleOutlineContextMenu(e, i)}
                          onKeyDown={(e) => handleOutlineKeyDown(e, i)}
                          onClick={() => onSelectHeading && onSelectHeading(h)}
                          title={h.text}
                          style={{ paddingLeft: `${indentPx}px` }}
                          className={`flex items-center gap-1 h-6 pr-2 text-[12px] cursor-pointer select-none transition-colors focus:outline-none focus:ring-1 focus:ring-inset focus:ring-[var(--accent)] ${
                            isActive
                              ? 'bg-[var(--accent-soft)] text-[var(--accent)] font-medium'
                              : 'text-[var(--text-2)] hover:bg-[var(--panel-2)] hover:text-[var(--text)]'
                          } ${draggedOutlineIndex === i ? 'opacity-40' : ''}`}
                        >
                          {hasChildren ? (
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                toggleOutlineNodeCollapsed(h.anchor);
                              }}
                              className="w-3 h-3 flex items-center justify-center shrink-0 text-[var(--faint)]"
                              aria-label={isCollapsed ? 'Expand section' : 'Collapse section'}
                            >
                              {isCollapsed ? '▸' : '▾'}
                            </button>
                          ) : (
                            <span className={`text-xs w-3 text-center shrink-0 ${isActive ? 'text-[var(--accent)]' : 'text-[var(--faint)]'}`}>§</span>
                          )}
                          <span className="truncate">{h.text}</span>
                        </div>
                        {hasChildren && renderNodes(node.children, [...ancestors, h.anchor])}
                        {outlineDropTarget &&
                          outlineDropTarget.groupIndices[outlineDropTarget.groupIndices.length - 1] === i &&
                          outlineDropTarget.beforePos === outlineDropTarget.groupIndices.length && (
                            <div className="h-0.5 mx-2 bg-[var(--accent)] rounded" />
                          )}
                      </React.Fragment>
                    );
                  });
                })(outlineTree, [])}
              </div>
            )}
          </div>
        )}

        {/* TAGS TAB */}
        {activeTab === 'tags' && (
          <div className="flex flex-col h-full">
            <div className="p-2.5 pb-2 border-b border-[var(--border)]">
              <input
                type="text"
                value={tagFilterQuery}
                onChange={(e) => setTagFilterQuery(e.target.value)}
                placeholder="Filter tags..."
                aria-label="Filter workspace tags"
                className="w-full px-2 py-1 text-xs text-[var(--text)] bg-[var(--canvas)] border border-[var(--border)] rounded-[5px] focus:outline-none focus:border-[var(--accent)]"
              />
            </div>
            <div className="flex-1 overflow-auto p-1">
              {tagCounts.length === 0 ? (
                <div className="p-4 text-center text-xs text-[var(--faint)]">
                  No tags in this workspace yet.
                </div>
              ) : filteredTagCounts.length === 0 ? (
                <div className="p-4 text-center text-xs text-[var(--faint)]">
                  No tags match "{tagFilterQuery}".
                </div>
              ) : (
                filteredTagCounts.map((t) =>
                  renamingTag === t.tag ? (
                    <div
                      key={t.tag}
                      className="flex items-center gap-2 h-[26px] mx-1 my-0.5 px-2 bg-[var(--panel-2)] rounded-[4px] border border-[var(--accent)]"
                    >
                      <span className="text-[var(--faint)] text-xs">#</span>
                      <input
                        ref={renameTagInputRef}
                        type="text"
                        value={renameTagValue}
                        onChange={(e) => setRenameTagValue(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') commitTagRename();
                          else if (e.key === 'Escape') setRenamingTag(null);
                        }}
                        onBlur={commitTagRename}
                        autoComplete="off"
                        autoCorrect="off"
                        autoCapitalize="off"
                        spellCheck={false}
                        className="w-full bg-transparent text-[12.5px] text-[var(--text)] focus:outline-none"
                      />
                    </div>
                  ) : (
                    <div
                      key={t.tag}
                      role="button"
                      tabIndex={0}
                      onClick={() => onFilterByTag?.(t.tag)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') onFilterByTag?.(t.tag);
                      }}
                      onContextMenu={(e) => {
                        e.preventDefault();
                        setTagContextMenu({ x: e.clientX, y: e.clientY, tag: t.tag });
                      }}
                      className={`flex items-center gap-1.5 px-3 py-1 text-[12.5px] cursor-pointer rounded-[4px] mx-1 focus:outline-none focus:ring-1 focus:ring-inset focus:ring-[var(--accent)] ${
                        activeTagFilter === t.tag
                          ? 'bg-[var(--accent-soft)] text-[var(--accent)] font-medium'
                          : 'text-[var(--text-2)] hover:bg-[var(--panel-2)] hover:text-[var(--text)]'
                      }`}
                    >
                      <span className="text-[var(--faint)] text-xs">#</span>
                      <span className="truncate">{t.tag}</span>
                      <i className="ml-auto not-italic text-[var(--faint)] text-[11px] font-mono">
                        {t.count}
                      </i>
                    </div>
                  )
                )
              )}
            </div>
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

      {/* Tag context menu (right sidebar / left Tags tab, M10.25) */}
      {tagContextMenu && (
        <ContextMenu
          x={tagContextMenu.x}
          y={tagContextMenu.y}
          items={buildTagMenuItems(tagContextMenu.tag)}
          onClose={() => setTagContextMenu(null)}
        />
      )}

      {/* Outline node context menu */}
      {outlineContextMenu && (
        <ContextMenu
          x={outlineContextMenu.x}
          y={outlineContextMenu.y}
          items={buildOutlineMenuItems(outlineContextMenu.index)}
          onClose={() => setOutlineContextMenu(null)}
        />
      )}

      {/* "Move to new note" destination prompt */}
      {extractState && (
        <div
          role="dialog"
          aria-modal="true"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-[1px]"
        >
          <div className="w-[380px] bg-[var(--panel)] border border-[var(--border)] rounded-[8px] shadow-[var(--shadow)] p-4 text-[13px] flex flex-col gap-3">
            <h2 className="text-[14px] font-semibold text-[var(--text)]">Move section to new note</h2>
            <input
              ref={extractInputRef}
              type="text"
              value={extractState.value}
              onChange={(e) => setExtractState({ ...extractState, value: e.target.value, error: null })}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleExtractSubmit();
                else if (e.key === 'Escape') setExtractState(null);
              }}
              className="w-full px-2 py-1.5 text-[13px] text-[var(--text)] bg-[var(--canvas)] border border-[var(--border)] rounded-[5px] focus:outline-none focus:border-[var(--accent)]"
            />
            {extractState.error && <div className="text-[11.5px] text-[#e06c75]">{extractState.error}</div>}
            <div className="flex items-center justify-end gap-2 pt-1">
              <button
                onClick={() => setExtractState(null)}
                className="px-3 py-1.5 text-[12.5px] text-[var(--text-2)] hover:text-[var(--text)] hover:bg-[var(--panel-2)] rounded-[5px] transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleExtractSubmit}
                className="px-3.5 py-1.5 text-[12.5px] font-medium bg-[var(--accent)] text-white hover:opacity-90 rounded-[5px] transition-colors"
              >
                Move
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Confirm before extracting (outline.confirmMoveToNewNote, default on) */}
      {confirmExtractState && (
        <DeleteConfirmModal
          isOpen
          title="Move to new note?"
          message="This creates a new note with this section's content, removes the section from this note, and inserts a link in its place."
          itemName={confirmExtractState.destPath}
          confirmLabel="Move to New Note"
          confirmDanger={false}
          onCancel={() => setConfirmExtractState(null)}
          onConfirm={() => {
            const { index, destPath } = confirmExtractState;
            setConfirmExtractState(null);
            void performExtract(index, destPath);
          }}
        />
      )}

      {/* Confirm before deleting a section */}
      {deleteSectionIndex !== null && (
        <DeleteConfirmModal
          isOpen
          title="Delete section"
          message="This removes the heading, its body, and all nested sub-headings from this note. This only edits the note's content — it does not delete the note itself."
          itemName={liveHeadings[deleteSectionIndex].text}
          onCancel={() => setDeleteSectionIndex(null)}
          onConfirm={() => {
            const index = deleteSectionIndex;
            setDeleteSectionIndex(null);
            applyOutlineEdit([removeSectionChange(liveHeadings, index, noteContent)]);
          }}
        />
      )}
    </aside>
  );
};
