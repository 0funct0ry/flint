import React from 'react';
import { NoteFixture } from '../types';

export interface RightSidebarProps {
  note: NoteFixture;
  onNavigate: (path: string) => void;
  onCreateNote?: (path: string) => void;
  onOpenExternal?: (url: string) => void;
  onClose?: () => void;
}

export const RightSidebar: React.FC<RightSidebarProps> = ({
  note,
  onNavigate,
  onCreateNote,
  onOpenExternal,
  onClose,
}) => {
  const totalBacklinks = note.backlinks.reduce(
    (acc, b) => acc + b.occurrences.length,
    0
  );

  return (
    <aside className="w-[250px] shrink-0 flex flex-col bg-[var(--panel)] border-l border-[var(--border)] min-h-0 select-none">
      {/* Tabs */}
      <div className="flex items-center h-[31px] shrink-0 border-b border-[var(--border)]" role="tablist">
        <button
          role="tab"
          aria-selected="true"
          className="px-3 h-full text-[11.5px] tracking-wide text-[var(--text)] font-medium shadow-[inset_0_-2px_0_var(--accent)]"
        >
          Links
        </button>

        {onClose && (
          <button
            onClick={onClose}
            className="ml-auto mr-1.5 w-5 h-5 flex items-center justify-center rounded text-[var(--muted)] hover:bg-[var(--panel-2)] hover:text-[var(--text)] transition-colors text-xs font-semibold"
            title="Collapse sidebar (⌘⌥B)"
            aria-label="Collapse sidebar"
          >
            -
          </button>
        )}
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
          note.backlinks.map((group) => {
            const sourcePath = group.source_path || group.sourcePath || '';
            const sourceTitle = group.source_title || group.sourceTitle || sourcePath;
            return (
              <div key={sourcePath} className="mb-2">
                <div className="flex items-baseline gap-1.5 px-3 pt-1.5 pb-0.5">
                  <b
                    onClick={() => onNavigate(sourcePath)}
                    className="font-medium text-[12.5px] text-[var(--text)] hover:text-[var(--accent)] cursor-pointer truncate"
                    title={sourcePath}
                  >
                    {sourceTitle}
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
                      onNavigate(sourcePath);
                    }}
                    className="block px-3 py-1 font-mono text-[11.5px] text-[var(--muted)] border-l-2 border-[var(--border)] ml-3 mb-1 hover:border-[var(--accent)] hover:text-[var(--text-2)] transition-colors truncate"
                    title={`Line ${occ.line}: ${occ.context}`}
                  >
                    <span className="text-[var(--faint)] mr-1.5 text-[10px]">L{occ.line}</span>
                    {occ.context}
                  </a>
                ))}
              </div>
            );
          })
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
            const rawTarget = link.raw_target || link.rawTarget || '';
            const isExternal =
              rawTarget.startsWith('http://') ||
              rawTarget.startsWith('https://') ||
              rawTarget.startsWith('mailto:');
            const isUnresolved = !isExternal && !link.resolved;

            return (
              <a
                key={idx}
                href="#"
                onClick={(e) => {
                  e.preventDefault();
                  if (isExternal) {
                    if (onOpenExternal) onOpenExternal(rawTarget);
                  } else if (link.resolved) {
                    onNavigate(link.resolved);
                  } else if (onCreateNote) {
                    // Create broken note target
                    const cleanPath = rawTarget
                      .split('#')[0]
                      .replace(/^\.\//, '');
                    const withExt = cleanPath.endsWith('.md')
                      ? cleanPath
                      : `${cleanPath}.md`;
                    const folder = note.path.split('/').slice(0, -1).join('/');
                    const targetPath = folder ? `${folder}/${withExt}` : withExt;
                    onCreateNote(targetPath);
                  }
                }}
                className={`flex items-center gap-1.5 px-3 py-1 text-[12.5px] hover:bg-[var(--panel-2)] transition-colors truncate ${
                  isUnresolved ? 'text-[var(--spark)]' : 'text-[var(--text-2)]'
                }`}
                title={
                  isExternal
                    ? `Open ${rawTarget} in browser`
                    : isUnresolved
                    ? 'Unresolved link — click to create note'
                    : `Go to ${link.resolved}`
                }
              >
                <span className="text-[var(--faint)] text-xs">
                  {isExternal ? '↗' : '◦'}
                </span>
                <span className="truncate">
                  {rawTarget.replace(/^\.\//, '')}
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
