import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { TemplatesScreen } from '../components/TemplatesScreen';
import { api } from '../services/ipc';

describe('TemplatesScreen (M10.27 Journey A, first-class screen)', () => {
  beforeEach(async () => {
    await api.templateCreate(
      'meeting-notes',
      [{ name: 'project', kind: 'text', default: '', required: false, options: [] }],
      '# {{title}}\n\n{{var:project}}\n'
    );
  });

  it('lists templates with an icon-only delete button (no visible "Delete" text)', async () => {
    render(<TemplatesScreen onClose={vi.fn()} />);
    await screen.findByText('meeting-notes');

    expect(screen.getByLabelText('Delete template "meeting-notes"')).toBeInTheDocument();
    expect(screen.queryByText('Delete')).not.toBeInTheDocument();
  });

  it('renames a template via the inline rename affordance', async () => {
    render(<TemplatesScreen onClose={vi.fn()} />);
    await screen.findByText('meeting-notes');

    fireEvent.click(screen.getByLabelText('Rename template "meeting-notes"'));
    const input = screen.getByLabelText('Rename template "meeting-notes"');
    fireEvent.change(input, { target: { value: 'standup-notes' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => expect(screen.getByText('standup-notes')).toBeInTheDocument());
    expect(screen.queryByText('meeting-notes')).not.toBeInTheDocument();

    // The renamed file's content survived the move.
    const body = await api.templateBodyGet('standup-notes.md');
    expect(body).toContain('{{var:project}}');
  });

  it('cancels an in-progress rename on Escape without changing the name', async () => {
    render(<TemplatesScreen onClose={vi.fn()} />);
    await screen.findByText('meeting-notes');

    fireEvent.click(screen.getByLabelText('Rename template "meeting-notes"'));
    const input = screen.getByLabelText('Rename template "meeting-notes"');
    fireEvent.change(input, { target: { value: 'Something Else' } });
    fireEvent.keyDown(input, { key: 'Escape' });

    expect(screen.getByText('meeting-notes')).toBeInTheDocument();
    expect(screen.queryByText('Something Else')).not.toBeInTheDocument();
  });

  it('deletes a template after confirming in the dialog', async () => {
    render(<TemplatesScreen onClose={vi.fn()} />);
    await screen.findByText('meeting-notes');

    fireEvent.click(screen.getByLabelText('Delete template "meeting-notes"'));
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));

    await waitFor(() => expect(screen.queryByText('meeting-notes')).not.toBeInTheDocument());
  });
});
