import React, { useEffect, useRef, useState } from 'react';
import { KeyValueRows } from './KeyValueRows';

export interface FolderVariablesModalProps {
  isOpen: boolean;
  folderPath: string;
  initialVariables: Record<string, string>;
  onSave: (variables: Record<string, string>) => void;
  onCancel: () => void;
}

/**
 * "Folder variables…" (M10.27 Journey C) — name/value defaults applied to every note created
 * under this folder (recursively, nearest-ancestor-wins). Thin wrapper around `KeyValueRows`,
 * same overlay/panel/Escape conventions as `TemplateEditorModal`.
 */
export const FolderVariablesModal: React.FC<FolderVariablesModalProps> = ({
  isOpen,
  folderPath,
  initialVariables,
  onSave,
  onCancel,
}) => {
  const [entries, setEntries] = useState<[string, string][]>(Object.entries(initialVariables));
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!isOpen) return;
    setEntries(Object.entries(initialVariables));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, folderPath]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (!isOpen) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        onCancel();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onCancel]);

  if (!isOpen) return null;

  const handleSave = () => {
    const map: Record<string, string> = {};
    for (const [k, v] of entries) {
      if (k.trim()) map[k.trim()] = v;
    }
    onSave(map);
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-[1px]"
      onClick={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="Folder variables"
        className="w-[460px] max-w-[92vw] bg-[var(--panel)] border border-[var(--border)] rounded-[9px] shadow-[var(--shadow)] text-[13px] flex flex-col overflow-hidden"
      >
        <div className="px-[15px] py-[13px] text-[13.5px] font-medium text-[var(--text)] border-b border-[var(--border)]">
          Folder variables — {folderPath || '(workspace root)'}
        </div>
        <div className="px-[15px] py-[14px] flex flex-col gap-2">
          <span className="text-[11.5px] text-[var(--muted)]">
            Defaults for notes created under this folder (nearest folder wins over a parent's).
          </span>
          <KeyValueRows entries={entries} onChange={setEntries} />
        </div>
        <div className="flex items-center gap-1.5 px-[15px] py-[9px] border-t border-[var(--border)] bg-[var(--panel-2)] justify-end">
          <button
            type="button"
            onClick={onCancel}
            className="px-3 py-1.5 text-[12.5px] text-[var(--text-2)] hover:text-[var(--text)] hover:bg-[var(--panel)] rounded-[5px] border border-[var(--border)] transition-colors"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleSave}
            className="px-3.5 py-1.5 text-[12.5px] font-medium bg-[var(--accent)] text-[var(--panel)] rounded-[5px] transition-colors shadow-sm"
          >
            Save
          </button>
        </div>
      </div>
    </div>
  );
};
