import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { CenterPane } from '../components/CenterPane';
import { NoteFixture } from '../types';

describe('CenterPane', () => {
  const sampleNote: NoteFixture = {
    path: 'projects/payments/settlement.md',
    title: 'Settlement windows',
    folder: 'projects/payments',
    content: '# Settlement windows\n\nContent here.\n',
    renderedHtml: '<h1>Settlement windows</h1><p>Content here.</p>',
    headings: [{ level: 1, text: 'Settlement windows', anchor: 'settlement-windows' }],
    outgoingLinks: [],
    backlinks: [],
    tags: ['payments'],
    lastModifiedAgo: '1m ago',
  };

  it('renders note bar with path and last modified info', () => {
    render(
      <CenterPane
        note={sampleNote}
        viewMode="split"
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

    expect(screen.getByText('projects/payments/settlement.md')).toBeInTheDocument();
    expect(screen.getByText('· 1m ago')).toBeInTheDocument();
  });

  it('displays unsaved dirty indicator dot when dirty', () => {
    const { rerender } = render(
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

    const dot = screen.getByTitle('Saved');
    expect(dot).toHaveClass('opacity-0');

    rerender(
      <CenterPane
        note={sampleNote}
        viewMode="edit"
        isDirty={true}
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

    expect(screen.getByTitle('Unsaved changes')).toHaveClass('opacity-100');
  });
});
