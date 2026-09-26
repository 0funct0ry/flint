import { describe, it, expect } from 'vitest';
import { buildTableMarkdown, parseDelimitedSelection } from '../commands/tableBuilder';

describe('buildTableMarkdown', () => {
  it('builds a 2-column table with no alignment', () => {
    const md = buildTableMarkdown(['Window', 'Cut-off'], ['none', 'none'], 2);
    expect(md).toBe(
      '| Window | Cut-off |\n' +
        '| --- | --- |\n' +
        '|  |  |\n' +
        '|  |  |\n'
    );
  });

  it('emits exact GFM alignment tokens for a mixed-alignment table', () => {
    const md = buildTableMarkdown(
      ['A', 'B', 'C', 'D'],
      ['left', 'center', 'right', 'none'],
      1
    );
    expect(md).toBe(
      '| A | B | C | D |\n' +
        '| :--- | :---: | ---: | --- |\n' +
        '|  |  |  |  |\n'
    );
  });

  it('escapes literal pipes in header and body cells', () => {
    const md = buildTableMarkdown(['A|B'], ['none'], 1);
    expect(md).toBe('| A\\|B |\n| --- |\n|  |\n');
  });

  it('falls back to "Column N" for a blank header cell', () => {
    const md = buildTableMarkdown(['', 'Given'], ['none', 'none'], 1);
    expect(md).toBe('| Column 1 | Given |\n| --- | --- |\n|  |  |\n');
  });
});

describe('parseDelimitedSelection', () => {
  it('parses a pipe-delimited selection', () => {
    const parsed = parseDelimitedSelection('Window | Cut-off | Credit\nW1 | 13:00 | T+0\nW2 | 23:30 | T+1');
    expect(parsed).toEqual({
      headers: ['Window', 'Cut-off', 'Credit'],
      bodyRowCount: 2,
      delimiter: 'pipe',
    });
  });

  it('parses a tab-delimited selection', () => {
    const parsed = parseDelimitedSelection('Window\tCut-off\tCredit\nW1\t13:00\tT+0');
    expect(parsed).toEqual({
      headers: ['Window', 'Cut-off', 'Credit'],
      bodyRowCount: 1,
      delimiter: 'tab',
    });
  });

  it('parses a comma-delimited selection', () => {
    const parsed = parseDelimitedSelection('Window,Cut-off,Credit\nW1,13:00,T+0\nW2,23:30,T+1');
    expect(parsed).toEqual({
      headers: ['Window', 'Cut-off', 'Credit'],
      bodyRowCount: 2,
      delimiter: 'comma',
    });
  });

  it('returns null for an unparsable single-column selection', () => {
    expect(parseDelimitedSelection('just some plain text')).toBeNull();
  });

  it('returns null for an empty selection', () => {
    expect(parseDelimitedSelection('')).toBeNull();
  });
});
