import React from 'react';

export interface ConflictBannerProps {
  visible: boolean;
  onKeepVersion: () => void;
  onLoadFromDisk: () => void;
  onShowDifferences: () => void;
}

export const ConflictBanner: React.FC<ConflictBannerProps> = ({
  visible,
  onKeepVersion,
  onLoadFromDisk,
  onShowDifferences,
}) => {
  if (!visible) return null;

  return (
    <div
      className="flex items-center gap-3 px-3.5 py-2 text-[12.5px] bg-[var(--accent-soft)] border-b border-[var(--border)] text-[var(--text-2)]"
      role="alert"
      data-testid="conflict-banner"
    >
      <b className="font-medium text-[var(--text)]">This note changed on disk.</b>
      <span>Your unsaved edits have not been overwritten.</span>
      <div className="ml-auto flex items-center gap-1.5">
        <button
          onClick={onKeepVersion}
          className="px-2.5 py-0.5 border border-[var(--border)] rounded text-xs bg-[var(--panel)] text-[var(--text)] hover:bg-[var(--panel-2)] transition-colors"
        >
          Keep my version
        </button>
        <button
          onClick={onLoadFromDisk}
          className="px-2.5 py-0.5 border border-[var(--border)] rounded text-xs bg-[var(--panel)] text-[var(--text)] hover:bg-[var(--panel-2)] transition-colors"
        >
          Load from disk
        </button>
        <button
          onClick={onShowDifferences}
          className="px-2.5 py-0.5 border border-[var(--border)] rounded text-xs bg-[var(--panel)] text-[var(--text)] hover:bg-[var(--panel-2)] transition-colors"
        >
          Show differences
        </button>
      </div>
    </div>
  );
};
