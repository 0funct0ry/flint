import React, { useEffect, useRef, useState } from 'react';
import { FrontMatterField } from '../types';

export interface FrontmatterPanelProps {
  fields: FrontMatterField[];
  onSave: (fields: FrontMatterField[]) => void;
}

/** A single field row's local editing state: which cell (if any) is active. */
type EditingCell = { row: number; column: 'key' | 'value' } | null;

export const FrontmatterPanel: React.FC<FrontmatterPanelProps> = ({ fields, onSave }) => {
  const [rows, setRows] = useState<FrontMatterField[]>(fields);
  const [editing, setEditing] = useState<EditingCell>(null);
  const [draftValue, setDraftValue] = useState('');
  const [confirmingDeleteRow, setConfirmingDeleteRow] = useState<number | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  // Set right before a Tab-driven key→value handoff replaces `editing` in the same tick, so the
  // outgoing input's blur (fired by React unmounting it) doesn't re-commit stale state on top.
  const suppressNextBlurRef = useRef(false);

  // Reflect fresh data from the backend (e.g. after external reload / another edit).
  useEffect(() => {
    setRows(fields);
  }, [fields]);

  useEffect(() => {
    if (editing) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [editing]);

  const commitRows = (next: FrontMatterField[]) => {
    // Drop rows with an empty key before persisting (an add-field row not yet
    // filled in should not become a real front-matter key).
    const persisted = next.filter(([key]) => key.trim() !== '');
    setRows(next);
    onSave(persisted);
  };

  const startEdit = (row: number, column: 'key' | 'value') => {
    setConfirmingDeleteRow(null);
    setEditing({ row, column });
    setDraftValue(column === 'key' ? rows[row][0] : rows[row][1]);
  };

  /** Applies the current draft into `rows`/persists it, without touching `editing` state. */
  const applyDraft = (): FrontMatterField[] => {
    if (!editing) return rows;
    const { row, column } = editing;
    const next = rows.map((field, idx) => {
      if (idx !== row) return field;
      return column === 'key' ? ([draftValue, field[1]] as FrontMatterField) : ([field[0], draftValue] as FrontMatterField);
    });
    commitRows(next);
    return next;
  };

  const commitEdit = () => {
    applyDraft();
    setEditing(null);
  };

  const cancelEdit = () => {
    setEditing(null);
  };

  const handleBlur = () => {
    if (suppressNextBlurRef.current) {
      suppressNextBlurRef.current = false;
      return;
    }
    commitEdit();
  };

  const handleCellKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      commitEdit();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      cancelEdit();
    } else if (e.key === 'Tab' && !e.shiftKey && editing?.column === 'key') {
      // Hand off from key -> value in the same row instead of tabbing out of the table.
      e.preventDefault();
      const row = editing.row;
      const next = applyDraft();
      suppressNextBlurRef.current = true;
      setDraftValue(next[row][1]);
      setEditing({ row, column: 'value' });
    } else if (e.key === 'Tab' && e.shiftKey && editing?.column === 'value') {
      // Symmetric handoff back from value -> key.
      e.preventDefault();
      const row = editing.row;
      const next = applyDraft();
      suppressNextBlurRef.current = true;
      setDraftValue(next[row][0]);
      setEditing({ row, column: 'key' });
    }
  };

  const requestDelete = (row: number) => {
    if (confirmingDeleteRow === row) {
      const next = rows.filter((_, idx) => idx !== row);
      setConfirmingDeleteRow(null);
      commitRows(next);
    } else {
      setConfirmingDeleteRow(row);
    }
  };

  const addField = () => {
    const next = [...rows, ['', ''] as FrontMatterField];
    setRows(next);
    setEditing({ row: next.length - 1, column: 'key' });
    setDraftValue('');
  };

  return (
    <div className="py-2">
      <div
        role="table"
        aria-label="Front matter fields"
        className="w-full text-[12.5px]"
      >
        <div role="row" className="flex px-3 pb-1 text-[11px] font-medium text-[var(--faint)]">
          <div role="columnheader" className="flex-1">Key</div>
          <div role="columnheader" className="flex-1">Value</div>
          <div className="w-5" />
        </div>

        {rows.length === 0 && (
          <div className="px-3 py-2 text-xs text-[var(--faint)] italic">
            No front-matter fields.
          </div>
        )}

        {rows.map((field, row) => {
          const [key, value] = field;
          const isEditingKey = editing?.row === row && editing.column === 'key';
          const isEditingValue = editing?.row === row && editing.column === 'value';
          return (
            <div role="row" key={row} className="flex items-center px-3 py-0.5 hover:bg-[var(--panel-2)] group">
              <div role="cell" className="flex-1 pr-2 truncate">
                {isEditingKey ? (
                  <input
                    ref={inputRef}
                    value={draftValue}
                    onChange={(e) => setDraftValue(e.target.value)}
                    onKeyDown={handleCellKeyDown}
                    onBlur={handleBlur}
                    autoComplete="off"
                    autoCorrect="off"
                    autoCapitalize="off"
                    spellCheck={false}
                    className="w-full bg-[var(--panel)] border border-[var(--accent)] rounded-sm px-1 py-0.5 text-[var(--text)] outline-none focus-visible:ring-1 focus-visible:ring-[var(--accent)]"
                    aria-label={`Key for row ${row + 1}`}
                  />
                ) : (
                  <button
                    onClick={() => startEdit(row, 'key')}
                    className="w-full text-left truncate text-[var(--text-2)] rounded-sm px-1 py-0.5 hover:text-[var(--text)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--accent)]"
                  >
                    {key || <span className="italic text-[var(--faint)]">key</span>}
                  </button>
                )}
              </div>
              <div role="cell" className="flex-1 pr-2 truncate">
                {isEditingValue ? (
                  <input
                    ref={inputRef}
                    value={draftValue}
                    onChange={(e) => setDraftValue(e.target.value)}
                    onKeyDown={handleCellKeyDown}
                    onBlur={handleBlur}
                    autoComplete="off"
                    autoCorrect="off"
                    autoCapitalize="off"
                    spellCheck={false}
                    className="w-full bg-[var(--panel)] border border-[var(--accent)] rounded-sm px-1 py-0.5 text-[var(--text)] outline-none focus-visible:ring-1 focus-visible:ring-[var(--accent)]"
                    aria-label={`Value for row ${row + 1}`}
                  />
                ) : (
                  <button
                    onClick={() => startEdit(row, 'value')}
                    className="w-full text-left truncate text-[var(--text-2)] rounded-sm px-1 py-0.5 hover:text-[var(--text)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--accent)]"
                  >
                    {value || <span className="italic text-[var(--faint)]">value</span>}
                  </button>
                )}
              </div>
              <div className="w-5 flex justify-end">
                <button
                  onClick={() => requestDelete(row)}
                  onBlur={() => setConfirmingDeleteRow((prev) => (prev === row ? null : prev))}
                  className={`w-4 h-4 flex items-center justify-center rounded-sm text-[11px] opacity-0 group-hover:opacity-100 focus-visible:opacity-100 transition-opacity ${
                    confirmingDeleteRow === row
                      ? 'bg-[var(--spark)] text-[var(--panel)] opacity-100'
                      : 'text-[var(--faint)] hover:text-[var(--text)] hover:bg-[var(--panel-2)]'
                  }`}
                  title={confirmingDeleteRow === row ? 'Click again to confirm delete' : 'Delete field'}
                  aria-label={confirmingDeleteRow === row ? `Confirm delete of ${key || 'field'}` : `Delete ${key || 'field'}`}
                >
                  {confirmingDeleteRow === row ? '✓' : '×'}
                </button>
              </div>
            </div>
          );
        })}

        <button
          onClick={addField}
          className="w-full text-left px-3 py-1 text-[var(--faint)] hover:text-[var(--accent)] hover:bg-[var(--panel-2)] transition-colors"
        >
          + Add field
        </button>
      </div>
    </div>
  );
};
