import { describe, it, expect } from 'vitest';
import { findTaskMarkers, toggleTaskMarker } from '../services/taskList';

describe('findTaskMarkers', () => {
  it('finds unordered-list task markers in document order', () => {
    const content = '- [x] Done item\n- [ ] Todo item\n- [ ] Third item\n';
    const markers = findTaskMarkers(content);
    expect(markers.map((m) => m.checked)).toEqual([true, false, false]);
    // Each offset should point exactly at the checkbox glyph.
    for (const marker of markers) {
      expect('[' + content[marker.charOffset] + ']').toMatch(/^\[[ xX]\]$/);
    }
  });

  it('finds task markers in an ordered list, matching pulldown-cmark', () => {
    const content = '1. [ ] Task 1\n2. [x] Task 2\n';
    const markers = findTaskMarkers(content);
    expect(markers.map((m) => m.checked)).toEqual([false, true]);
  });

  it('is indifferent to a preceding front-matter block', () => {
    const withFrontMatter = '---\ntitle: Note\n---\n- [ ] Task A\n- [x] Task B\n';
    const withoutFrontMatter = '- [ ] Task A\n- [x] Task B\n';
    expect(findTaskMarkers(withFrontMatter).map((m) => m.checked)).toEqual(
      findTaskMarkers(withoutFrontMatter).map((m) => m.checked)
    );
  });

  it('does not match a blockquoted task line', () => {
    expect(findTaskMarkers('> - [ ] Quoted task\n')).toEqual([]);
  });

  it('returns an empty list for content with no task markers', () => {
    expect(findTaskMarkers('# Heading\n\nJust a paragraph.\n')).toEqual([]);
  });
});

describe('toggleTaskMarker', () => {
  it('checks an unchecked box, leaving everything else untouched', () => {
    const content = '- [ ] Task 1\n- [ ] Task 2\n';
    expect(toggleTaskMarker(content, 0)).toBe('- [x] Task 1\n- [ ] Task 2\n');
  });

  it('unchecks a checked box', () => {
    const content = '- [x] Task 1\n- [ ] Task 2\n';
    expect(toggleTaskMarker(content, 0)).toBe('- [ ] Task 1\n- [ ] Task 2\n');
  });

  it('toggles the correct item by index, not just the first one', () => {
    const content = '- [ ] Task 1\n- [ ] Task 2\n- [ ] Task 3\n';
    expect(toggleTaskMarker(content, 1)).toBe('- [ ] Task 1\n- [x] Task 2\n- [ ] Task 3\n');
  });

  it('returns null for an out-of-range index', () => {
    expect(toggleTaskMarker('- [ ] Only task\n', 5)).toBeNull();
  });
});
