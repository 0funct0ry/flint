import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { CommandPalette } from '../components/CommandPalette';
import { api } from '../services/ipc';

const indexed = [
  { path: 'a.md', title: 'Alpha' },
  { path: 'b.md', title: 'Beta' },
  { path: 'c.md', title: 'Gamma' },
] as any;

describe('CommandPalette recents and ⇧↵', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('shows the MRU list (in order) for an empty query', async () => {
    const spy = vi.spyOn(api, 'searchNames').mockResolvedValue([]);
    render(
      <CommandPalette
        isOpen
        onClose={vi.fn()}
        notes={{}}
        indexedNotes={indexed}
        onSelectNote={vi.fn()}
        recentNotes={['c.md', 'a.md']}
      />
    );
    await waitFor(() => expect(screen.getAllByRole('listitem')).toHaveLength(2));
    const rows = screen.getAllByRole('listitem').map((li) => li.textContent);
    expect(rows[0]).toContain('Gamma');
    expect(rows[1]).toContain('Alpha');
    spy.mockRestore();
  });

  it('a typed query still searches the full index', async () => {
    const spy = vi
      .spyOn(api, 'searchNames')
      .mockResolvedValue([{ path: 'b.md', title: 'Beta' } as any]);
    render(
      <CommandPalette
        isOpen
        onClose={vi.fn()}
        notes={{}}
        indexedNotes={indexed}
        onSelectNote={vi.fn()}
        recentNotes={['c.md']}
      />
    );
    fireEvent.change(screen.getByPlaceholderText(/Search notes/), { target: { value: 'be' } });
    await waitFor(() => expect(spy).toHaveBeenCalledWith('be', 30));
    await waitFor(() => expect(screen.getByText('Beta')).toBeInTheDocument());
  });

  it('Enter selects normally; Shift+Enter asks for a new pane', async () => {
    vi.spyOn(api, 'searchNames').mockResolvedValue([]);
    const onSelectNote = vi.fn();
    render(
      <CommandPalette
        isOpen
        onClose={vi.fn()}
        notes={{}}
        indexedNotes={indexed}
        onSelectNote={onSelectNote}
        recentNotes={['a.md']}
      />
    );
    const input = screen.getByPlaceholderText(/Search notes/);
    await waitFor(() => expect(screen.getAllByRole('listitem')).toHaveLength(1));
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onSelectNote).toHaveBeenLastCalledWith('a.md', undefined);
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: true });
    expect(onSelectNote).toHaveBeenLastCalledWith('a.md', { newPane: true });
  });

  it('Alt+Enter and newTabByDefault ask for a new tab in the active pane', async () => {
    vi.spyOn(api, 'searchNames').mockResolvedValue([]);
    const onSelectNote = vi.fn();
    const { rerender } = render(
      <CommandPalette isOpen onClose={vi.fn()} notes={{}} indexedNotes={indexed} onSelectNote={onSelectNote} recentNotes={['a.md']} />
    );
    const input = screen.getByPlaceholderText(/Search notes/);
    await waitFor(() => expect(screen.getAllByRole('listitem')).toHaveLength(1));
    fireEvent.keyDown(input, { key: 'Enter', altKey: true });
    expect(onSelectNote).toHaveBeenLastCalledWith('a.md', { newTab: true });
    rerender(
      <CommandPalette isOpen onClose={vi.fn()} notes={{}} indexedNotes={indexed} onSelectNote={onSelectNote} recentNotes={['a.md']} newTabByDefault />
    );
    fireEvent.keyDown(screen.getByPlaceholderText(/Search notes/), { key: 'Enter' });
    expect(onSelectNote).toHaveBeenLastCalledWith('a.md', { newTab: true });
  });
});
