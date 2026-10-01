import React, { useRef, useState } from 'react';
import { ContextMenu, ContextMenuItem } from './ContextMenu';
import type { Tab } from '../state/panes';

export interface TabStripProps {
  paneId: string;
  tabs: Tab[];
  activeTabId: string | null;
  /** Show the pane's own active/inactive emphasis (only meaningful with two panes). */
  isActivePane: boolean;
  /** Display title for a tab (note title, falling back to the filename). */
  titleFor: (tab: Tab) => string;
  onActivate: (tabId: string) => void;
  onClose: (tabId: string) => void;
  onCloseOthers: (tabId: string) => void;
  onCloseToRight: (tabId: string) => void;
  onTogglePin: (tabId: string) => void;
  onMoveToOtherPane: (tabId: string) => void;
  onReorder: (fromIndex: number, toIndex: number) => void;
}

/**
 * Tab strip for one pane (M10.28). Modeled on RightSidebar's tablist: roving tabindex, ←/→ to move
 * focus and activate, `--accent` underline on the active tab. Middle-click or × closes; drag
 * reorders within the pane; right-click opens the shared ContextMenu.
 */
export const TabStrip: React.FC<TabStripProps> = ({
  paneId,
  tabs,
  activeTabId,
  isActivePane,
  titleFor,
  onActivate,
  onClose,
  onCloseOthers,
  onCloseToRight,
  onTogglePin,
  onMoveToOtherPane,
  onReorder,
}) => {
  const tabRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const [menu, setMenu] = useState<{ x: number; y: number; tabId: string } | null>(null);
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [dropIndex, setDropIndex] = useState<number | null>(null);

  if (tabs.length === 0) return null;

  const focusTab = (tabId: string) => {
    onActivate(tabId);
    requestAnimationFrame(() => tabRefs.current[tabId]?.focus());
  };

  const handleKeyDown = (e: React.KeyboardEvent, index: number, tab: Tab) => {
    if (e.key === 'ArrowRight') {
      e.preventDefault();
      focusTab(tabs[(index + 1) % tabs.length].id);
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault();
      focusTab(tabs[(index - 1 + tabs.length) % tabs.length].id);
    } else if (e.key === 'Home') {
      e.preventDefault();
      focusTab(tabs[0].id);
    } else if (e.key === 'End') {
      e.preventDefault();
      focusTab(tabs[tabs.length - 1].id);
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onActivate(tab.id);
    } else if (e.key === 'Delete' && !tab.pinned) {
      e.preventDefault();
      onClose(tab.id);
    } else if (e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey)) {
      e.preventDefault();
      const rect = tabRefs.current[tab.id]?.getBoundingClientRect();
      setMenu({ x: rect?.left ?? 0, y: rect?.bottom ?? 0, tabId: tab.id });
    }
  };

  const menuItems = (tabId: string): ContextMenuItem[] => {
    const idx = tabs.findIndex((t) => t.id === tabId);
    const tab = tabs[idx];
    const hasOthers = tabs.some((t) => t.id !== tabId && !t.pinned);
    const hasRight = tabs.slice(idx + 1).some((t) => !t.pinned);
    return [
      { id: 'close', label: 'Close', shortcut: '⌘W', onClick: () => onClose(tabId) },
      {
        id: 'close-others',
        label: 'Close Others',
        disabled: !hasOthers,
        onClick: () => onCloseOthers(tabId),
      },
      {
        id: 'close-right',
        label: 'Close to the Right',
        disabled: !hasRight,
        onClick: () => onCloseToRight(tabId),
      },
      { id: 'sep-1', label: '', separator: true, onClick: () => {} },
      {
        id: 'pin',
        label: tab?.pinned ? 'Unpin' : 'Pin',
        onClick: () => onTogglePin(tabId),
      },
      {
        id: 'move',
        label: 'Move to other pane',
        onClick: () => onMoveToOtherPane(tabId),
      },
    ];
  };

  return (
    <>
      <div
        role="tablist"
        aria-label="Open notes"
        data-pane-id={paneId}
        className={`flex h-[31px] shrink-0 overflow-x-auto overflow-y-hidden border-b border-[var(--border)] bg-[var(--panel)] ${
          isActivePane ? '' : 'opacity-90'
        }`}
      >
        {tabs.map((tab, index) => {
          const active = tab.id === activeTabId;
          const title = titleFor(tab);
          return (
            <div
              key={tab.id}
              ref={(el) => {
                tabRefs.current[tab.id] = el;
              }}
              role="tab"
              id={`tab-${tab.id}`}
              aria-selected={active}
              tabIndex={active ? 0 : -1}
              title={tab.path}
              draggable
              onDragStart={(e) => {
                setDragIndex(index);
                e.dataTransfer.effectAllowed = 'move';
                e.dataTransfer.setData('text/plain', tab.id);
              }}
              onDragOver={(e) => {
                if (dragIndex === null) return;
                e.preventDefault();
                setDropIndex(index);
              }}
              onDrop={(e) => {
                e.preventDefault();
                if (dragIndex !== null && dragIndex !== index) onReorder(dragIndex, index);
                setDragIndex(null);
                setDropIndex(null);
              }}
              onDragEnd={() => {
                setDragIndex(null);
                setDropIndex(null);
              }}
              onClick={() => onActivate(tab.id)}
              onMouseDown={(e) => {
                if (e.button === 1) e.preventDefault(); // suppress middle-click autoscroll
              }}
              onAuxClick={(e) => {
                if (e.button === 1) {
                  e.preventDefault();
                  onClose(tab.id);
                }
              }}
              onContextMenu={(e) => {
                e.preventDefault();
                setMenu({ x: e.clientX, y: e.clientY, tabId: tab.id });
              }}
              onKeyDown={(e) => handleKeyDown(e, index, tab)}
              className={`group flex items-center gap-1.5 pl-3 pr-1.5 max-w-[200px] min-w-[72px] shrink-0 cursor-default border-r border-[var(--border)] text-[12px] outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-[var(--accent)] ${
                active
                  ? 'bg-[var(--canvas)] text-[var(--text)] shadow-[inset_0_-2px_0_var(--accent)]'
                  : 'text-[var(--muted)] hover:text-[var(--text-2)]'
              } ${dropIndex === index && dragIndex !== index ? 'border-l-2 border-l-[var(--accent)]' : ''} ${
                tab.missing ? 'line-through opacity-70' : ''
              }`}
            >
              {tab.isDirty && (
                <span className="text-[var(--spark)] leading-none" title="Unsaved changes" aria-label="Unsaved changes">
                  ●
                </span>
              )}
              <span className="truncate">{title}</span>
              {tab.pinned ? (
                <button
                  tabIndex={-1}
                  onClick={(e) => {
                    e.stopPropagation();
                    onTogglePin(tab.id);
                  }}
                  title="Pinned — click to unpin"
                  aria-label={`Unpin ${title}`}
                  className="ml-auto w-4 h-4 grid place-items-center rounded text-[10px] text-[var(--accent)] hover:bg-[var(--panel-2)]"
                >
                  ◆
                </button>
              ) : (
                <button
                  tabIndex={-1}
                  onClick={(e) => {
                    e.stopPropagation();
                    onClose(tab.id);
                  }}
                  title="Close tab"
                  aria-label={`Close ${title}`}
                  className={`ml-auto w-4 h-4 grid place-items-center rounded text-[10px] hover:bg-[var(--panel-2)] hover:text-[var(--text)] ${
                    active ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
                  }`}
                >
                  ✕
                </button>
              )}
            </div>
          );
        })}
      </div>
      {menu && (
        <ContextMenu x={menu.x} y={menu.y} items={menuItems(menu.tabId)} onClose={() => setMenu(null)} />
      )}
    </>
  );
};
