import React from 'react';

export interface StatusBarProps {
  workspaceName: string;
  noteCount: number;
  linkCount: number;
  unresolvedCount: number;
  cursorLine?: number;
  cursorCol?: number;
  indexingProgress?: { indexed: number; total: number } | null;
  isWatcherDegraded?: boolean;
  onClickUnresolved?: () => void;
}

export const StatusBar: React.FC<StatusBarProps> = ({
  workspaceName,
  noteCount,
  linkCount,
  unresolvedCount,
  cursorLine = 1,
  cursorCol = 1,
  indexingProgress = null,
  isWatcherDegraded = false,
  onClickUnresolved,
}) => {
  return (
    <footer className="flex items-center gap-3.5 h-6 shrink-0 px-3 border-t border-[var(--border)] bg-[var(--panel-2)] text-[11.5px] text-[var(--muted)] font-mono select-none">
      <span className="text-[var(--text-2)] font-medium">{workspaceName}</span>
      <span>{noteCount.toLocaleString()} notes</span>
      <span>{linkCount.toLocaleString()} links</span>
      {unresolvedCount > 0 ? (
        <button
          onClick={onClickUnresolved}
          className="text-[var(--spark)] hover:underline cursor-pointer bg-transparent border-0 p-0 font-mono text-[11.5px]"
          title="Click to view all unresolved links"
        >
          {unresolvedCount} unresolved
        </button>
      ) : (
        <span>0 unresolved</span>
      )}

      {indexingProgress && (
        <div className="flex items-center gap-1.5 text-[var(--accent)] text-[11px]">
          <span className="animate-spin inline-block">◐</span>
          <span>
            Indexing {indexingProgress.indexed} / {indexingProgress.total}
          </span>
        </div>
      )}

      <div className="ml-auto flex items-center gap-3.5">
        <span>
          Ln {cursorLine}, Col {cursorCol}
        </span>
        <span>Markdown</span>
        <span>UTF-8</span>
        <span>LF</span>
        {isWatcherDegraded ? (
          <span
            className="text-[var(--spark)] flex items-center gap-1"
            title="Native filesystem watcher unavailable. Falling back to 5s polling."
          >
            ⚠️ polling (degraded)
          </span>
        ) : (
          <span className="text-[var(--faint)]" title="Watching the filesystem">
            watching
          </span>
        )}
      </div>
    </footer>
  );
};

