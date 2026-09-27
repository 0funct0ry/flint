/**
 * Locates GFM task-list checkbox markers (`- [ ]`, `1. [x]`, etc.) in a note's raw Markdown text,
 * in document order — the same order the reader pane's rendered `<input type="checkbox"
 * data-task-index="N">` elements are numbered in (see `renderMarkdownToHtml` and
 * `flint_core::render_note_markdown`), so a click on the Nth rendered checkbox can be mapped back
 * to the exact character to toggle in the source buffer.
 *
 * A front-matter block never contains a task marker, so whether `content` includes one or not
 * does not change these indices — the same function is used against the full editor buffer (for
 * toggling) and against the front-matter-stripped body (for the browser-mock renderer).
 *
 * Blockquoted task items (`> - [ ] …`) are intentionally not matched — they are rendered as plain
 * (non-interactive) checkboxes by both renderers, so excluding them here keeps the two numbering
 * schemes in agreement.
 */
export interface TaskMarker {
  /** Absolute character offset of the checkbox glyph itself — the space or x inside `[ ]`/`[x]`. */
  charOffset: number;
  checked: boolean;
}

const TASK_LINE_RE = /^([ \t]*(?:[-*+]|\d+[.)])[ \t]+\[)([ xX])(\])/;

export function findTaskMarkers(content: string): TaskMarker[] {
  const markers: TaskMarker[] = [];
  let offset = 0;
  for (const line of content.split('\n')) {
    const match = line.match(TASK_LINE_RE);
    if (match) {
      markers.push({
        charOffset: offset + match[1].length,
        checked: match[2].toLowerCase() === 'x',
      });
    }
    offset += line.length + 1; // +1 accounts for the '\n' split() consumed
  }
  return markers;
}

/** Toggle the `taskIndex`-th task marker (0-based, document order) in `content`, returning the
 *  updated text, or `null` if there is no marker at that index. */
export function toggleTaskMarker(content: string, taskIndex: number): string | null {
  const marker = findTaskMarkers(content)[taskIndex];
  if (!marker) return null;
  const replacement = marker.checked ? ' ' : 'x';
  return content.slice(0, marker.charOffset) + replacement + content.slice(marker.charOffset + 1);
}
