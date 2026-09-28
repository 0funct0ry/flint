import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { RightSidebar } from '../components/RightSidebar';
import { NoteFixture } from '../types';

describe('RightSidebar', () => {
  const sampleNote: NoteFixture = {
    path: 'projects/payments/settlement.md',
    title: 'Settlement windows',
    folder: 'projects/payments',
    content: 'Some note text',
    renderedHtml: '<p>Some note text</p>',
    headings: [],
    tags: ['payments', 'finance'],
    lastModifiedAgo: '1m ago',
    outgoingLinks: [
      {
        source: 'projects/payments/settlement.md',
        raw_target: './rails.md',
        resolved: 'projects/payments/rails.md',
        line: 14,
        col: 5,
        context: 'See [the rails note](./rails.md)',
      },
      {
        source: 'projects/payments/settlement.md',
        raw_target: './missing-recon.md',
        resolved: null,
        line: 20,
        col: 10,
        context: 'Recon live at [recon](./missing-recon.md)',
      },
      {
        source: 'projects/payments/settlement.md',
        raw_target: 'https://flint.sh',
        resolved: null,
        line: 30,
        col: 1,
        context: 'Check [website](https://flint.sh)',
      },
    ],
    backlinks: [
      {
        sourcePath: 'projects/payments/rails.md',
        sourceTitle: 'Payment rails overview',
        folder: 'projects/payments',
        occurrences: [
          { line: 22, context: 'each window in [settlement](./settlement.md) maps to…' },
        ],
      },
    ],
  };

  it('renders backlinks and navigates on click', () => {
    const onNavigate = vi.fn();
    render(<RightSidebar note={sampleNote} onNavigate={onNavigate} />);

    expect(screen.getByText(/Backlinks · 1 from 1 note/)).toBeInTheDocument();
    expect(screen.getByText('Payment rails overview')).toBeInTheDocument();

    fireEvent.click(screen.getByText('Payment rails overview'));
    expect(onNavigate).toHaveBeenCalledWith('projects/payments/rails.md');
  });

  it('renders outgoing links and differentiates resolved, broken, and external links', () => {
    const onNavigate = vi.fn();
    const onCreateNote = vi.fn();
    const onOpenExternal = vi.fn();

    render(
      <RightSidebar
        note={sampleNote}
        onNavigate={onNavigate}
        onCreateNote={onCreateNote}
        onOpenExternal={onOpenExternal}
      />
    );

    expect(screen.getByText(/Outgoing · 3/)).toBeInTheDocument();

    // 1. Resolved link
    const resolvedLink = screen.getByText('rails.md');
    expect(resolvedLink).toBeInTheDocument();
    fireEvent.click(resolvedLink);
    expect(onNavigate).toHaveBeenCalledWith('projects/payments/rails.md');

    // 2. Broken link
    const brokenLink = screen.getByText('missing-recon.md — create');
    expect(brokenLink).toBeInTheDocument();
    fireEvent.click(brokenLink);
    expect(onCreateNote).toHaveBeenCalledWith('projects/payments/missing-recon.md');

    // 3. External link
    const externalLink = screen.getByText('https://flint.sh');
    expect(externalLink).toBeInTheDocument();
    fireEvent.click(externalLink);
    expect(onOpenExternal).toHaveBeenCalledWith('https://flint.sh');
  });

  it('switches to the Frontmatter tab via click and shows its fields', () => {
    const onNavigate = vi.fn();
    const noteWithFrontmatter: NoteFixture = {
      ...sampleNote,
      frontMatterFields: [
        ['title', 'Settlement windows'],
        ['tags', '[payments, bbps]'],
      ],
    };

    render(<RightSidebar note={noteWithFrontmatter} onNavigate={onNavigate} />);

    expect(screen.queryByText('title')).not.toBeInTheDocument();

    const frontmatterTab = screen.getByRole('tab', { name: 'Frontmatter' });
    fireEvent.click(frontmatterTab);

    expect(frontmatterTab).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByText('title')).toBeInTheDocument();
    expect(screen.getByText('[payments, bbps]')).toBeInTheDocument();
  });

  it('traverses tabs with arrow keys', () => {
    const onNavigate = vi.fn();
    render(<RightSidebar note={sampleNote} onNavigate={onNavigate} />);

    const linksTab = screen.getByRole('tab', { name: 'Links' });
    const frontmatterTab = screen.getByRole('tab', { name: 'Frontmatter' });

    linksTab.focus();
    fireEvent.keyDown(linksTab, { key: 'ArrowRight' });
    expect(frontmatterTab).toHaveAttribute('aria-selected', 'true');

    fireEvent.keyDown(frontmatterTab, { key: 'ArrowLeft' });
    expect(linksTab).toHaveAttribute('aria-selected', 'true');
  });

  it('shows the empty state with an Add field row when there is no front matter', () => {
    const onNavigate = vi.fn();
    render(<RightSidebar note={sampleNote} onNavigate={onNavigate} />);

    fireEvent.click(screen.getByRole('tab', { name: 'Frontmatter' }));

    expect(screen.getByText('No front-matter fields.')).toBeInTheDocument();
    expect(screen.getByText('+ Add field')).toBeInTheDocument();
  });

  it('calls onFrontmatterSave with an edited field value', () => {
    const onNavigate = vi.fn();
    const onFrontmatterSave = vi.fn();
    const noteWithFrontmatter: NoteFixture = {
      ...sampleNote,
      frontMatterFields: [['title', 'Settlement windows']],
    };

    render(
      <RightSidebar
        note={noteWithFrontmatter}
        onNavigate={onNavigate}
        onFrontmatterSave={onFrontmatterSave}
      />
    );

    fireEvent.click(screen.getByRole('tab', { name: 'Frontmatter' }));
    fireEvent.click(screen.getByText('Settlement windows'));

    const input = screen.getByLabelText('Value for row 1');
    fireEvent.change(input, { target: { value: 'New Title' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(onFrontmatterSave).toHaveBeenCalledWith([['title', 'New Title']]);
  });

  it('shows real per-tag workspace counts and filters by tag on click (M10.25)', () => {
    const onNavigate = vi.fn();
    const onFilterByTag = vi.fn();

    render(
      <RightSidebar
        note={sampleNote}
        onNavigate={onNavigate}
        onFilterByTag={onFilterByTag}
        tagCounts={[
          { tag: 'payments', count: 4 },
          { tag: 'finance', count: 1 },
        ]}
      />
    );

    expect(screen.getByText('4')).toBeInTheDocument();
    fireEvent.click(screen.getByText('payments'));
    expect(onFilterByTag).toHaveBeenCalledWith('payments');
  });

  it('renames a tag via the context menu (M10.25)', () => {
    const onNavigate = vi.fn();
    const onTagRename = vi.fn();

    render(
      <RightSidebar
        note={sampleNote}
        onNavigate={onNavigate}
        onTagRename={onTagRename}
        tagCounts={[{ tag: 'payments', count: 2 }]}
      />
    );

    fireEvent.contextMenu(screen.getByText('payments'));
    fireEvent.click(screen.getByText('Rename tag…'));

    const input = screen.getByDisplayValue('payments');
    fireEvent.change(input, { target: { value: 'billing' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(onTagRename).toHaveBeenCalledWith('payments', 'billing');
  });
});
