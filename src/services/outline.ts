/**
 * M10.09 — Outline tree, section boundaries, and reorder helpers.
 *
 * A "section" is a heading together with its body and nested sub-headings, up to (but not
 * including) the next sibling-or-shallower heading — the same boundary the flat outline list
 * already implies from `HeadingItem.level`, just made explicit here so reorder/copy/delete/
 * extract all share one definition (per the M10.09 prompt).
 */
import { HeadingItem } from '../types';
import { slugify, dedupSlug } from './markdown';

/**
 * Re-derive headings directly from `content`, matching the ATX-heading extraction `note_render`'s
 * browser-mock fallback uses (`src/services/ipc.ts`). The `headings` prop the outline panel
 * receives from `note_render` only refreshes on load/save — but every outline edit (reorder,
 * delete, extract) changes `content` immediately, and computing a section's char range against
 * *stale* heading line numbers over the *new* content silently corrupts the edit. Recomputing here
 * keeps headings and content offsets always derived from the exact same string.
 */
export function parseHeadingsFromContent(content: string): HeadingItem[] {
  const headings: HeadingItem[] = [];
  const slugCounts = new Map<string, number>();
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].trim().match(/^(#{1,6})\s+(.*)$/);
    if (match) {
      const text = match[2].trim();
      headings.push({
        level: match[1].length,
        text,
        anchor: dedupSlug(slugCounts, slugify(text)),
        line: i,
      });
    }
  }
  return headings;
}

export interface OutlineNode {
  heading: HeadingItem;
  /** Index into the original flat `headings` array — the stable identity used everywhere else. */
  index: number;
  children: OutlineNode[];
}

/** Build a nested tree from the flat, depth-first `headings` list `note_render` produces. */
export function buildOutlineTree(headings: HeadingItem[]): OutlineNode[] {
  const roots: OutlineNode[] = [];
  const stack: OutlineNode[] = [];

  headings.forEach((heading, index) => {
    const node: OutlineNode = { heading, index, children: [] };
    while (stack.length > 0 && stack[stack.length - 1].heading.level >= heading.level) {
      stack.pop();
    }
    if (stack.length === 0) {
      roots.push(node);
    } else {
      stack[stack.length - 1].children.push(node);
    }
    stack.push(node);
  });

  return roots;
}

/** Char offset of the start of each line in `content` (line index is 0-based, matching `HeadingItem.line`). */
export function lineStartOffsets(content: string): number[] {
  const offsets: number[] = [0];
  for (let i = 0; i < content.length; i++) {
    if (content[i] === '\n') offsets.push(i + 1);
  }
  return offsets;
}

/** The char range `[from, to)` a heading's section occupies in `content`, per the boundary above. */
export function sectionBounds(
  headings: HeadingItem[],
  index: number,
  content: string,
  offsets = lineStartOffsets(content)
): { from: number; to: number } {
  const heading = headings[index];
  const startLine = heading.line ?? 0;
  const from = offsets[startLine] ?? content.length;

  let endLine = offsets.length - 1; // last line index
  for (let i = index + 1; i < headings.length; i++) {
    if (headings[i].level <= heading.level) {
      endLine = (headings[i].line ?? offsets.length) - 1;
      break;
    }
  }
  const to = endLine + 1 < offsets.length ? offsets[endLine + 1] : content.length;
  return { from, to };
}

export function sectionText(
  headings: HeadingItem[],
  index: number,
  content: string,
  offsets = lineStartOffsets(content)
): string {
  const { from, to } = sectionBounds(headings, index, content, offsets);
  return content.slice(from, to);
}

/**
 * The contiguous run of sibling indices (same level, same parent) that `index` belongs to, in
 * original document order. Siblings' sections always partition a contiguous span of the parent's
 * body (or the whole document, for top-level headings), so a reorder among them can always be
 * expressed as replacing that one span — never a set of scattered edits.
 */
export function siblingGroup(headings: HeadingItem[], index: number): number[] {
  const level = headings[index].level;

  // Parent is the nearest preceding heading with a shallower level; siblings run from just after
  // the parent (or from the top) to just before the next heading shallower-than-or-equal to the
  // parent (or the end of the document).
  let parentIdx = -1;
  for (let i = index - 1; i >= 0; i--) {
    if (headings[i].level < level) {
      parentIdx = i;
      break;
    }
  }

  const group: number[] = [];
  for (let i = parentIdx + 1; i < headings.length; i++) {
    if (headings[i].level < level) break; // walked past the parent's own span
    if (headings[i].level === level) group.push(i);
  }
  return group;
}

/**
 * Build a single `{from, to, insert}` CodeMirror change that replaces the sibling group's whole
 * span with its sections concatenated in `newOrderIndices` order — one transaction, one undo step,
 * regardless of how far a section moved.
 */
export function reorderSiblingsChange(
  headings: HeadingItem[],
  content: string,
  siblingIndices: number[],
  newOrderIndices: number[]
): { from: number; to: number; insert: string } | null {
  if (siblingIndices.length < 2) return null;
  const offsets = lineStartOffsets(content);
  const bounds = siblingIndices.map((i) => sectionBounds(headings, i, content, offsets));
  const from = Math.min(...bounds.map((b) => b.from));
  const to = Math.max(...bounds.map((b) => b.to));
  // Only the section that was originally last in the document (i.e. ends at EOF) can lack a
  // trailing newline. Moving it to a non-final position would otherwise glue its last line
  // directly onto the next section's heading line — silently corrupting both a fenced code block
  // and the heading marker. Every section but the new last one must end with a newline.
  const insert = newOrderIndices
    .map((i, pos) => {
      const text = sectionText(headings, i, content, offsets);
      const isNewLast = pos === newOrderIndices.length - 1;
      return !isNewLast && !text.endsWith('\n') ? `${text}\n` : text;
    })
    .join('');
  return { from, to, insert };
}

/** Swap `index` with the adjacent sibling one position up/down; null if there's no such sibling. */
export function swapWithAdjacentSibling(
  headings: HeadingItem[],
  content: string,
  index: number,
  direction: 'up' | 'down'
): { from: number; to: number; insert: string } | null {
  const group = siblingGroup(headings, index);
  const pos = group.indexOf(index);
  const targetPos = direction === 'up' ? pos - 1 : pos + 1;
  if (targetPos < 0 || targetPos >= group.length) return null;

  const newOrder = [...group];
  [newOrder[pos], newOrder[targetPos]] = [newOrder[targetPos], newOrder[pos]];
  return reorderSiblingsChange(headings, content, group, newOrder);
}

/** A single `{from, to, insert: ''}` change removing a section entirely. */
export function removeSectionChange(
  headings: HeadingItem[],
  index: number,
  content: string
): { from: number; to: number; insert: string } {
  const { from, to } = sectionBounds(headings, index, content);
  return { from, to, insert: '' };
}
