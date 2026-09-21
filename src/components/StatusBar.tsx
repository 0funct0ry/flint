import React from 'react';

export interface StatusBarProps {
  workspaceName: string;
  noteCount: number;
  linkCount: number;
  unresolvedCount: number;
  cursorLine?: number;
  cursorCol?: number;
}

export const StatusBar: React.FC<StatusBarProps> = ({
  workspaceName,
  noteCount,
  linkCount,
  unresolvedCount,
  cursorLine = 1,
  cursorCol = 1,
}) => {
  return (
    <footer className="flex items-center gap-3.5 h-6 shrink-0 px-3 border-t border-[var(--border)] bg-[var(--panel-2)] text-[11.5px] text-[var(--muted)] font-mono select-none">
      <span className="text-[var(--text-2)] font-medium">{workspaceName}</span>
      <span>{noteCount.toLocaleString()} notes</span>
      <span>{linkCount.toLocaleString()} links</span>
      {unresolvedCount > 0 ? (
        <span className="text-[var(--spark)]">{unresolvedCount} unresolved</span>
      ) : (
        <span>0 unresolved</span>
      )}

      <div className="ml-auto flex items-center gap-3.5">
        <span>
          Ln {cursorLine}, Col {cursorCol}
        </span>
        <span>Markdown</span>
        <span>UTF-8</span>
        <span>LF</span>
        <span className="text-[var(--faint)]" title="Watching the filesystem">
          watching
        </span>
      </div>
    </footer>
  );
};
