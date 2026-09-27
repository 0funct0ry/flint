import { describe, expect, it } from 'vitest';
import {
  buildOutlineTree,
  parseHeadingsFromContent,
  reorderSiblingsChange,
  removeSectionChange,
  sectionText,
  siblingGroup,
  swapWithAdjacentSibling,
} from '../services/outline';

const SIMPLE = `# Title

## A
a body

## B
b body

## C
c body
`;

// No trailing newline after the last section — the shape that exposed the reorder bug below.
const NO_TRAILING_NEWLINE = `# Title

## A
a body

## B
\`\`\`bash
echo hi
\`\`\`

## C
c body`;

describe('parseHeadingsFromContent', () => {
  it('extracts ATX headings with line numbers', () => {
    const headings = parseHeadingsFromContent(SIMPLE);
    expect(headings.map((h) => [h.level, h.text, h.line])).toEqual([
      [1, 'Title', 0],
      [2, 'A', 2],
      [2, 'B', 5],
      [2, 'C', 8],
    ]);
  });

  it('dedupes identical heading text with -2, -3 suffixes', () => {
    const headings = parseHeadingsFromContent('# Same\n\n# Same\n\n# Same\n');
    expect(headings.map((h) => h.anchor)).toEqual(['same', 'same-2', 'same-3']);
  });
});

describe('buildOutlineTree', () => {
  it('nests by level depth-first', () => {
    const headings = parseHeadingsFromContent(SIMPLE);
    const tree = buildOutlineTree(headings);
    expect(tree).toHaveLength(1);
    expect(tree[0].heading.text).toBe('Title');
    expect(tree[0].children.map((c) => c.heading.text)).toEqual(['A', 'B', 'C']);
    expect(tree[0].children[0].children).toEqual([]);
  });
});

describe('sectionBounds / sectionText', () => {
  it('bounds a section up to the next sibling-or-shallower heading', () => {
    const headings = parseHeadingsFromContent(SIMPLE);
    const text = sectionText(headings, 1, SIMPLE); // "## A"
    expect(text).toBe('## A\na body\n\n');
  });

  it('the last section in the document runs to end of content', () => {
    const headings = parseHeadingsFromContent(SIMPLE);
    const text = sectionText(headings, 3, SIMPLE); // "## C"
    expect(text).toBe('## C\nc body\n');
  });
});

describe('siblingGroup', () => {
  it('returns same-level, same-parent indices in document order', () => {
    const headings = parseHeadingsFromContent(SIMPLE);
    expect(siblingGroup(headings, 2)).toEqual([1, 2, 3]);
  });

  it('nested children are their own sibling group, separate from their parent level', () => {
    const headings = parseHeadingsFromContent('# T\n\n## A\n\n### A1\n\n### A2\n\n## B\n');
    // A1, A2 are siblings under A; A, B are siblings under T.
    expect(siblingGroup(headings, 1)).toEqual([1, 4]);
    expect(siblingGroup(headings, 2)).toEqual([2, 3]);
  });
});

describe('reorderSiblingsChange', () => {
  it('produces one change replacing the whole sibling span in the new order', () => {
    const headings = parseHeadingsFromContent(SIMPLE);
    const group = siblingGroup(headings, 2); // [1,2,3] = A,B,C
    const change = reorderSiblingsChange(headings, SIMPLE, group, [2, 1, 3]); // B,A,C
    expect(change).not.toBeNull();
    const result = SIMPLE.slice(0, change!.from) + change!.insert + SIMPLE.slice(change!.to);
    const reorderedHeadings = parseHeadingsFromContent(result);
    expect(reorderedHeadings.map((h) => h.text)).toEqual(['Title', 'B', 'A', 'C']);
    // No content lost or gained — only reordered.
    expect(result.length).toBe(SIMPLE.length);
  });

  it('regression: moving the section that lacked a trailing newline off the end inserts one, never gluing it onto the next heading', () => {
    const headings = parseHeadingsFromContent(NO_TRAILING_NEWLINE);
    const group = siblingGroup(headings, 2); // [1,2,3] = A,B,C — C originally has no trailing "\n"
    // Move C (index 3, the no-trailing-newline section) into the middle.
    const change = reorderSiblingsChange(headings, NO_TRAILING_NEWLINE, group, [1, 3, 2]);
    const result = NO_TRAILING_NEWLINE.slice(0, change!.from) + change!.insert + NO_TRAILING_NEWLINE.slice(change!.to);
    // The old bug produced "c body## B" (glued, no newline) — assert a newline separates them.
    expect(result).not.toContain('c body##');
    expect(result).toContain('c body\n## B');
    // And the heading is still parseable as a heading after the move.
    const reorderedHeadings = parseHeadingsFromContent(result);
    expect(reorderedHeadings.map((h) => h.text)).toEqual(['Title', 'A', 'C', 'B']);
  });

  it('a single-section group (no siblings) is a no-op', () => {
    const headings = parseHeadingsFromContent(SIMPLE);
    expect(reorderSiblingsChange(headings, SIMPLE, [0], [0])).toBeNull();
  });
});

describe('swapWithAdjacentSibling', () => {
  it('swaps with the previous sibling on "up"', () => {
    const headings = parseHeadingsFromContent(SIMPLE);
    const change = swapWithAdjacentSibling(headings, SIMPLE, 2, 'up'); // B up
    const result = SIMPLE.slice(0, change!.from) + change!.insert + SIMPLE.slice(change!.to);
    expect(parseHeadingsFromContent(result).map((h) => h.text)).toEqual(['Title', 'B', 'A', 'C']);
  });

  it('returns null at the start/end of the sibling group', () => {
    const headings = parseHeadingsFromContent(SIMPLE);
    expect(swapWithAdjacentSibling(headings, SIMPLE, 1, 'up')).toBeNull(); // A is already first
    expect(swapWithAdjacentSibling(headings, SIMPLE, 3, 'down')).toBeNull(); // C is already last
  });
});

describe('removeSectionChange', () => {
  it('removes a heading, its body, and nested sub-headings in one change', () => {
    const content = '# T\n\n## A\n\n### A1\nbody\n\n## B\nb\n';
    const headings = parseHeadingsFromContent(content);
    const change = removeSectionChange(headings, 1, content); // remove "## A" (with nested "### A1")
    const result = content.slice(0, change.from) + change.insert + content.slice(change.to);
    expect(parseHeadingsFromContent(result).map((h) => h.text)).toEqual(['T', 'B']);
  });

  it('removing a section drops exactly its bounds', () => {
    const content = SIMPLE;
    const headings = parseHeadingsFromContent(content);
    const change = removeSectionChange(headings, 1, content); // remove "## A"
    const result = content.slice(0, change.from) + change.insert + content.slice(change.to);
    expect(parseHeadingsFromContent(result).map((h) => h.text)).toEqual(['Title', 'B', 'C']);
  });
});
