import React from 'react';

export interface DiffViewerProps {
  isOpen: boolean;
  onClose: () => void;
  notePath: string;
  bufferContent: string;
  diskContent: string;
  onKeepVersion: () => void;
  onLoadFromDisk: () => void;
}

interface DiffLine {
  type: 'same' | 'added' | 'removed';
  leftLineNum?: number;
  rightLineNum?: number;
  leftText?: string;
  rightText?: string;
}

/**
 * Compute a basic line-by-line diff for review between buffer and disk
 */
function computeDiff(bufferStr: string, diskStr: string): DiffLine[] {
  const bufferLines = bufferStr.replace(/\\n/g, '\n').split(/\r?\n/);
  const diskLines = diskStr.replace(/\\n/g, '\n').split(/\r?\n/);

  const diff: DiffLine[] = [];

  // Simple line alignment comparison
  let bIdx = 0;
  let dIdx = 0;

  while (bIdx < bufferLines.length || dIdx < diskLines.length) {
    const bLine = bIdx < bufferLines.length ? bufferLines[bIdx] : undefined;
    const dLine = dIdx < diskLines.length ? diskLines[dIdx] : undefined;

    if (bLine === dLine) {
      diff.push({
        type: 'same',
        leftLineNum: bIdx + 1,
        rightLineNum: dIdx + 1,
        leftText: bLine,
        rightText: dLine,
      });
      bIdx++;
      dIdx++;
    } else {
      // Show differences
      if (bLine !== undefined && dLine !== undefined) {
        diff.push({
          type: 'removed',
          leftLineNum: bIdx + 1,
          rightLineNum: dIdx + 1,
          leftText: bLine,
          rightText: dLine,
        });
        bIdx++;
        dIdx++;
      } else if (bLine !== undefined) {
        diff.push({
          type: 'added',
          leftLineNum: bIdx + 1,
          leftText: bLine,
        });
        bIdx++;
      } else if (dLine !== undefined) {
        diff.push({
          type: 'removed',
          rightLineNum: dIdx + 1,
          rightText: dLine,
        });
        dIdx++;
      }
    }
  }

  return diff;
}

export const DiffViewer: React.FC<DiffViewerProps> = ({
  isOpen,
  onClose,
  notePath,
  bufferContent,
  diskContent,
  onKeepVersion,
  onLoadFromDisk,
}) => {
  if (!isOpen) return null;

  const diffLines = computeDiff(bufferContent, diskContent);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-[1px] select-none p-6"
      role="dialog"
      aria-modal="true"
      aria-label="Difference Viewer"
    >
      <div className="flex flex-col w-full max-w-5xl h-[80vh] bg-[var(--panel)] border border-[var(--border)] rounded-none shadow-2xl overflow-hidden font-ui">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-2.5 border-b border-[var(--border)] bg-[var(--canvas)]">
          <div className="flex items-center gap-2">
            <span className="font-semibold text-xs text-[var(--text)]">Diff Comparison:</span>
            <span className="font-mono text-xs text-[var(--muted)]">{notePath}</span>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => {
                onKeepVersion();
                onClose();
              }}
              className="px-3 py-1 text-xs rounded border border-[var(--border)] bg-[var(--panel)] text-[var(--text)] hover:bg-[var(--panel-2)] transition-colors"
            >
              Keep Buffer Version
            </button>
            <button
              onClick={() => {
                onLoadFromDisk();
                onClose();
              }}
              className="px-3 py-1 text-xs rounded border border-[var(--border)] bg-[var(--accent)] text-white hover:opacity-90 transition-opacity"
            >
              Load Version from Disk
            </button>
            <button
              onClick={onClose}
              className="ml-2 w-6 h-6 flex items-center justify-center text-[var(--muted)] hover:text-[var(--text)] rounded text-sm"
              aria-label="Close diff viewer"
            >
              ✕
            </button>
          </div>
        </div>

        {/* Column Labels */}
        <div className="grid grid-cols-2 text-xs font-mono font-medium border-b border-[var(--border)] bg-[var(--panel-2)] text-[var(--muted)] px-3 py-1.5">
          <div>Your Buffer Version (unsaved edits)</div>
          <div>Disk Version (modified externally)</div>
        </div>

        {/* Diff Content Side-by-side */}
        <div className="flex-1 overflow-auto font-mono text-xs leading-relaxed divide-y divide-[var(--border)]/40">
          {diffLines.map((line, idx) => {
            const isDiff = line.type !== 'same';
            return (
              <div
                key={idx}
                className={`grid grid-cols-2 divide-x divide-[var(--border)] ${
                  isDiff ? 'bg-[var(--accent-soft)]' : ''
                }`}
              >
                {/* Left (Buffer) */}
                <div className="flex items-start gap-2 px-2 py-0.5 min-w-0">
                  <span className="w-8 shrink-0 text-right text-[10px] text-[var(--faint)] select-none">
                    {line.leftLineNum ?? ''}
                  </span>
                  <span className="text-[var(--text)] whitespace-pre-wrap break-all flex-1">
                    {line.leftText ?? ''}
                  </span>
                </div>

                {/* Right (Disk) */}
                <div className="flex items-start gap-2 px-2 py-0.5 min-w-0">
                  <span className="w-8 shrink-0 text-right text-[10px] text-[var(--faint)] select-none">
                    {line.rightLineNum ?? ''}
                  </span>
                  <span className="text-[var(--text)] whitespace-pre-wrap break-all flex-1">
                    {line.rightText ?? ''}
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
};
