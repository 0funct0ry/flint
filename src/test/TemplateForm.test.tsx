import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { TemplateForm } from '../components/TemplateForm';

describe('TemplateForm (M10.27 Journey A, inline in TemplatesScreen)', () => {
  it('creates a template with a declared variable schema and the authored body', () => {
    const onSave = vi.fn();
    render(
      <TemplateForm mode="create" initialBody={"# {{title}}\n\n"} onSave={onSave} onCancel={vi.fn()} />
    );

    fireEvent.change(screen.getByLabelText('Template name'), {
      target: { value: 'Meeting Notes' },
    });
    expect(screen.getByText(/meeting-notes\.md/)).toBeInTheDocument();

    fireEvent.click(screen.getByText('+ Add variable'));
    fireEvent.change(screen.getByLabelText('Variable 1 name'), {
      target: { value: 'project' },
    });
    fireEvent.click(screen.getByLabelText('Variable 1 required'));

    fireEvent.click(screen.getByRole('button', { name: 'Create' }));

    expect(onSave).toHaveBeenCalledWith(
      'Meeting Notes',
      [{ name: 'project', kind: 'text', default: '', required: true, options: [] }],
      '# {{title}}\n\n'
    );
  });

  it('blocks Create until every variable row has a name', () => {
    const onSave = vi.fn();
    render(<TemplateForm mode="create" initialBody="" onSave={onSave} onCancel={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('Template name'), { target: { value: 'X' } });
    fireEvent.click(screen.getByText('+ Add variable'));

    fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    expect(onSave).not.toHaveBeenCalled();
  });

  it('edit mode pre-fills variables, body, and has no name field', () => {
    const onSave = vi.fn();
    render(
      <TemplateForm
        mode="edit"
        initialVariables={[
          { name: 'client', kind: 'text', default: '', required: false, options: [] },
        ]}
        initialBody={"# {{title}}\n\nExisting body.\n"}
        onSave={onSave}
        onCancel={vi.fn()}
      />
    );
    expect(screen.queryByLabelText('Template name')).not.toBeInTheDocument();
    expect(screen.getByDisplayValue('client')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(onSave).toHaveBeenCalledWith(
      '',
      [{ name: 'client', kind: 'text', default: '', required: false, options: [] }],
      '# {{title}}\n\nExisting body.\n'
    );
  });

  it('calls onCancel on Escape', () => {
    const onCancel = vi.fn();
    render(<TemplateForm mode="create" initialBody="" onSave={vi.fn()} onCancel={onCancel} />);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onCancel).toHaveBeenCalled();
  });
});
