import React from 'react';

export interface KeyValueRowsProps {
  entries: [string, string][];
  onChange: (entries: [string, string][]) => void;
  keyPlaceholder?: string;
  valuePlaceholder?: string;
}

/**
 * Repeatable name/value row list — the folder-scope and global-scope pieces of M10.27 Journey C
 * ("Folder variables…" modal, Settings → Templates → Variables table). Visually matches
 * `VariableRows`' row shell without the type/required/options fields a plain name/value pair
 * doesn't need.
 */
export const KeyValueRows: React.FC<KeyValueRowsProps> = ({
  entries,
  onChange,
  keyPlaceholder = 'name',
  valuePlaceholder = 'value',
}) => {
  const update = (index: number, key: string, value: string) => {
    onChange(entries.map((e, i) => (i === index ? [key, value] : e)));
  };
  const remove = (index: number) => {
    onChange(entries.filter((_, i) => i !== index));
  };
  const add = () => {
    onChange([...entries, ['', '']]);
  };

  return (
    <div className="flex flex-col gap-2">
      {entries.map(([key, value], i) => (
        <div key={i} className="flex items-center gap-1.5">
          <input
            aria-label={`Row ${i + 1} name`}
            value={key}
            placeholder={keyPlaceholder}
            onChange={(e) => update(i, e.target.value, value)}
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
            className="w-[130px] text-[12px] px-2 py-1 text-[var(--text)] bg-[var(--canvas)] border border-[var(--border)] rounded-[4px]"
          />
          <input
            aria-label={`Row ${i + 1} value`}
            value={value}
            placeholder={valuePlaceholder}
            onChange={(e) => update(i, key, e.target.value)}
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
            className="flex-1 text-[12px] px-2 py-1 text-[var(--text)] bg-[var(--canvas)] border border-[var(--border)] rounded-[4px]"
          />
          <button
            type="button"
            aria-label={`Remove row ${i + 1}`}
            onClick={() => remove(i)}
            className="w-[20px] h-[20px] text-[var(--muted)] hover:text-[var(--text)]"
          >
            ×
          </button>
        </div>
      ))}
      <button type="button" onClick={add} className="self-start text-[11.5px] text-[var(--accent)] hover:underline">
        + Add row
      </button>
    </div>
  );
};
