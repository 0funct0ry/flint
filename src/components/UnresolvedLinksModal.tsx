import React, { useState } from 'react';
import { LinkItem } from '../types';

export interface UnresolvedLinksModalProps {
  isOpen: boolean;
  onClose: () => void;
  unresolvedLinks: LinkItem[];
  onNavigateToSource: (sourcePath: string) => void;
  onCreateMissingNote: (rawTarget: string, sourcePath: string) => void;
}

export const UnresolvedLinksModal: React.FC<UnresolvedLinksModalProps> = ({
  isOpen,
  onClose,
  unresolvedLinks,
  onNavigateToSource,
  onCreateMissingNote,
}) => {
  const [filter, setFilter] = useState('');

  if (!isOpen) return null;

  const filteredLinks = unresolvedLinks.filter(
    (l) =>
      l.source.toLowerCase().includes(filter.toLowerCase()) ||
      (l.raw_target || l.rawTarget || '').toLowerCase().includes(filter.toLowerCase()) ||
      l.context.toLowerCase().includes(filter.toLowerCase())
  );

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-[1px] select-none"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      role="dialog"
      aria-modal="true"
      aria-labelledby="unresolved-modal-title"
    >
      <div className="flex flex-col w-[600px] max-h-[80vh] bg-[var(--panel)] border border-[var(--border)] rounded-none text-[var(--text)] overflow-hidden shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-[var(--border)] bg-[var(--panel-2)]">
          <div className="flex items-center gap-2">
            <span className="text-[var(--spark)] text-base font-bold">⚡</span>
            <h2 id="unresolved-modal-title" className="text-sm font-semibold tracking-wide">
              Unresolved Links ({unresolvedLinks.length})
            </h2>
          </div>
          <button
            onClick={onClose}
            className="text-xs text-[var(--muted)] hover:text-[var(--text)] px-2 py-1 bg-transparent border-0 cursor-pointer"
          >
            ✕ Esc
          </button>
        </div>

        {/* Filter input */}
        <div className="px-4 py-2 border-b border-[var(--border)] bg-[var(--panel)]">
          <input
            type="text"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter unresolved links..."
            autoFocus
            className="w-full bg-[var(--canvas)] border border-[var(--border)] px-3 py-1.5 text-xs text-[var(--text)] outline-none focus:border-[var(--accent)] font-mono"
          />
        </div>

        {/* Links list */}
        <div className="flex-1 overflow-y-auto divide-y divide-[var(--border)] p-1">
          {filteredLinks.length === 0 ? (
            <div className="py-8 text-center text-xs text-[var(--faint)] italic">
              {unresolvedLinks.length === 0
                ? 'No unresolved links in workspace!'
                : 'No matching unresolved links.'}
            </div>
          ) : (
            filteredLinks.map((link, idx) => {
              const rawTarget = link.raw_target || link.rawTarget || '';
              return (
                <div
                  key={`${link.source}-${link.line}-${idx}`}
                  className="p-3 hover:bg-[var(--panel-2)] transition-colors flex flex-col gap-1.5"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs font-mono font-medium text-[var(--spark)] truncate">
                      {rawTarget}
                    </span>
                    <div className="flex items-center gap-2 shrink-0">
                      <button
                        onClick={() => {
                          onCreateMissingNote(rawTarget, link.source);
                          onClose();
                        }}
                        className="text-[11px] px-2 py-0.5 bg-[var(--accent)] hover:opacity-90 text-white font-medium cursor-pointer border-0"
                      >
                        Create Note
                      </button>
                      <button
                        onClick={() => {
                          onNavigateToSource(link.source);
                          onClose();
                        }}
                        className="text-[11px] px-2 py-0.5 bg-[var(--border)] hover:bg-[var(--faint)] text-[var(--text)] font-mono cursor-pointer border-0"
                      >
                        Open Source
                      </button>
                    </div>
                  </div>

                  <div className="flex items-center gap-2 text-[11px] text-[var(--muted)] font-mono">
                    <span className="text-[var(--text-2)]">{link.source}</span>
                    <span className="text-[var(--faint)]">:</span>
                    <span className="text-[var(--faint)]">Line {link.line}</span>
                  </div>

                  {link.context && (
                    <div className="text-[11.5px] font-mono text-[var(--muted)] bg-[var(--canvas)] px-2.5 py-1 border-l-2 border-[var(--spark)] truncate">
                      {link.context}
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-4 py-2 border-t border-[var(--border)] bg-[var(--panel-2)] text-[11px] text-[var(--faint)] font-mono">
          <span>Clicking "Create Note" generates a new note matching the target path.</span>
          <button
            onClick={onClose}
            className="px-3 py-1 bg-[var(--panel)] border border-[var(--border)] text-xs text-[var(--text)] hover:bg-[var(--border)] cursor-pointer"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
};
