import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { FolderVariablesModal } from '../components/FolderVariablesModal';

describe('FolderVariablesModal (M10.27 Journey C)', () => {
  it('pre-fills existing folder variables and saves edits', () => {
    const onSave = vi.fn();
    render(
      <FolderVariablesModal
        isOpen
        folderPath="clients/acme"
        initialVariables={{ client: 'Acme Corp' }}
        onSave={onSave}
        onCancel={vi.fn()}
      />
    );
    expect(screen.getByText(/clients\/acme/)).toBeInTheDocument();
    expect(screen.getByDisplayValue('Acme Corp')).toBeInTheDocument();

    fireEvent.click(screen.getByText('+ Add row'));
    const nameInputs = screen.getAllByLabelText(/name$/);
    fireEvent.change(nameInputs[nameInputs.length - 1], { target: { value: 'owner' } });
    const valueInputs = screen.getAllByLabelText(/value$/);
    fireEvent.change(valueInputs[valueInputs.length - 1], { target: { value: 'Jane' } });

    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(onSave).toHaveBeenCalledWith({ client: 'Acme Corp', owner: 'Jane' });
  });

  it('closes on Escape', () => {
    const onCancel = vi.fn();
    render(
      <FolderVariablesModal
        isOpen
        folderPath=""
        initialVariables={{}}
        onSave={vi.fn()}
        onCancel={onCancel}
      />
    );
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onCancel).toHaveBeenCalled();
  });
});
