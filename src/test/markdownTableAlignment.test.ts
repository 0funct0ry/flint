import { describe, it, expect } from 'vitest';
import { renderMarkdownToHtml } from '../services/markdown';

describe('renderMarkdownToHtml table alignment (JS fallback renderer)', () => {
  it('applies text-align to header and body cells per column', () => {
    const md = '| Left | Center | Right | None |\n' + '|:---|:---:|---:|---|\n' + '| a | b | c | d |\n';
    const html = renderMarkdownToHtml(md);

    expect(html).toContain('<th style="text-align: left">Left</th>');
    expect(html).toContain('<th style="text-align: center">Center</th>');
    expect(html).toContain('<th style="text-align: right">Right</th>');
    expect(html).toContain('<th>None</th>');

    expect(html).toContain('<td style="text-align: left">a</td>');
    expect(html).toContain('<td style="text-align: center">b</td>');
    expect(html).toContain('<td style="text-align: right">c</td>');
    expect(html).toContain('<td>d</td>');
  });

  it('reflects a changed alignment row (e.g. --- -> :---:) without a stale style', () => {
    const before = renderMarkdownToHtml('| A |\n| --- |\n| x |\n');
    const after = renderMarkdownToHtml('| A |\n| :---: |\n| x |\n');

    expect(before).toContain('<th>A</th>');
    expect(after).toContain('<th style="text-align: center">A</th>');
  });

  it('renders a table with no separator row plainly, without throwing', () => {
    const html = renderMarkdownToHtml('| A | B |\n| 1 | 2 |\n');
    expect(html).toContain('<th>A</th>');
    expect(html).toContain('<th>B</th>');
    expect(html).toContain('<td>1</td>');
    expect(html).toContain('<td>2</td>');
  });
});
