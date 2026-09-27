import { describe, it, expect } from 'vitest';
import { parseFrontMatter, setFrontMatterFields } from '../services/frontmatter';

describe('parseFrontMatter', () => {
  it('parses ordered key/value fields from an existing block', () => {
    const content = '---\ntitle: Safe Note\nauthor: Alice\ntags: [tag1, tag2]\n---\nBody text.\n';
    const { body, fields } = parseFrontMatter(content);
    expect(body).toBe('Body text.\n');
    expect(fields).toEqual([
      ['title', 'Safe Note'],
      ['author', 'Alice'],
      ['tags', '[tag1, tag2]'],
    ]);
  });

  it('picks up a field added by hand directly in the markdown text', () => {
    // Simulates a user typing a brand-new key into the frontmatter block in the editor.
    const before = '---\ntitle: Safe Note\n---\nBody.\n';
    const after = '---\ntitle: Safe Note\nstatus: draft\n---\nBody.\n';

    expect(parseFrontMatter(before).fields).toEqual([['title', 'Safe Note']]);
    expect(parseFrontMatter(after).fields).toEqual([
      ['title', 'Safe Note'],
      ['status', 'draft'],
    ]);
  });

  it('returns no fields for a note with no front matter', () => {
    const { raw, fields, body } = parseFrontMatter('# Heading\n\nBody.\n');
    expect(raw).toBeNull();
    expect(fields).toEqual([]);
    expect(body).toBe('# Heading\n\nBody.\n');
  });
});

describe('setFrontMatterFields', () => {
  it('edits one field while leaving other lines and the body untouched', () => {
    const content = '---\ntitle: Safe Note\nauthor: Alice\ncustom_field: preserve_me\n---\n# Heading\n\nBody.\n';
    const fields = parseFrontMatter(content).fields;
    fields[0] = ['title', 'New Title'];
    expect(setFrontMatterFields(content, fields)).toBe(
      '---\ntitle: New Title\nauthor: Alice\ncustom_field: preserve_me\n---\n# Heading\n\nBody.\n'
    );
  });

  it('creates a new front-matter block for a note that has none', () => {
    expect(setFrontMatterFields('# Heading\n\nBody.\n', [['title', 'New']])).toBe(
      '---\ntitle: New\n---\n# Heading\n\nBody.\n'
    );
  });

  it('drops the block entirely when all fields are removed', () => {
    expect(setFrontMatterFields('---\ntitle: Safe Note\n---\nBody.\n', [])).toBe('Body.\n');
  });
});
