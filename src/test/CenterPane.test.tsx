import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
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

  it('renders and invokes KaTeX on inline and block math elements', () => {
    const mathNote: NoteFixture = {
      ...sampleNote,
      renderedHtml: `
        <h1 id="math-title">Math Note</h1>
        <p>Inline: <span class="flint-math-inline" data-math="E=mc^2"></span></p>
        <div class="flint-math-block" data-math="\\int_0^1 x dx"></div>
      `,
    };

    render(
      <CenterPane
        note={mathNote}
        viewMode="read"
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

    const inlineElem = document.querySelector('.flint-math-inline');
    expect(inlineElem).toBeInTheDocument();
    expect(inlineElem).toHaveAttribute('data-rendered', 'true');
    expect(inlineElem?.querySelector('.katex')).toBeInTheDocument();

    const blockElem = document.querySelector('.flint-math-block');
    expect(blockElem).toBeInTheDocument();
    expect(blockElem).toHaveAttribute('data-rendered', 'true');
    expect(blockElem?.querySelector('.katex-display')).toBeInTheDocument();
  });

  it('toggles a task checkbox in the reader pane back into the source buffer', () => {
    const taskNote: NoteFixture = {
      ...sampleNote,
      content: '# Build Task\n\n- [ ] Task 1\n- [ ] Task 2\n',
      renderedHtml:
        '<h1>Build Task</h1><ul>' +
        '<li class="task-list-item"><input type="checkbox" data-task-index="0">Task 1</li>' +
        '<li class="task-list-item"><input type="checkbox" data-task-index="1">Task 2</li>' +
        '</ul>',
    };
    const onContentChange = vi.fn();

    render(
      <CenterPane
        note={taskNote}
        viewMode="read"
        isDirty={false}
        onContentChange={onContentChange}
        onNavigateRelative={vi.fn()}
        showConflictBanner={false}
        onKeepVersion={vi.fn()}
        onLoadFromDisk={vi.fn()}
        onShowDifferences={vi.fn()}
        onBack={vi.fn()}
        onForward={vi.fn()}
      />
    );

    const checkboxes = document.querySelectorAll('input[type="checkbox"][data-task-index]');
    expect(checkboxes).toHaveLength(2);

    fireEvent.click(checkboxes[1]);

    expect(onContentChange).toHaveBeenCalledWith('# Build Task\n\n- [ ] Task 1\n- [x] Task 2\n');
  });
});
