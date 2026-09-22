import React, { useEffect, useRef } from 'react';

export interface ContextMenuItem {
  id: string;
  label: string;
  shortcut?: string;
  icon?: React.ReactNode;
  danger?: boolean;
  separator?: boolean;
  disabled?: boolean;
  onClick: () => void;
}

export interface ContextMenuProps {
  x: number;
  y: number;
  items: ContextMenuItem[];
  onClose: () => void;
}

export const ContextMenu: React.FC<ContextMenuProps> = ({ x, y, items, onClose }) => {
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [onClose]);

  // Adjust positioning if near edge of viewport
  const adjustedX = Math.min(x, window.innerWidth - 210);
  const adjustedY = Math.min(y, window.innerHeight - (items.length * 30 + 20));

  return (
    <div
      ref={menuRef}
      role="menu"
      style={{ top: `${adjustedY}px`, left: `${adjustedX}px` }}
      className="fixed z-50 min-w-[190px] py-1 bg-[var(--panel)] border border-[var(--border)] rounded-[6px] shadow-[var(--shadow)] text-[12.5px] select-none focus:outline-none animate-in fade-in zoom-in-95 duration-100"
    >
      {items.map((item, idx) => {
        if (item.separator) {
          return <div key={idx} className="my-1 border-t border-[var(--border)]" />;
        }

        return (
          <button
            key={item.id}
            role="menuitem"
            disabled={item.disabled}
            onClick={() => {
              item.onClick();
              onClose();
            }}
            className={`w-full flex items-center justify-between px-3 py-1.5 text-left transition-colors ${
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
            {item.shortcut && (
              <span className="font-mono text-[10.5px] text-[var(--faint)] ml-3 shrink-0">
                {item.shortcut}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
};
