import { describe, it, expect } from 'vitest';
import { api } from '../services/ipc';

// M10.26: template rendering and daily-notes behavior, exercised through the browser mock
// (the same one dev/test runs use when not inside the real Tauri app).

describe('templatesList (browser mock)', () => {
  it('returns at least the seeded "daily" template', async () => {
    const templates = await api.templatesList();
    expect(templates.some((t) => t.name === 'daily' && t.path === 'daily.md')).toBe(true);
  });
});

describe('noteCreate with a template path (browser mock)', () => {
  it('renders {{title}}/{{path}} placeholders from the named template', async () => {
    const meta = await api.noteCreate('journal/entry-1.md', 'daily.md');
    const note = await api.noteRead('journal/entry-1.md');

    expect(meta.path).toBe('journal/entry-1.md');
    expect(note.content).toContain('## Notes');
    expect(note.content).toMatch(/^# \d{4}-\d{2}-\d{2}/);
  });

  it('creates an empty note when no template is given and insertHeading is off', async () => {
    await api.noteCreate('journal/blank.md');
    const note = await api.noteRead('journal/blank.md');
    expect(note.content).toBe('');
  });
});

describe('dailyNoteOpen (browser mock)', () => {
  it('creates the note for an explicit date at most once', async () => {
    const first = await api.dailyNoteOpen(undefined, '2026-09-28');
    expect(first.path).toBe('daily/2026-09-28.md');

    const second = await api.dailyNoteOpen(undefined, '2026-09-28');
    expect(second.path).toBe(first.path);
    expect(second.modified_ms).toBe(first.modified_ms);
  });

  it('offsets from today for yesterday/tomorrow', async () => {
    const today = await api.dailyNoteOpen(0);
    const yesterday = await api.dailyNoteOpen(-1);
    const tomorrow = await api.dailyNoteOpen(1);

    expect(yesterday.path).not.toBe(today.path);
    expect(tomorrow.path).not.toBe(today.path);
  });
});
