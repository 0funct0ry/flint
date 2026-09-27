import { describe, it, expect } from 'vitest';
import { api } from '../services/ipc';

describe('frontmatter fields stay in sync with manually edited content (browser mock)', () => {
  it('reflects a field added by hand to the markdown file on the next read', async () => {
    const path = 'ipc-test/manual-edit.md';
    await api.noteWrite(path, '---\ntitle: Original\n---\n# Original\n\nBody.\n');

    let read = await api.noteRead(path);
    expect(read.front_matter_fields).toEqual([['title', 'Original']]);

    // Simulate the user typing a new key directly into the frontmatter block and it autosaving.
    await api.noteWrite(
      path,
      '---\ntitle: Original\nstatus: draft\n---\n# Original\n\nBody.\n',
      read.fingerprint
    );

    read = await api.noteRead(path);
    expect(read.front_matter_fields).toEqual([
      ['title', 'Original'],
      ['status', 'draft'],
    ]);
  });
});
