import { describe, it, expect } from 'vitest';
import { EditorState, EditorSelection } from '@codemirror/state';
import { markdown } from '@codemirror/lang-markdown';
import { isParagraphEnabled } from '../commands/editorCommands';

/**
 * Regression coverage for a bug where paragraph context-menu items (Bullet List, Heading, Quote,
 * etc.) went disabled whenever the selection touched a blank line, or was dragged backward
 * (bottom-to-top / end-to-beginning) — both left `isParagraphEnabled` checking a single point
 * (`selection.main.head`) that happened to land on a blank line, which belongs to no Markdown
 * block in the syntax tree.
 */
function stateWithSelection(doc: string, anchor: number, head: number): EditorState {
  return EditorState.create({
    doc,
    extensions: [markdown()],
    selection: EditorSelection.single(anchor, head),
  });
}

describe('isParagraphEnabled', () => {
  const doc = 'First paragraph.\n\nSecond paragraph.\n\nThird paragraph.\n';
  // Line 1: "First paragraph."   (0-16)
  // Line 2: ""                  (17-17, blank)
  // Line 3: "Second paragraph." (18-35)
  // Line 4: ""                  (36-36, blank)
  // Line 5: "Third paragraph."  (37-53)

  it('is enabled for a plain cursor or selection inside a paragraph', () => {
    expect(isParagraphEnabled(stateWithSelection(doc, 5, 5))).toBe(true);
    expect(isParagraphEnabled(stateWithSelection(doc, 0, 16))).toBe(true);
  });

  it('stays enabled when the selection includes a blank line at its end (forward drag)', () => {
    // Selects from inside "First paragraph." through the blank line that follows it.
    expect(isParagraphEnabled(stateWithSelection(doc, 5, 17))).toBe(true);
  });

  it('stays enabled when the selection includes a blank line at its start (forward drag)', () => {
    // Selects from the blank line into "Second paragraph."
    expect(isParagraphEnabled(stateWithSelection(doc, 17, 25))).toBe(true);
  });

  it('stays enabled when the selection spans a blank line between two paragraphs', () => {
    expect(isParagraphEnabled(stateWithSelection(doc, 5, 25))).toBe(true);
  });

  it('stays enabled when the selection is dragged backward (end to beginning)', () => {
    // anchor at the later offset, head at the earlier offset — a bottom-to-top drag.
    expect(isParagraphEnabled(stateWithSelection(doc, 25, 5))).toBe(true);
  });

  it('stays enabled when a backward selection also spans a blank line', () => {
    expect(isParagraphEnabled(stateWithSelection(doc, 25, 0))).toBe(true);
  });

  it('is disabled for a cursor on a blank line', () => {
    expect(isParagraphEnabled(stateWithSelection(doc, 17, 17))).toBe(false);
  });

  it('is disabled when the whole selection is consecutive blank lines with no block content', () => {
    const blankDoc = 'First paragraph.\n\n\n\nLast paragraph.\n';
    // Line 2 (17-17), line 3 (18-18), line 4 (19-19) are all blank.
    expect(isParagraphEnabled(stateWithSelection(blankDoc, 17, 19))).toBe(false);
  });

  it('stays enabled for a selection spanning three paragraphs and both blank lines, in reverse', () => {
    const to = doc.length;
    expect(isParagraphEnabled(stateWithSelection(doc, to, 0))).toBe(true);
  });
});
