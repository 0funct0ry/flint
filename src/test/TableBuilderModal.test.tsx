import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { CenterPane } from '../components/CenterPane';
import { commandRegistry } from '../commands/registry';
import { NoteFixture } from '../types';

describe('Table builder (M10.08)', () => {
  const sampleNote: NoteFixture = {
    path: 'projects/payments/settlement.md',
    title: 'Settlement windows',
    folder: 'projects/payments',
    content: '# Settlement windows\n\nContent here.\n',
    renderedHtml: '<h1>Settlement windows</h1><p>Content here.</p>',
    headings: [],
    outgoingLinks: [],
    backlinks: [],
    tags: [],
    lastModifiedAgo: '1m ago',
  };

  it('opens via editor.insert_table_builder and inserts a blank 2x1 table at the cursor', async () => {
    render(
      <CenterPane
        note={sampleNote}
        viewMode="edit"
        isDirty={false}
        onContentChange={vi.fn()}
        onNavigateRelative={vi.fn()}
        showConflictBanner={false}
        onKeepVersion={vi.fn()}
        onLoadFromDisk={vi.fn()}
        onShowDifferences={vi.fn()}
        onBack={vi.fn()}
        onForward={vi.fn()}
      />
    );

    act(() => {
      commandRegistry.execute('editor.insert_table_builder');
    });

    expect(await screen.findByRole('dialog', { name: 'Insert table' })).toBeInTheDocument();

    const insertBtn = screen.getByRole('button', { name: 'Insert' });
    act(() => {
      fireEvent.click(insertBtn);
    });

    expect(screen.queryByRole('dialog', { name: 'Insert table' })).not.toBeInTheDocument();
  });

  it('supports Escape to cancel without inserting', async () => {
    render(
      <CenterPane
        note={sampleNote}
        viewMode="edit"
        isDirty={false}
        onContentChange={vi.fn()}
        onNavigateRelative={vi.fn()}
        showConflictBanner={false}
        onKeepVersion={vi.fn()}
        onLoadFromDisk={vi.fn()}
        onShowDifferences={vi.fn()}
        onBack={vi.fn()}
        onForward={vi.fn()}
      />
    );

    act(() => {
      commandRegistry.execute('editor.insert_table_builder');
    });
    expect(await screen.findByRole('dialog', { name: 'Insert table' })).toBeInTheDocument();

    act(() => {
      fireEvent.keyDown(window, { key: 'Escape' });
    });

    expect(screen.queryByRole('dialog', { name: 'Insert table' })).not.toBeInTheDocument();
  });
});
