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
});
