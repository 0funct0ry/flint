import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  buildTableMarkdown,
  clampCols,
  clampRows,
  ColumnAlignment,
  MAX_COLS,
  MAX_ROWS,
  MIN_COLS,
  MIN_ROWS,
} from '../commands/tableBuilder';

export interface TableBuilderInitial {
  headers: string[];
  alignments: ColumnAlignment[];
  bodyRowCount: number;
  detectedDelimiter?: 'pipe' | 'tab' | 'comma';
}

export interface TableBuilderModalProps {
  isOpen: boolean;
  initial: TableBuilderInitial;
  onInsert: (markdown: string, replaceSelection: boolean) => void;
  onCancel: () => void;
}

const ALIGNMENTS: { value: ColumnAlignment; label: string; title: string }[] = [
  { value: 'none', label: '≡', title: 'None' },
  { value: 'left', label: '⇤', title: 'Left' },
  { value: 'center', label: '↔', title: 'Center' },
  { value: 'right', label: '⇥', title: 'Right' },
];

const DELIMITER_LABEL: Record<'pipe' | 'tab' | 'comma', string> = {
  pipe: 'pipe-delimited',
  tab: 'tab-delimited',
  comma: 'comma-delimited',
};

export const TableBuilderModal: React.FC<TableBuilderModalProps> = ({ isOpen, initial, onInsert, onCancel }) => {
  const [rows, setRows] = useState(initial.bodyRowCount);
  const [headers, setHeaders] = useState(initial.headers);
  const [alignments, setAlignments] = useState(initial.alignments);
  const [noticeVisible, setNoticeVisible] = useState(!!initial.detectedDelimiter);
  const [hasPrefill, setHasPrefill] = useState(!!initial.detectedDelimiter);

  const firstHeaderRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const insertRef = useRef<() => void>(() => {});

  useEffect(() => {
    if (!isOpen) return;
    setRows(initial.bodyRowCount);
    setHeaders(initial.headers);
    setAlignments(initial.alignments);
    setNoticeVisible(!!initial.detectedDelimiter);
    setHasPrefill(!!initial.detectedDelimiter);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);

  useEffect(() => {
    if (isOpen) {
      firstHeaderRef.current?.focus();
      firstHeaderRef.current?.select();
    }
  }, [isOpen]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (!isOpen) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        onCancel();
        return;
      }
      if (e.key === 'Enter' && (e.target as HTMLElement)?.tagName === 'INPUT') {
        e.preventDefault();
        insertRef.current();
        return;
      }
      if (e.key === 'Tab') {
        const dialog = dialogRef.current;
        if (!dialog) return;
        const focusable = dialog.querySelectorAll<HTMLElement>(
          'button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])'
        );
        if (focusable.length === 0) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onCancel]);

  const cols = headers.length;

  const preview = useMemo(() => buildTableMarkdown(headers, alignments, rows), [headers, alignments, rows]);

  if (!isOpen) return null;

  const setColCount = (n: number) => {
    const next = clampCols(n);
    setHeaders((prev) => {
      const copy = prev.slice(0, next);
      while (copy.length < next) copy.push('');
      return copy;
    });
    setAlignments((prev) => {
      const copy = prev.slice(0, next);
      while (copy.length < next) copy.push('none');
      return copy;
    });
  };

  const setHeader = (i: number, value: string) => {
    setHeaders((prev) => prev.map((h, idx) => (idx === i ? value : h)));
  };

  const setAlignment = (i: number, value: ColumnAlignment) => {
    setAlignments((prev) => prev.map((a, idx) => (idx === i ? value : a)));
  };

  const handleInsert = () => {
    onInsert(preview, hasPrefill);
  };
  insertRef.current = handleInsert;

  const startBlank = () => {
    setNoticeVisible(false);
    setHasPrefill(false);
    setRows(1);
    setColCount(2);
    setHeaders(['', '']);
    setAlignments(['none', 'none']);
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-[1px] animate-in fade-in duration-100"
      onClick={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="Insert table"
        className="w-[560px] max-w-[92vw] bg-[var(--panel)] border border-[var(--border)] rounded-[9px] shadow-[var(--shadow)] text-[13px] flex flex-col overflow-hidden"
      >
        <div className="px-[15px] py-[13px] text-[13.5px] font-medium text-[var(--text)] border-b border-[var(--border)]">
          Insert table
        </div>

        <div className="px-[15px] py-[14px] flex flex-col gap-3">
          {noticeVisible && initial.detectedDelimiter && (
            <div className="flex items-center gap-2 px-[9px] py-[6px] text-[11.5px] text-[var(--text-2)] bg-[var(--accent-soft)] rounded-[5px]">
              <span>
                Detected {cols} columns from your {DELIMITER_LABEL[initial.detectedDelimiter]} selection.
              </span>
              <button
                type="button"
                onClick={startBlank}
                className="ml-auto text-[var(--accent)] underline"
              >
                Start blank instead
              </button>
            </div>
          )}

          <div className="flex items-center gap-3.5 flex-wrap">
            <div className="flex items-center gap-1.5 text-[12px] text-[var(--muted)]">
              Rows
              <div className="flex items-center border border-[var(--border)] rounded-[5px] overflow-hidden">
                <button
                  type="button"
                  aria-label="Fewer rows"
                  disabled={rows <= MIN_ROWS}
                  onClick={() => setRows((r) => clampRows(r - 1))}
                  className="w-[22px] h-[22px] text-[var(--muted)] disabled:opacity-40"
                >
                  −
                </button>
                <input
                  aria-label="Row count"
                  value={rows}
                  onChange={(e) => setRows(clampRows(parseInt(e.target.value, 10)))}
                  className="w-[34px] text-center text-[12.5px] text-[var(--text)] bg-transparent border-x border-[var(--border)]"
                />
                <button
                  type="button"
                  aria-label="More rows"
                  disabled={rows >= MAX_ROWS}
                  onClick={() => setRows((r) => clampRows(r + 1))}
                  className="w-[22px] h-[22px] text-[var(--muted)] disabled:opacity-40"
                >
                  +
                </button>
              </div>
            </div>

            <div className="flex items-center gap-1.5 text-[12px] text-[var(--muted)]">
              Columns
              <div className="flex items-center border border-[var(--border)] rounded-[5px] overflow-hidden">
                <button
                  type="button"
                  aria-label="Fewer columns"
                  disabled={cols <= MIN_COLS}
                  onClick={() => setColCount(cols - 1)}
                  className="w-[22px] h-[22px] text-[var(--muted)] disabled:opacity-40"
                >
                  −
                </button>
                <input
                  aria-label="Column count"
                  value={cols}
                  onChange={(e) => setColCount(parseInt(e.target.value, 10))}
                  className="w-[34px] text-center text-[12.5px] text-[var(--text)] bg-transparent border-x border-[var(--border)]"
                />
                <button
                  type="button"
                  aria-label="More columns"
                  disabled={cols >= MAX_COLS}
                  onClick={() => setColCount(cols + 1)}
                  className="w-[22px] h-[22px] text-[var(--muted)] disabled:opacity-40"
                >
                  +
                </button>
              </div>
            </div>

            {(rows >= MAX_ROWS || cols >= MAX_COLS) && (
              <span className="text-[11px] text-[var(--faint)]">
                Capped at {MAX_ROWS} rows × {MAX_COLS} columns.
              </span>
            )}
          </div>

          <div className="grid gap-1.5" style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}>
            {headers.map((h, i) => (
              <div key={i} className="flex flex-col gap-1">
                <input
                  ref={i === 0 ? firstHeaderRef : undefined}
                  value={h}
                  placeholder={`Column ${i + 1}`}
                  aria-label={`Header ${i + 1}`}
                  onChange={(e) => setHeader(i, e.target.value)}
                  className="font-inherit text-[12px] px-[7px] py-[4px] text-[var(--text)] bg-[var(--canvas)] border border-[var(--border)] rounded-[4px]"
                />
                <div
                  role="group"
                  aria-label={`Alignment for column ${i + 1}`}
                  className="flex border border-[var(--border)] rounded-[5px] overflow-hidden self-start"
                >
                  {ALIGNMENTS.map((a) => (
                    <button
                      key={a.value}
                      type="button"
                      title={a.title}
                      aria-pressed={alignments[i] === a.value}
                      onClick={() => setAlignment(i, a.value)}
                      className={`px-2 py-0.5 text-[12px] border-l border-[var(--border)] first:border-l-0 ${
                        alignments[i] === a.value
                          ? 'bg-[var(--accent-soft)] text-[var(--accent)]'
                          : 'text-[var(--muted)]'
                      }`}
                    >
                      {a.label}
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>

          <pre className="font-mono text-[11.5px] leading-[1.6] text-[var(--text-2)] bg-[var(--panel-2)] border border-[var(--border)] rounded-[6px] px-[11px] py-[9px] whitespace-pre overflow-auto max-h-[130px]">
            {preview}
          </pre>
        </div>

        <div className="flex items-center gap-3.5 px-[15px] py-[9px] border-t border-[var(--border)] bg-[var(--panel-2)]">
          <span className="flex gap-3 text-[11px] text-[var(--faint)]">
            <span>↵ to insert</span>
            <span>esc to cancel</span>
          </span>
          <span className="ml-auto flex gap-1.5">
            <button
              type="button"
              onClick={onCancel}
              className="px-3 py-1.5 text-[12.5px] text-[var(--text-2)] hover:text-[var(--text)] hover:bg-[var(--panel)] rounded-[5px] border border-[var(--border)] transition-colors"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleInsert}
              className="px-3.5 py-1.5 text-[12.5px] font-medium bg-[var(--accent)] text-[var(--panel)] rounded-[5px] transition-colors shadow-sm"
            >
              Insert
            </button>
          </span>
        </div>
      </div>
    </div>
  );
};
