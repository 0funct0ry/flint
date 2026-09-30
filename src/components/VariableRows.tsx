import React from 'react';
import { TemplateVariableDef, TemplateVariableKind } from '../types';

export interface VariableRowsProps {
  variables: TemplateVariableDef[];
  onChange: (variables: TemplateVariableDef[]) => void;
}

const KIND_OPTIONS: { value: TemplateVariableKind; label: string }[] = [
  { value: 'text', label: 'Text' },
  { value: 'date', label: 'Date' },
  { value: 'choice', label: 'Choice' },
  { value: 'bool', label: 'Yes/No' },
];

function emptyVariable(): TemplateVariableDef {
  return { name: '', kind: 'text', default: '', required: false, options: [] };
}

const parseOptions = (text: string): string[] =>
  text
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);

/** Comma-separated options field. Keeps the raw text locally so typing `,` or a space isn't
 * stripped by re-deriving the value from the parsed list on every keystroke. */
const OptionsInput: React.FC<{
  ariaLabel: string;
  options: string[];
  onChange: (options: string[]) => void;
}> = ({ ariaLabel, options, onChange }) => {
  const [text, setText] = React.useState(options.join(', '));
  // Re-sync only when the options changed from outside (not from our own typing).
  React.useEffect(() => {
    const current = parseOptions(text);
    if (current.length !== options.length || current.some((o, i) => o !== options[i])) {
      setText(options.join(', '));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [options]);

  return (
    <input
      aria-label={ariaLabel}
      value={text}
      placeholder="option a, option b"
      onChange={(e) => {
        setText(e.target.value);
        onChange(parseOptions(e.target.value));
      }}
      autoComplete="off"
      autoCorrect="off"
      autoCapitalize="off"
      spellCheck={false}
      className="flex-1 min-w-[120px] text-[12px] px-2 py-1 text-[var(--text)] bg-[var(--canvas)] border border-[var(--border)] rounded-[4px]"
    />
  );
};

/**
 * Repeatable name/type/default/required row list for a template's variable schema (M10.27
 * Journey A) — shared by `TemplateEditorModal` and reused, visually, by folder/global scope
 * editors that only need name/value pairs (see `KeyValueRows` for that simpler shape).
 */
export const VariableRows: React.FC<VariableRowsProps> = ({ variables, onChange }) => {
  const update = (index: number, patch: Partial<TemplateVariableDef>) => {
    onChange(variables.map((v, i) => (i === index ? { ...v, ...patch } : v)));
  };

  const remove = (index: number) => {
    onChange(variables.filter((_, i) => i !== index));
  };

  const add = () => {
    onChange([...variables, emptyVariable()]);
  };

  return (
    <div className="flex flex-col gap-2">
      {variables.map((v, i) => (
        <div key={i} className="flex items-center gap-1.5 flex-wrap">
          <input
            aria-label={`Variable ${i + 1} name`}
            value={v.name}
            placeholder="name"
            onChange={(e) => update(i, { name: e.target.value })}
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
            className="w-[110px] text-[12px] px-2 py-1 text-[var(--text)] bg-[var(--canvas)] border border-[var(--border)] rounded-[4px]"
          />
          <select
            aria-label={`Variable ${i + 1} type`}
            value={v.kind}
            onChange={(e) => update(i, { kind: e.target.value as TemplateVariableKind })}
            className="text-[12px] px-1.5 py-1 text-[var(--text)] bg-[var(--canvas)] border border-[var(--border)] rounded-[4px]"
          >
            {KIND_OPTIONS.map((k) => (
              <option key={k.value} value={k.value}>
                {k.label}
              </option>
            ))}
          </select>
          {v.kind === 'choice' ? (
            <OptionsInput
              ariaLabel={`Variable ${i + 1} options`}
              options={v.options}
              onChange={(options) => update(i, { options })}
            />
          ) : v.kind === 'bool' ? (
            <label className="flex items-center gap-1 text-[12px] text-[var(--muted)]">
              <input
                type="checkbox"
                aria-label={`Variable ${i + 1} default`}
                checked={v.default === 'true'}
                onChange={(e) => update(i, { default: e.target.checked ? 'true' : 'false' })}
              />
              default
            </label>
          ) : (
            <input
              aria-label={`Variable ${i + 1} default`}
              value={v.default}
              placeholder="default"
              onChange={(e) => update(i, { default: e.target.value })}
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
              spellCheck={false}
              className="flex-1 min-w-[100px] text-[12px] px-2 py-1 text-[var(--text)] bg-[var(--canvas)] border border-[var(--border)] rounded-[4px]"
            />
          )}
          <label className="flex items-center gap-1 text-[11.5px] text-[var(--muted)]">
            <input
              type="checkbox"
              aria-label={`Variable ${i + 1} required`}
              checked={v.required}
              onChange={(e) => update(i, { required: e.target.checked })}
            />
            required
          </label>
          <button
            type="button"
            aria-label={`Remove variable ${i + 1}`}
            onClick={() => remove(i)}
            className="w-[20px] h-[20px] text-[var(--muted)] hover:text-[var(--text)]"
          >
            ×
          </button>
        </div>
      ))}
      <button
        type="button"
        onClick={add}
        className="self-start text-[11.5px] text-[var(--accent)] hover:underline"
      >
        + Add variable
      </button>
    </div>
  );
};
