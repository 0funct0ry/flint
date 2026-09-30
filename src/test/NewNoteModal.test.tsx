import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { NewNoteModal } from '../components/NewNoteModal';
import { api } from '../services/ipc';

describe('NewNoteModal (M10.27 Journey B)', () => {
  beforeEach(async () => {
    // Seed a template with one required Text variable via the real (browser-mock) API path.
    await api.templateCreate(
      'Client Note',
      [{ name: 'client', kind: 'text', default: '', required: true, options: [] }],
      '# {{title}}\n\n## {{var:client}}\n\n'
    );
  });

  it('creates a blank note fast: name pre-filled, Blank pre-selected, Enter creates', async () => {
    const onCreate = vi.fn();
    render(
      <NewNoteModal
        isOpen
        targetFolder=""
        initialName="Untitled.md"
        onCreate={onCreate}
        onCancel={vi.fn()}
      />
    );
    const nameInput = await screen.findByLabelText('Name');
    expect(nameInput).toHaveValue('Untitled.md');
    fireEvent.keyDown(nameInput, { key: 'Enter' });
    expect(onCreate).toHaveBeenCalledWith('Untitled.md', undefined, {});
  });

  it('shows variable fields once a template with variables is picked, and blocks a blank required field', async () => {
    const onCreate = vi.fn();
    render(
      <NewNoteModal
        isOpen
        targetFolder=""
        initialName="Untitled.md"
        onCreate={onCreate}
        onCancel={vi.fn()}
      />
    );
    const select = await screen.findByLabelText('Template');
    fireEvent.change(select, { target: { value: 'client-note.md' } });

    await waitFor(() => expect(screen.getByLabelText(/client/)).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    expect(onCreate).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent('client');

    fireEvent.change(screen.getByLabelText(/client/), { target: { value: 'Acme Corp' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    expect(onCreate).toHaveBeenCalledWith('Untitled.md', 'client-note.md', { client: 'Acme Corp' });
  });

  it('closes on Escape', async () => {
    const onCancel = vi.fn();
    render(
      <NewNoteModal
        isOpen
        targetFolder=""
        initialName="Untitled.md"
        onCreate={vi.fn()}
        onCancel={onCancel}
      />
    );
    await screen.findByLabelText('Name');
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onCancel).toHaveBeenCalled();
  });
});
