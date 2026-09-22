import React from 'react';

export interface ToastMessage {
  id: string;
  message: string;
  actionLabel?: string;
  onAction?: () => void;
  duration?: number;
}

export interface ToastProps {
  toasts: ToastMessage[];
  onDismiss: (id: string) => void;
}

export const Toast: React.FC<ToastProps> = ({ toasts, onDismiss }) => {
  if (toasts.length === 0) return null;

  return (
    <div className="fixed bottom-8 right-6 z-50 flex flex-col gap-2 pointer-events-none select-none">
      {toasts.map((toast) => (
        <div
          key={toast.id}
          className="pointer-events-auto flex items-center gap-3 px-3.5 py-2 bg-[var(--panel)] border border-[var(--border)] rounded-[6px] shadow-[var(--shadow)] text-[12.5px] text-[var(--text)] animate-in slide-in-from-bottom-2 fade-in duration-150 max-w-md"
        >
          <span className="truncate">{toast.message}</span>
          {toast.actionLabel && toast.onAction && (
            <button
              onClick={() => {
                toast.onAction?.();
                onDismiss(toast.id);
              }}
              className="px-2 py-0.5 font-medium text-[var(--accent)] hover:bg-[var(--accent-soft)] rounded transition-colors text-[12px] shrink-0"
            >
              {toast.actionLabel}
            </button>
          )}
          <button
            onClick={() => onDismiss(toast.id)}
            className="text-[var(--faint)] hover:text-[var(--text)] text-xs ml-1"
            aria-label="Dismiss toast"
          >
            ✕
          </button>
        </div>
      ))}
    </div>
  );
};
