import React, { useEffect, useRef, useState } from 'react';
import { ResolvedTemplateVariable, TemplateMeta } from '../types';
import { api } from '../services/ipc';

export interface NewNoteModalProps {
  isOpen: boolean;
  targetFolder: string;
  initialName: string;
  defaultTemplatePath?: string | null;
  onCreate: (name: string, templatePath: string | undefined, variables: Record<string, string>) => void;
  onCancel: () => void;
}

const BLANK = '';

/**
 * New-note creation, reached only via "New Note from Template…" — the plain "New Note" context-
 * menu item bypasses this modal entirely and uses the fast inline-rename tree row instead. A
 * template with declared variables needs a form to fill in before the note can be created; the
 * template picker only ever lists what `.flint/templates/` actually has — authoring a new one is
 * the separate Templates management screen's job now, not this modal's.
 */
export const NewNoteModal: React.FC<NewNoteModalProps> = ({
  isOpen,
  targetFolder,
  initialName,
  defaultTemplatePath,
  onCreate,
  onCancel,
}) => {
  const [name, setName] = useState(initialName);
  const [templatePath, setTemplatePath] = useState<string>(defaultTemplatePath ?? BLANK);
  const [templates, setTemplates] = useState<TemplateMeta[]>([]);
  const [resolved, setResolved] = useState<ResolvedTemplateVariable[]>([]);
  const [values, setValues] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);

  const nameRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!isOpen) return;
    setName(initialName);
    setTemplatePath(defaultTemplatePath ?? BLANK);
    setError(null);
    api.templatesList().then(setTemplates).catch(() => setTemplates([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);

  useEffect(() => {
    if (isOpen) {
      nameRef.current?.focus();
      nameRef.current?.select();
    }
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;
    if (!templatePath) {
      setResolved([]);
      setValues({});
      return;
    }
    api
      .resolveNewNoteVariables(templatePath, targetFolder)
      .then((r) => {
        if (cancelled) return;
        setResolved(r);
        const initial: Record<string, string> = {};
        for (const item of r) initial[item.def.name] = item.resolvedDefault;
        setValues(initial);
      })
      .catch(() => {
        if (!cancelled) {
          setResolved([]);
          setValues({});
        }
      });
    return () => {
      cancelled = true;
    };
  }, [isOpen, templatePath, targetFolder]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (!isOpen) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        onCancel();
        return;
      }
      if (e.key === 'Tab') {
        const dialog = dialogRef.current;
        if (!dialog) return;
        const focusable = dialog.querySelectorAll<HTMLElement>(
          'button:not([disabled]), input:not([disabled]), select:not([disabled])'
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

  if (!isOpen) return null;

  const handleCreate = () => {
    const trimmed = name.trim();
    if (!trimmed) {
      setError('Name is required');
      return;
    }
    const missing = resolved.filter((r) => r.def.required && !(values[r.def.name] ?? '').trim());
    if (missing.length > 0) {
      setError(`Required: ${missing.map((m) => m.def.name).join(', ')}`);
      return;
    }
    onCreate(trimmed, templatePath || undefined, values);
  };

  return (
    <div
        className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-[1px]"
        onClick={(e) => {
          if (e.target === e.currentTarget) onCancel();
        }}
      >
        <div
          ref={dialogRef}
          role="dialog"
          aria-modal="true"
          aria-label="New note"
          className="w-[480px] max-w-[92vw] bg-[var(--panel)] border border-[var(--border)] rounded-[9px] shadow-[var(--shadow)] text-[13px] flex flex-col overflow-hidden"
        >
          <div className="px-[15px] py-[13px] text-[13.5px] font-medium text-[var(--text)] border-b border-[var(--border)]">
            New note
          </div>

          <div className="px-[15px] py-[14px] flex flex-col gap-3">
            <div className="flex flex-col gap-1">
              <label htmlFor="new-note-name" className="text-[11.5px] text-[var(--muted)]">
                Name
              </label>
              <input
                id="new-note-name"
                ref={nameRef}
                value={name}
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && resolved.length === 0) {
                    e.preventDefault();
                    handleCreate();
                  }
                }}
                className="text-[12.5px] px-[9px] py-[6px] text-[var(--text)] bg-[var(--canvas)] border border-[var(--border)] rounded-[5px]"
              />
            </div>

            <div className="flex flex-col gap-1">
              <label htmlFor="new-note-template" className="text-[11.5px] text-[var(--muted)]">
                Template
              </label>
              <select
                id="new-note-template"
                value={templatePath}
                onChange={(e) => setTemplatePath(e.target.value)}
                className="text-[12.5px] px-[9px] py-[6px] text-[var(--text)] bg-[var(--canvas)] border border-[var(--border)] rounded-[5px]"
              >
                <option value="">Blank</option>
                {templates.map((t) => (
                  <option key={t.path} value={t.path}>
                    {t.name}
                  </option>
                ))}
              </select>
              {templates.length === 0 && (
                <span className="text-[11px] text-[var(--faint)]">
                  No templates yet — create one from Settings → Templates → Manage templates.
                </span>
              )}
            </div>

            {resolved.length > 0 && (
              <div className="flex flex-col gap-2 border-t border-[var(--border)] pt-2.5">
                {resolved.map((r) => (
                  <div key={r.def.name} className="flex flex-col gap-1">
                    <label htmlFor={`var-${r.def.name}`} className="text-[11.5px] text-[var(--muted)]">
                      {r.def.name}
                      {r.def.required && <span className="text-[var(--accent)]"> *</span>}
                    </label>
                    {r.def.kind === 'bool' ? (
                      <input
                        id={`var-${r.def.name}`}
                        type="checkbox"
                        checked={values[r.def.name] === 'true'}
                        onChange={(e) =>
                          setValues((v) => ({ ...v, [r.def.name]: e.target.checked ? 'true' : 'false' }))
                        }
                      />
                    ) : r.def.kind === 'choice' ? (
                      <select
                        id={`var-${r.def.name}`}
                        value={values[r.def.name] ?? ''}
                        onChange={(e) => setValues((v) => ({ ...v, [r.def.name]: e.target.value }))}
                        className="text-[12.5px] px-[9px] py-[6px] text-[var(--text)] bg-[var(--canvas)] border border-[var(--border)] rounded-[5px]"
                      >
                        {r.def.options.map((o) => (
                          <option key={o} value={o}>
                            {o}
                          </option>
                        ))}
                      </select>
                    ) : r.def.kind === 'date' ? (
                      <input
                        id={`var-${r.def.name}`}
                        type="date"
                        value={values[r.def.name] ?? ''}
                        onChange={(e) => setValues((v) => ({ ...v, [r.def.name]: e.target.value }))}
                        className="text-[12.5px] px-[9px] py-[6px] text-[var(--text)] bg-[var(--canvas)] border border-[var(--border)] rounded-[5px]"
                      />
                    ) : (
                      <input
                        id={`var-${r.def.name}`}
                        value={values[r.def.name] ?? ''}
                        onChange={(e) => setValues((v) => ({ ...v, [r.def.name]: e.target.value }))}
                        className="text-[12.5px] px-[9px] py-[6px] text-[var(--text)] bg-[var(--canvas)] border border-[var(--border)] rounded-[5px]"
                      />
                    )}
                  </div>
                ))}
              </div>
            )}

            {error && (
              <div role="alert" className="text-[11.5px] text-[var(--danger,#d33)]">
                {error}
              </div>
            )}
          </div>

          <div className="flex items-center gap-3.5 px-[15px] py-[9px] border-t border-[var(--border)] bg-[var(--panel-2)]">
            <span className="flex gap-3 text-[11px] text-[var(--faint)]">
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
                onClick={handleCreate}
                className="px-3.5 py-1.5 text-[12.5px] font-medium bg-[var(--accent)] text-[var(--panel)] rounded-[5px] transition-colors shadow-sm"
              >
                Create
              </button>
            </span>
          </div>
        </div>
      </div>
  );
};
