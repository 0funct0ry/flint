import React, { useState, useEffect, useRef } from 'react';
import { NoteFixture } from '../types';
import { commandRegistry, Command } from '../commands/registry';

export interface CommandPaletteProps {
  isOpen: boolean;
  onClose: () => void;
  notes: Record<string, NoteFixture>;
  onSelectNote: (path: string) => void;
  initialMode?: 'notes' | 'commands';
}

interface PaletteItem {
  id: string;
  type: 'note' | 'command';
  title: string;
  subtitle: string;
  glyph: string;
  shortcut?: string;
  onSelect: () => void;
}

export const CommandPalette: React.FC<CommandPaletteProps> = ({
  isOpen,
  onClose,
  notes,
  onSelectNote,
  initialMode = 'notes',
}) => {
  const [query, setQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isOpen) {
      if (initialMode === 'commands') {
        setQuery('>');
      } else {
        setQuery('');
      }
      setSelectedIndex(0);
      setTimeout(() => {
        inputRef.current?.focus();
      }, 50);
    }
  }, [isOpen, initialMode]);

  // Build items based on query
  const isCommandMode = query.startsWith('>');
  const cleanQuery = isCommandMode ? query.slice(1).trim().toLowerCase() : query.trim().toLowerCase();

  const items: PaletteItem[] = React.useMemo(() => {
    if (isCommandMode) {
      const allCommands: Command[] = commandRegistry.getAll();
      return allCommands
        .filter((cmd) => cmd.title.toLowerCase().includes(cleanQuery))
        .map((cmd) => ({
          id: cmd.id,
          type: 'command',
          title: cmd.title,
          subtitle: cmd.shortcutDisplay || cmd.shortcut || '',
          glyph: '›',
          shortcut: cmd.shortcutDisplay || cmd.shortcut,
          onSelect: () => {
            cmd.handler();
            onClose();
          },
        }));
    } else {
      const noteList = Object.values(notes);
      const filtered = noteList.filter(
        (n) =>
          n.title.toLowerCase().includes(cleanQuery) ||
          n.path.toLowerCase().includes(cleanQuery)
      );

      return filtered.slice(0, 30).map((n) => ({
        id: n.path,
        type: 'note',
        title: n.title,
        subtitle: n.path,
        glyph: '◦',
        onSelect: () => {
          onSelectNote(n.path);
          onClose();
        },
      }));
    }
  }, [isCommandMode, cleanQuery, notes, onClose, onSelectNote]);

  // Keyboard navigation inside palette
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelectedIndex((prev) => (items.length > 0 ? (prev + 1) % items.length : 0));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelectedIndex((prev) => (items.length > 0 ? (prev - 1 + items.length) % items.length : 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (items[selectedIndex]) {
        items[selectedIndex].onSelect();
      }
    }
  };

  if (!isOpen) return null;

  return (
    <div
      className="fixed inset-0 bg-[rgba(8,10,13,0.45)] flex items-start justify-center pt-[11vh] z-50 select-none animate-in fade-in duration-100"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      role="dialog"
      aria-modal="true"
      aria-label="Command palette"
    >
      <div className="w-[min(560px,92vw)] bg-[var(--panel)] border border-[var(--border)] rounded-[9px] shadow-[var(--shadow)] overflow-hidden flex flex-col">
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setSelectedIndex(0);
          }}
          onKeyDown={handleKeyDown}
          placeholder="Search notes by name, or type > for commands..."
          className="w-full text-sm px-4 py-3.5 text-[var(--text)] bg-transparent border-0 border-b border-[var(--border)] focus:outline-none placeholder:text-[var(--faint)]"
        />

        <ul className="max-h-[330px] overflow-auto py-1 list-none">
          {items.length === 0 ? (
            <li className="px-4 py-3 text-xs text-[var(--faint)] text-center">
              No matching {isCommandMode ? 'commands' : 'notes'} found.
            </li>
          ) : (
            items.map((item, idx) => {
              const isSelected = idx === selectedIndex;
              return (
                <li
                  key={item.id}
                  aria-selected={isSelected}
                  onClick={item.onSelect}
                  onMouseEnter={() => setSelectedIndex(idx)}
                  className={`flex items-center gap-2.5 px-4 py-1.5 cursor-pointer text-[12.5px] transition-colors ${
                    isSelected
                      ? 'bg-[var(--sel)] text-[var(--text)]'
                      : 'text-[var(--text-2)] hover:bg-[var(--panel-2)]'
                  }`}
                >
                  <span className="text-[var(--faint)] text-xs w-3.5 text-center shrink-0">
                    {item.glyph}
                  </span>
                  <span className="truncate font-medium">{item.title}</span>
                  <span className="ml-auto font-mono text-[11px] text-[var(--faint)] truncate max-w-[200px]">
                    {item.subtitle}
                  </span>
                </li>
              );
            })
          )}
        </ul>

        <footer className="flex items-center gap-3.5 px-4 py-2 border-t border-[var(--border)] text-[11px] text-[var(--faint)] bg-[var(--panel-2)]">
          <span>↑↓ to navigate</span>
          <span>↵ to select</span>
          <span>esc to dismiss</span>
          <span className="ml-auto font-mono">{items.length} results</span>
        </footer>
      </div>
    </div>
  );
};
