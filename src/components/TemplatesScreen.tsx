import React, { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../services/ipc';
import { TemplateMeta, TemplateVariableDef } from '../types';
import { TemplateForm } from './TemplateForm';
import { slugify } from '../services/markdown';

const TrashIcon: React.FC = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <path d="M3 6h18" />
    <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
    <line x1="10" x2="10" y1="11" y2="17" />
    <line x1="14" x2="14" y1="11" y2="17" />
  </svg>
);

const PencilIcon: React.FC = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
    <path d="m15 5 4 4" />
  </svg>
);

export interface TemplatesScreenProps {
  onClose: () => void;
  /** Jump straight into the create form on open (e.g. the "New template…" command/context-menu
   * item) instead of landing on the plain list. */
  initialCreate?: boolean;
  /** Jump straight into editing this template's variables on open (e.g. the tree's "Edit template
   * variables…" item). Path relative to `.flint/templates/`. */
  initialEditPath?: string;
}

/** A brand-new template starts with just a title heading — no per-variable placeholder lines are
 * auto-generated into the body anymore; the user adds `{{ var.name }}` references themselves, with
 * the body editor's completion helping them do it. */
const DEFAULT_NEW_TEMPLATE_BODY = '# {{ title }}\n\n';

type EditorState =
  | { mode: 'create' }
  | { mode: 'edit'; templatePath: string; variables: TemplateVariableDef[]; body: string };

/**
 * Template management — create, edit, list, and delete — as its own first-class screen (not a
 * floating dialog): a list pane on the left, an inline create/edit form on the right. Every entry
 * point (Settings, the tree's context menu, the command palette) opens this same screen; nothing
 * else in the app pops a template-authoring modal anymore.
 */
