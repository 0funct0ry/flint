/**
 * M10.08 — Markdown table builder: pure helpers for generating GFM table markdown and for
 * sniffing a delimited-text selection into a starting row/column/header layout. Kept separate
 * from `editorCommands.ts` (and free of any CodeMirror/React dependency) so they can be unit
 * tested directly.
 */

export type ColumnAlignment = 'left' | 'center' | 'right' | 'none';

export const MIN_ROWS = 1;
export const MAX_ROWS = 20;
export const MIN_COLS = 1;
export const MAX_COLS = 10;

/** Escapes a literal `|` in a cell so it can't be mistaken for a column delimiter. */
function escapeCell(text: string): string {
  return text.replace(/\|/g, '\\|');
}

function alignmentToken(alignment: ColumnAlignment): string {
  switch (alignment) {
    case 'left':
      return ':---';
    case 'center':
      return ':---:';
    case 'right':
      return '---:';
    case 'none':
    default:
      return '---';
  }
}

function rowLine(cells: string[]): string {
  return `| ${cells.map(escapeCell).join(' | ')} |`;
}

/**
 * Builds GFM table markdown from header labels, per-column alignment, and a body row count.
 * Empty header labels fall back to `Column N` (a GFM header cell can't be meaningfully blank).
 * Body cells are emitted blank, ready for the author to fill in.
 */
export function buildTableMarkdown(
  headers: string[],
  alignments: ColumnAlignment[],
  bodyRowCount: number
): string {
  const cols = headers.length;
  const resolvedHeaders = headers.map((h, i) => (h.trim() ? h : `Column ${i + 1}`));
  const lines: string[] = [];
  lines.push(rowLine(resolvedHeaders));
  lines.push(`| ${alignments.map(alignmentToken).join(' | ')} |`);
  for (let r = 0; r < bodyRowCount; r++) {
    lines.push(rowLine(new Array(cols).fill('')));
  }
  return lines.join('\n') + '\n';
}

export interface ParsedSelection {
  headers: string[];
  bodyRowCount: number;
  delimiter: 'pipe' | 'tab' | 'comma';
}

function splitPipeRow(line: string): string[] {
  // Strip a single leading/trailing "|" (common when pasting an existing Markdown table row)
  // before splitting on the remaining, unescaped pipes.
  const trimmed = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  return trimmed.split('|').map((c) => c.trim());
}

function tryParseDelimiter(lines: string[], delimiter: 'pipe' | 'tab' | 'comma'): ParsedSelection | null {
  const split =
    delimiter === 'pipe' ? splitPipeRow : delimiter === 'tab' ? (l: string) => l.split('\t') : (l: string) => l.split(',');

  const rows = lines.map((l) => split(l).map((c) => c.trim()));
  if (rows.length === 0 || rows.every((r) => r.length <= 1)) return null;

  const colCount = Math.max(...rows.map((r) => r.length));
  if (colCount <= 1) return null;

  const [headerRow, ...bodyRows] = rows;
  const headers = new Array(colCount).fill('').map((_, i) => headerRow[i] ?? '');

  return { headers, bodyRowCount: bodyRows.length, delimiter };
}

/**
 * Sniffs a selection's delimiter (pipe, then tab, then comma) and parses it into a header row
 * plus a body row count, padding ragged rows to the widest row's column count. Returns `null`
 * when the selection is empty or doesn't look delimited (fewer than 2 columns on any delimiter).
 */
export function parseDelimitedSelection(text: string): ParsedSelection | null {
  const lines = text
    .split(/\r\n|\r|\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  if (lines.length === 0) return null;

  for (const delimiter of ['pipe', 'tab', 'comma'] as const) {
    const parsed = tryParseDelimiter(lines, delimiter);
    if (parsed) return parsed;
  }
  return null;
}

export function clampRows(n: number): number {
  return Math.min(MAX_ROWS, Math.max(MIN_ROWS, Math.round(n) || MIN_ROWS));
}

export function clampCols(n: number): number {
  return Math.min(MAX_COLS, Math.max(MIN_COLS, Math.round(n) || MIN_COLS));
}
