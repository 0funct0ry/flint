import React, { useEffect, useRef, useState } from 'react';
import { TemplateVariableDef } from '../types';
import { slugify } from '../services/markdown';
import { VariableRows } from './VariableRows';
import { TemplateBodyEditor } from './TemplateBodyEditor';

export interface TemplateFormProps {
  /** When editing an existing template's variables, the name is fixed and not re-slugged into a
   * new file. */
  mode: 'create' | 'edit';
  initialName?: string;
  initialVariables?: TemplateVariableDef[];
  /** The template's Markdown body, edited inline via `TemplateBodyEditor` (M10.27 follow-up) —
   * required so both create and edit always save real, deliberate content, never an
   * auto-generated stand-in the user never saw. */
  initialBody: string;
  onSave: (name: string, variables: TemplateVariableDef[], body: string) => void;
  onCancel: () => void;
}

/**
 * The create/edit form body for a `.flint/templates/*.md` file — its name, declared variable
 * schema, and Markdown body — with no dialog chrome of its own, so it can sit inline in
 * `TemplatesScreen`'s panel (its first-class home) without a floating overlay. `key`-remount it on
 * the caller side (template path, or a create/edit toggle) to reset its local state between
 * targets.
 */
export const TemplateForm: React.FC<TemplateFormProps> = ({
  mode,
  initialName = '',
  initialVariables = [],
  initialBody,
  onSave,
  onCancel,
}) => {
  const [name, setName] = useState(initialName);
  const [variables, setVariables] = useState<TemplateVariableDef[]>(initialVariables);
  const bodyRef = useRef(initialBody);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onCancel();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onCancel]);

  const trimmedName = name.trim();
  const slug = slugify(trimmedName || 'untitled');
  const canSave =
    (mode === 'edit' || trimmedName.length > 0) &&
    variables.every((v) => v.name.trim().length > 0);

  const handleSave = () => {
    if (!canSave) return;
    onSave(trimmedName, variables, bodyRef.current);
  };

  return (
    <div className="flex flex-col h-full">
      <div className="shrink-0 overflow-auto max-h-[42%] px-4 py-4 flex flex-col gap-3">
        {mode === 'create' && (
          <div className="flex flex-col gap-1">
            <label htmlFor="template-name" className="text-[11.5px] text-[var(--muted)]">
              Template name
            </label>
            <input
              id="template-name"
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  handleSave();
                }
              }}
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
              spellCheck={false}
              className="text-[12.5px] px-[9px] py-[6px] text-[var(--text)] bg-[var(--canvas)] border border-[var(--border)] rounded-[5px]"
            />
            <span className="text-[11px] text-[var(--faint)]">
              Will be saved as .flint/templates/{slug || 'untitled'}.md
            </span>
          </div>
        )}

        <div className="flex flex-col gap-1.5">
          <span className="text-[11.5px] text-[var(--muted)]">Variables</span>
          <VariableRows variables={variables} onChange={setVariables} />
        </div>
      </div>

      <div className="flex-1 min-h-0 flex flex-col gap-1.5 px-4 pt-1 pb-3">
        <span className="text-[11.5px] text-[var(--muted)]">
          Body — type <code>{'{{'}</code> for variables (<code>title</code>, <code>path</code>,{' '}
          <code>var.name</code>) and functions (<code>date()</code>, <code>time()</code>,{' '}
          <code>seq()</code>), <code>|</code> for filters (<code>kebab</code>, <code>upper</code>,{' '}
          <code>slugify</code>), and <code>{'{%'}</code> for <code>for</code>/<code>if</code>/
          <code>set</code> blocks. If a template has an error, it is used as written and you are
          warned.
        </span>
        <TemplateBodyEditor
          initialValue={initialBody}
          onChange={(value) => {
            bodyRef.current = value;
          }}
          variableNames={variables.map((v) => v.name)}
          className="flex-1 min-h-0 border border-[var(--border)] rounded-[5px] overflow-hidden"
        />
      </div>

      <div className="flex items-center gap-3.5 px-4 py-[9px] border-t border-[var(--border)] bg-[var(--panel-2)] shrink-0">
        <span className="text-[11px] text-[var(--faint)]">esc to cancel</span>
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
            disabled={!canSave}
            onClick={handleSave}
            className="px-3.5 py-1.5 text-[12.5px] font-medium bg-[var(--accent)] text-[var(--panel)] rounded-[5px] transition-colors shadow-sm disabled:opacity-50"
          >
            {mode === 'edit' ? 'Save' : 'Create'}
          </button>
        </span>
      </div>
    </div>
  );
};
