import { describe, it, expect } from 'vitest';
import { EditorState } from '@codemirror/state';
import { CompletionContext } from '@codemirror/autocomplete';
import { createTemplatePlaceholderCompletionSource } from '../services/templateCompletion';

function labelsAt(doc: string) {
  const state = EditorState.create({ doc });
  const source = createTemplatePlaceholderCompletionSource(() => ['project']);
  const result = source(new CompletionContext(state, doc.length, true));
  return result?.options.map((o) => o.label) ?? null;
}

describe('template completion (Tera syntax)', () => {
  it('offers variables and functions after {{', () => {
    const labels = labelsAt('# {{ ');
    expect(labels).toContain('title');
    expect(labels).toContain('date()');
    expect(labels).toContain('seq()');
    expect(labels).toContain('var.project');
  });

  it('offers filters after a pipe', () => {
    const labels = labelsAt('{{ title | ');
    expect(labels).toContain('kebab');
    expect(labels).toContain('truncate(length=N)');
  });

  it('offers block statements after {%', () => {
    const labels = labelsAt('{% ');
    expect(labels).toEqual(expect.arrayContaining(['for', 'if', 'set', 'endfor', 'endif']));
  });

  it('offers nothing outside a span', () => {
    expect(labelsAt('plain text')).toBeNull();
    expect(labelsAt('{{ title }} and ')).toBeNull();
  });
});
