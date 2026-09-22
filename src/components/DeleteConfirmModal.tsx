import React, { useEffect, useRef } from 'react';

export interface DeleteConfirmModalProps {
  isOpen: boolean;
  title?: string;
  message: string;
  itemName: string;
  isFolder?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export const DeleteConfirmModal: React.FC<DeleteConfirmModalProps> = ({
  isOpen,
  title = 'Permanently Delete',
  message,
  itemName,
  isFolder = false,
  onConfirm,
  onCancel,
}) => {
  const confirmBtnRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (isOpen) {
      confirmBtnRef.current?.focus();
    }
  }, [isOpen]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (!isOpen) return;
      if (e.key === 'Escape') {
        onCancel();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onCancel]);

  if (!isOpen) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="modal-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-[1px] animate-in fade-in duration-100"
    >
      <div className="w-[420px] bg-[var(--panel)] border border-[var(--border)] rounded-[8px] shadow-[var(--shadow)] p-5 text-[13px] select-none flex flex-col gap-4">
        <div>
          <h2 id="modal-title" className="text-[14.5px] font-semibold text-[var(--text)]">
            {title}
          </h2>
          <p className="mt-2 text-[var(--text-2)] leading-relaxed">
            {message}
          </p>
          <div className="mt-2 px-2.5 py-1.5 bg-[var(--canvas)] border border-[var(--border)] rounded font-mono text-[12px] text-[var(--text)] truncate">
            {itemName}
          </div>
          {isFolder && (
            <p className="mt-2 text-[11.5px] text-[#e06c75]">
              Warning: All files and nested folders inside this directory will be permanently erased.
            </p>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 pt-2 border-t border-[var(--border)]">
          <button
            onClick={onCancel}
            className="px-3 py-1.5 text-[12.5px] text-[var(--text-2)] hover:text-[var(--text)] hover:bg-[var(--panel-2)] rounded-[5px] transition-colors"
          >
            Cancel
          </button>
          <button
            ref={confirmBtnRef}
            onClick={onConfirm}
            className="px-3.5 py-1.5 text-[12.5px] font-medium bg-[#e06c75] text-white hover:bg-[#d05c65] rounded-[5px] transition-colors shadow-sm"
          >
            Delete Permanently
          </button>
        </div>
      </div>
    </div>
  );
};
