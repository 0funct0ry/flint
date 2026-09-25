import React, { useEffect, useRef, useState } from 'react';

export interface ContextMenuItem {
  id: string;
  label: string;
  shortcut?: string;
  icon?: React.ReactNode;
  danger?: boolean;
  separator?: boolean;
  disabled?: boolean;
  disabledReason?: string;
  /** A flat, single level of nested items shown as a flyout submenu; leaf items have none. */
  submenu?: ContextMenuItem[];
  onClick: () => void;
}

export interface ContextMenuProps {
  x: number;
  y: number;
  items: ContextMenuItem[];
  onClose: () => void;
}

function isSelectable(item: ContextMenuItem): boolean {
  return !item.separator && !item.disabled;
}

function stepIndex(items: ContextMenuItem[], from: number, dir: 1 | -1): number {
  if (items.length === 0) return -1;
  let idx = from;
  for (let i = 0; i < items.length; i++) {
    idx = (idx + dir + items.length) % items.length;
    if (isSelectable(items[idx])) return idx;
  }
  return from;
}

/** A single (possibly nested) menu panel. Renders itself, and recurses one level for a submenu. */
const MenuPanel: React.FC<{
  x: number;
  y: number;
  items: ContextMenuItem[];
  onClose: () => void;
  autoFocusFirst: boolean;
}> = ({ x, y, items, onClose, autoFocusFirst }) => {
  const menuRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const [activeIndex, setActiveIndex] = useState<number>(() =>
    autoFocusFirst ? items.findIndex(isSelectable) : -1
  );
  const [openSubmenuIndex, setOpenSubmenuIndex] = useState<number | null>(null);

  useEffect(() => {
    if (activeIndex >= 0 && openSubmenuIndex === null) {
      itemRefs.current[activeIndex]?.focus();
    }
  }, [activeIndex, openSubmenuIndex]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Let an open submenu handle its own keys; only intercept Escape/ArrowLeft to close it.
      if (openSubmenuIndex !== null) {
        if (e.key === 'ArrowLeft' || e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          setOpenSubmenuIndex(null);
        }
        return;
      }

      switch (e.key) {
        case 'Escape':
          onClose();
          break;
        case 'ArrowDown':
          e.preventDefault();
          setActiveIndex((prev) => stepIndex(items, prev, 1));
          break;
        case 'ArrowUp':
          e.preventDefault();
          setActiveIndex((prev) => stepIndex(items, prev, -1));
          break;
        case 'Home':
          e.preventDefault();
          setActiveIndex(stepIndex(items, -1, 1));
          break;
        case 'End':
          e.preventDefault();
          setActiveIndex(stepIndex(items, 0, -1));
          break;
        case 'ArrowRight':
        case 'Enter':
        case ' ':
          e.preventDefault();
          if (activeIndex >= 0 && isSelectable(items[activeIndex])) {
            const item = items[activeIndex];
            if (item.submenu && item.submenu.length > 0) {
              setOpenSubmenuIndex(activeIndex);
            } else if (e.key !== 'ArrowRight') {
              item.onClick();
              onClose();
            }
          }
          break;
        default:
          break;
      }
    };

    document.addEventListener('keydown', handleKeyDown, true);
    return () => document.removeEventListener('keydown', handleKeyDown, true);
  }, [items, activeIndex, openSubmenuIndex, onClose]);

  const rowHeight = 30;
  const separatorHeight = 9;
  const estimatedHeight = items.reduce((sum, item) => sum + (item.separator ? separatorHeight : rowHeight), 0) + 12;
  const adjustedX = Math.max(8, Math.min(x, window.innerWidth - 218));
  const adjustedY = Math.max(8, Math.min(y, window.innerHeight - estimatedHeight - 8));
  const maxHeight = window.innerHeight - 16;

  const openItem = openSubmenuIndex !== null ? items[openSubmenuIndex] : null;
  const openItemRect = openSubmenuIndex !== null ? itemRefs.current[openSubmenuIndex]?.getBoundingClientRect() : null;

  return (
    <>
      <div
        ref={menuRef}
        role="menu"
        style={{ top: `${adjustedY}px`, left: `${adjustedX}px`, maxHeight: `${maxHeight}px`, overflowY: 'auto' }}
        className="fixed z-50 min-w-[200px] py-1 bg-[var(--panel)] border border-[var(--border)] rounded-[6px] shadow-[var(--shadow)] text-[12.5px] select-none focus:outline-none animate-in fade-in zoom-in-95 duration-100"
      >
        {items.map((item, idx) => {
          if (item.separator) {
            return <div key={idx} className="my-1 border-t border-[var(--border)]" />;
          }

          const hasSubmenu = !!item.submenu && item.submenu.length > 0;

          return (
            <button
              key={item.id}
              ref={(el) => {
                itemRefs.current[idx] = el;
              }}
              role="menuitem"
              aria-haspopup={hasSubmenu || undefined}
              tabIndex={-1}
              disabled={item.disabled}
              title={item.disabled ? item.disabledReason : undefined}
              onMouseEnter={() => {
                setActiveIndex(idx);
                if (hasSubmenu) setOpenSubmenuIndex(idx);
                else setOpenSubmenuIndex(null);
              }}
              onClick={() => {
                if (hasSubmenu) {
                  setOpenSubmenuIndex(idx);
                  return;
                }
                item.onClick();
                onClose();
              }}
              className={`w-full flex items-center justify-between px-3 py-1.5 text-left transition-colors focus:outline-none ${
                idx === activeIndex ? 'bg-[var(--panel-2)] text-[var(--text)]' : ''
              } ${
                item.disabled
                  ? 'opacity-40 cursor-not-allowed text-[var(--muted)]'
                  : item.danger
                  ? 'text-[#e06c75] hover:bg-[#e06c75]/10 font-medium'
                  : 'text-[var(--text-2)] hover:text-[var(--text)] hover:bg-[var(--panel-2)]'
              }`}
            >
              <span className="flex items-center gap-2 truncate">
                {item.icon && <span className="w-3.5 h-3.5 flex items-center justify-center opacity-80">{item.icon}</span>}
                <span className="truncate">{item.label}</span>
              </span>
              {hasSubmenu ? (
                <span className="text-[var(--faint)] ml-3 shrink-0">›</span>
              ) : (
                item.shortcut && (
                  <span className="font-mono text-[10.5px] text-[var(--faint)] ml-3 shrink-0">{item.shortcut}</span>
                )
              )}
            </button>
          );
        })}
      </div>

      {openItem && openItem.submenu && openItemRect && (
        <MenuPanel
          x={openItemRect.right + 2}
          y={openItemRect.top}
          items={openItem.submenu}
          onClose={onClose}
          autoFocusFirst
        />
      )}
    </>
  );
};

export const ContextMenu: React.FC<ContextMenuProps> = ({ x, y, items, onClose }) => {
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      const target = e.target as Node;
      // Any element still inside a menu panel (top level or a flyout) has role="menu" as an
      // ancestor; clicking truly outside all panels closes the whole context menu.
      if (!(target as HTMLElement).closest?.('[role="menu"]')) {
        onClose();
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [onClose]);

  return (
    <div ref={rootRef}>
      <MenuPanel x={x} y={y} items={items} onClose={onClose} autoFocusFirst />
    </div>
  );
};
