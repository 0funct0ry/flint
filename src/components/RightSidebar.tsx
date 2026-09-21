import React from 'react';
import { NoteFixture } from '../types';

export interface RightSidebarProps {
  note: NoteFixture;
  onNavigate: (path: string) => void;
}

export const RightSidebar: React.FC<RightSidebarProps> = ({ note, onNavigate }) => {
  const totalBacklinks = note.backlinks.reduce(
    (acc, b) => acc + b.occurrences.length,
    0
  );

  return (
    <aside className="w-[250px] shrink-0 flex flex-col bg-[var(--panel)] border-l border-[var(--border)] min-h-0 select-none">
      {/* Tabs */}
      <div className="flex h-[31px] shrink-0 border-b border-[var(--border)]" role="tablist">
        <button
          role="tab"
          aria-selected="true"
          className="px-3 text-[11.5px] tracking-wide text-[var(--text)] font-medium shadow-[inset_0_-2px_0_var(--accent)]"
        >
          Links
        </button>
      </div>

      <div className="flex-1 overflow-auto py-2 min-h-0">
        {/* Backlinks Section */}
        <div className="px-3 py-1.5 text-[11px] font-medium text-[var(--faint)]">
          Backlinks · {totalBacklinks} from {note.backlinks.length} {note.backlinks.length === 1 ? 'note' : 'notes'}
        </div>

        {note.backlinks.length === 0 ? (
          <div className="px-3 py-2 text-xs text-[var(--faint)] italic">
            No backlinks for this note.
          </div>
        ) : (
          note.backlinks.map((group) => (
            <div key={group.sourcePath} className="mb-2">
              <div className="flex items-baseline gap-1.5 px-3 pt-1.5 pb-0.5">
                <b
                  onClick={() => onNavigate(group.sourcePath)}
                  className="font-medium text-[12.5px] text-[var(--text)] hover:text-[var(--accent)] cursor-pointer truncate"
                >
                  {group.sourceTitle}
                </b>
                <i className="ml-auto not-italic text-[var(--faint)] text-[11px] font-mono">
                  {group.folder || 'root'}
                </i>
              </div>
              {group.occurrences.map((occ, idx) => (
                <a
                  key={idx}
                  href="#"
                  onClick={(e) => {
                    e.preventDefault();
                    onNavigate(group.sourcePath);
                  }}
                  className="block px-3 py-1 font-mono text-[11.5px] text-[var(--muted)] border-l-2 border-[var(--border)] ml-3 mb-1 hover:border-[var(--accent)] hover:text-[var(--text-2)] transition-colors truncate"
                >
                  {occ.context}
                </a>
              ))}
            </div>
          ))
        )}

        {/* Outgoing Links Section */}
        <div className="px-3 pt-3 pb-1.5 text-[11px] font-medium text-[var(--faint)]">
          Outgoing · {note.outgoingLinks.length}
        </div>

        {note.outgoingLinks.length === 0 ? (
          <div className="px-3 py-2 text-xs text-[var(--faint)] italic">
            No outgoing links.
          </div>
        ) : (
          note.outgoingLinks.map((link, idx) => {
            const isUnresolved = !link.resolved;
            return (
              <a
                key={idx}
                href="#"
                onClick={(e) => {
                  e.preventDefault();
                  if (link.resolved) {
                    onNavigate(link.resolved);
                  }
                }}
                className={`flex items-center gap-1.5 px-3 py-1 text-[12.5px] hover:bg-[var(--panel-2)] transition-colors truncate ${
                  isUnresolved ? 'text-[var(--spark)]' : 'text-[var(--text-2)]'
                }`}
                title={isUnresolved ? 'Unresolved link — click to create note' : undefined}
              >
                <span className="text-[var(--faint)] text-xs">◦</span>
                <span className="truncate">
                  {link.rawTarget.replace(/^\.\//, '')}
                  {isUnresolved && ' — create'}
                </span>
              </a>
            );
          })
        )}

        {/* Tags Section */}
        <div className="px-3 pt-3 pb-1.5 text-[11px] font-medium text-[var(--faint)]">
          Tags
        </div>
        {note.tags.length === 0 ? (
          <div className="px-3 py-2 text-xs text-[var(--faint)] italic">
            No tags.
          </div>
        ) : (
          note.tags.map((tag) => (
            <div
              key={tag}
              className="flex items-center gap-1.5 px-3 py-1 text-[12.5px] text-[var(--text-2)] hover:bg-[var(--panel-2)] cursor-pointer"
            >
              <span className="text-[var(--faint)] text-xs">#</span>
              <span>{tag}</span>
              <i className="ml-auto not-italic text-[var(--faint)] text-[11px] font-mono">
                1
              </i>
            </div>
          ))
        )}
      </div>
    </aside>
  );
};