export const TemplatesScreen: React.FC<TemplatesScreenProps> = ({
  onClose,
  initialCreate,
  initialEditPath,
}) => {
  const [templates, setTemplates] = useState<TemplateMeta[]>([]);
  const [variableCounts, setVariableCounts] = useState<Record<string, number>>({});
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [pendingDelete, setPendingDelete] = useState<TemplateMeta | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<{ path: string; value: string } | null>(null);
  const renameInputRef = useRef<HTMLInputElement>(null);

  const refresh = useCallback(() => {
    api.templatesList().then(async (list) => {
      setTemplates(list);
      const counts: Record<string, number> = {};
      await Promise.all(
        list.map(async (t) => {
          try {
            const vars = await api.templateVariablesGet(t.path);
            counts[t.path] = vars.length;
          } catch {
            counts[t.path] = 0;
          }
        })
      );
      setVariableCounts(counts);
    });
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const startEdit = useCallback(async (templatePath: string) => {
    try {
      const [variables, body] = await Promise.all([
        api.templateVariablesGet(templatePath),
        api.templateBodyGet(templatePath),
      ]);
      setEditor({ mode: 'edit', templatePath, variables, body });
      setLoadError(null);
    } catch (e) {
      setLoadError(`Could not load "${templatePath}": ${e}`);
    }
  }, []);

  // Land directly in create/edit mode when opened from a context-menu item or command that
  // already knows what the user wants to do, rather than making them click again on this screen.
  useEffect(() => {
    if (initialCreate) {
      setEditor({ mode: 'create' });
    } else if (initialEditPath) {
      startEdit(initialEditPath);
    }
    // Only ever applied once, on mount — the screen owns its own navigation after that.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleSave = async (name: string, variables: TemplateVariableDef[], body: string) => {
    if (editor?.mode === 'edit') {
      await Promise.all([
        api.templateVariablesSet(editor.templatePath, variables),
        api.templateBodySet(editor.templatePath, body),
      ]);
    } else {
      await api.templateCreate(name, variables, body);
    }
    setEditor(null);
    refresh();
  };

  useEffect(() => {
    if (renaming) {
      renameInputRef.current?.focus();
      renameInputRef.current?.select();
    }
  }, [renaming]);

  const startRename = (t: TemplateMeta) => {
    setRenaming({ path: t.path, value: t.name });
  };

  const commitRename = async () => {
    if (!renaming) return;
    const { path: oldPath, value } = renaming;
    const slug = slugify(value);
    if (!slug) {
      setRenaming(null);
      return;
    }
    const newPath = `${slug}.md`;
    if (newPath === oldPath) {
      setRenaming(null);
      return;
    }
    await api.noteRename(`.flint/templates/${oldPath}`, `.flint/templates/${newPath}`, false);
    if (editor?.mode === 'edit' && editor.templatePath === oldPath) {
      setEditor({ ...editor, templatePath: newPath });
    }
    setRenaming(null);
    refresh();
  };

  const handleConfirmDelete = async () => {
    if (!pendingDelete) return;
    await api.noteDelete(`.flint/templates/${pendingDelete.path}`);
    if (editor?.mode === 'edit' && editor.templatePath === pendingDelete.path) {
      setEditor(null);
    }
    setPendingDelete(null);
    refresh();
  };

  return (
    <div className="flex-1 flex flex-col bg-[var(--panel)] min-h-0 select-none" role="region" aria-label="Templates">
      <div className="flex items-center h-[31px] shrink-0 px-3 border-b border-[var(--border)]">
        <span className="text-[11.5px] tracking-wide font-medium text-[var(--text)]">Templates</span>
        <button
          onClick={onClose}
          className="ml-auto w-5 h-5 flex items-center justify-center rounded text-[var(--muted)] hover:bg-[var(--panel-2)] hover:text-[var(--text)] transition-colors text-xs font-semibold"
          title="Close templates"
          aria-label="Close templates"
        >
          ✕
        </button>
      </div>

      <div className="flex-1 flex min-h-0">
        <div className="w-[260px] shrink-0 border-r border-[var(--border)] flex flex-col min-h-0">
          <div className="p-2 border-b border-[var(--border)]">
            <button
              onClick={() => setEditor({ mode: 'create' })}
              className="w-full px-2.5 py-[6px] text-[12px] font-medium bg-[var(--accent)] text-[var(--panel)] rounded-[5px] transition-colors"
            >
              + New Template
            </button>
          </div>
          <div className="flex-1 overflow-auto min-h-0">
            {templates.length === 0 ? (
              <div className="px-3 py-4 text-[11.5px] text-[var(--faint)] text-center">
                No templates yet. Create one to give new notes a starting shape.
              </div>
            ) : (
              <ul role="list">
                {templates.map((t) =>
                  renaming?.path === t.path ? (
                    <li key={t.path} className="px-3 py-2 border-b border-[var(--border)]">
                      <input
                        ref={renameInputRef}
                        value={renaming.value}
                        onChange={(e) => setRenaming({ path: t.path, value: e.target.value })}
                        onBlur={commitRename}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            e.preventDefault();
                            commitRename();
                          } else if (e.key === 'Escape') {
                            e.preventDefault();
                            setRenaming(null);
                          }
                        }}
                        autoComplete="off"
                        autoCorrect="off"
                        autoCapitalize="off"
                        spellCheck={false}
                        aria-label={`Rename template "${t.name}"`}
                        className="w-full text-[12.5px] px-2 py-1 text-[var(--text)] bg-[var(--canvas)] border border-[var(--accent)] rounded-[4px]"
                      />
                    </li>
                  ) : (
                    <li key={t.path}>
                      <button
                        onClick={() => startEdit(t.path)}
                        aria-current={editor?.mode === 'edit' && editor.templatePath === t.path}
                        className={`w-full text-left flex items-center gap-2 px-3 py-2 border-b border-[var(--border)] transition-colors ${
                          editor?.mode === 'edit' && editor.templatePath === t.path
                            ? 'bg-[var(--accent-soft)]'
                            : 'hover:bg-[var(--panel-2)]'
                        }`}
                      >
                        <div className="flex-1 min-w-0">
                          <div className="text-[12.5px] text-[var(--text)] truncate">{t.name}</div>
                          <div className="text-[11px] text-[var(--faint)] truncate">
                            {(variableCounts[t.path] ?? 0) > 0
                              ? `${variableCounts[t.path]} variable${variableCounts[t.path] === 1 ? '' : 's'}`
                              : 'No variables'}
                          </div>
                        </div>
                        <span
                          role="button"
                          tabIndex={0}
                          onClick={(e) => {
                            e.stopPropagation();
                            startRename(t);
                          }}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter' || e.key === ' ') {
                              e.stopPropagation();
                              e.preventDefault();
                              startRename(t);
                            }
                          }}
                          className="w-[22px] h-[22px] flex items-center justify-center rounded-[4px] text-[var(--muted)] hover:bg-[var(--panel)] hover:text-[var(--text)] shrink-0"
                          aria-label={`Rename template "${t.name}"`}
                          title="Rename"
                        >
                          <PencilIcon />
                        </span>
                        <span
                          role="button"
                          tabIndex={0}
                          onClick={(e) => {
                            e.stopPropagation();
                            setPendingDelete(t);
                          }}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter' || e.key === ' ') {
                              e.stopPropagation();
                              e.preventDefault();
                              setPendingDelete(t);
                            }
                          }}
                          className="w-[22px] h-[22px] flex items-center justify-center rounded-[4px] text-[var(--danger,#d33)] hover:bg-[var(--panel)] shrink-0"
                          aria-label={`Delete template "${t.name}"`}
                          title="Delete"
                        >
                          <TrashIcon />
                        </span>
                      </button>
                    </li>
                  )
                )}
              </ul>
            )}
          </div>
        </div>

        <div className="flex-1 min-h-0">
          {loadError ? (
            <div className="p-4 text-[12px] text-[var(--danger,#d33)]">{loadError}</div>
          ) : editor ? (
            <TemplateForm
              key={editor.mode === 'edit' ? editor.templatePath : '__create__'}
              mode={editor.mode}
              initialVariables={editor.mode === 'edit' ? editor.variables : []}
              initialBody={editor.mode === 'edit' ? editor.body : DEFAULT_NEW_TEMPLATE_BODY}
              onSave={handleSave}
              onCancel={() => setEditor(null)}
            />
          ) : (
            <div className="flex flex-col items-center justify-center gap-2 h-full text-center px-6">
              <span className="text-[13px] text-[var(--text)]">
                {templates.length === 0 ? 'No templates yet' : 'Select a template to edit'}
              </span>
              <span className="text-[11.5px] text-[var(--faint)] max-w-[320px]">
                Or create one — headings, variables, whatever a recurring note type needs.
              </span>
              <button
                onClick={() => setEditor({ mode: 'create' })}
                className="mt-2 px-3 py-1.5 text-[12.5px] font-medium bg-[var(--accent)] text-[var(--panel)] rounded-[5px] transition-colors"
              >
                + New Template
              </button>
            </div>
          )}
        </div>
      </div>

      {pendingDelete && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-[1px]"
          onClick={(e) => {
            if (e.target === e.currentTarget) setPendingDelete(null);
          }}
        >
          <div
            role="alertdialog"
            aria-modal="true"
            aria-label="Delete template"
            className="w-[380px] max-w-[92vw] bg-[var(--panel)] border border-[var(--border)] rounded-[9px] shadow-[var(--shadow)] text-[13px] flex flex-col overflow-hidden"
          >
            <div className="px-[15px] py-[13px] text-[13.5px] font-medium text-[var(--text)] border-b border-[var(--border)]">
              Delete template
            </div>
            <div className="px-[15px] py-[14px] text-[12.5px] text-[var(--text-2)]">
              Move "{pendingDelete.name}" to the trash? Notes already created from it are
              unaffected.
            </div>
            <div className="flex items-center justify-end gap-1.5 px-[15px] py-[9px] border-t border-[var(--border)] bg-[var(--panel-2)]">
              <button
                type="button"
                onClick={() => setPendingDelete(null)}
                className="px-3 py-1.5 text-[12.5px] text-[var(--text-2)] hover:text-[var(--text)] hover:bg-[var(--panel)] rounded-[5px] border border-[var(--border)] transition-colors"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleConfirmDelete}
                className="px-3.5 py-1.5 text-[12.5px] font-medium bg-[var(--danger,#d33)] text-white rounded-[5px] transition-colors"
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
