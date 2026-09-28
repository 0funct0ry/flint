import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { StatusBar } from '../components/StatusBar';
import { UnresolvedLinksModal } from '../components/UnresolvedLinksModal';
import { LinkItem } from '../types';

describe('StatusBar & UnresolvedLinksModal (M7)', () => {
  it('renders stats and triggers onClickUnresolved on click', () => {
    const onClickUnresolved = vi.fn();
    render(
      <StatusBar
        workspaceName="test-vault"
        noteCount={42}
        linkCount={120}
        unresolvedCount={3}
        wordCount={100}
        charCount={500}
        onClickUnresolved={onClickUnresolved}
      />
    );

    expect(screen.getByText('test-vault')).toBeInTheDocument();
    expect(screen.getByText('42 notes')).toBeInTheDocument();
    expect(screen.getByText('120 links')).toBeInTheDocument();
    expect(screen.getByText('3 unresolved')).toBeInTheDocument();

    fireEvent.click(screen.getByText('3 unresolved'));
    expect(onClickUnresolved).toHaveBeenCalled();
  });

  it('renders indexing progress when indexing is active', () => {
    render(
      <StatusBar
        workspaceName="test-vault"
        noteCount={0}
        linkCount={0}
        unresolvedCount={0}
        wordCount={0}
        charCount={0}
        indexingProgress={{ indexed: 450, total: 1000 }}
      />
    );

    expect(screen.getByText('Indexing 450 / 1000')).toBeInTheDocument();
  });

  it('renders degraded watcher indicator when watcher is degraded', () => {
    render(
      <StatusBar
        workspaceName="test-vault"
        noteCount={10}
        linkCount={5}
        unresolvedCount={0}
        wordCount={0}
        charCount={0}
        isWatcherDegraded={true}
      />
    );

    expect(screen.getByText(/⚠️ polling \(degraded\)/)).toBeInTheDocument();
  });

  it('renders MCP listening pill with rotate-token action when auth is required (M10.21)', () => {
    const onRotateMcpToken = vi.fn();
    render(
      <StatusBar
        workspaceName="test-vault"
        noteCount={10}
        linkCount={5}
        unresolvedCount={0}
        wordCount={0}
        charCount={0}
        mcpStatus={{
          state: 'listening',
          url: 'http://127.0.0.1:4870/mcp',
          requiresAuth: true,
          hasToken: true,
        }}
        onRotateMcpToken={onRotateMcpToken}
      />
    );

    const pill = screen.getByText('mcp: listening');
    expect(pill).toBeInTheDocument();
    fireEvent.click(pill);
    expect(onRotateMcpToken).toHaveBeenCalled();
  });

  it('renders a non-interactive MCP listening pill with a no-auth warning when auth is off (M10.21)', () => {
    const onRotateMcpToken = vi.fn();
    render(
      <StatusBar
        workspaceName="test-vault"
        noteCount={10}
        linkCount={5}
        unresolvedCount={0}
        wordCount={0}
        charCount={0}
        mcpStatus={{
          state: 'listening',
          url: 'http://127.0.0.1:4870/mcp',
          requiresAuth: false,
          hasToken: false,
        }}
        onRotateMcpToken={onRotateMcpToken}
      />
    );

    const pill = screen.getByText('mcp: listening');
    expect(pill.tagName).not.toBe('BUTTON');
    fireEvent.click(pill);
    expect(onRotateMcpToken).not.toHaveBeenCalled();
    expect(screen.getByTitle(/No authentication/)).toBeInTheDocument();
  });

  it('renders MCP error pill with the error message as a tooltip', () => {
    render(
      <StatusBar
        workspaceName="test-vault"
        noteCount={10}
        linkCount={5}
        unresolvedCount={0}
        wordCount={0}
        charCount={0}
        mcpStatus={{ state: 'error', message: 'port already in use', requiresAuth: false, hasToken: false }}
      />
    );

    expect(screen.getByText('mcp: error')).toBeInTheDocument();
    expect(screen.getByTitle(/port already in use/)).toBeInTheDocument();
  });

  it('renders nothing MCP-related when the server is off (default)', () => {
    render(
      <StatusBar
        workspaceName="test-vault"
        noteCount={10}
        linkCount={5}
        unresolvedCount={0}
        wordCount={0}
        charCount={0}
      />
    );

    expect(screen.queryByText(/mcp:/)).not.toBeInTheDocument();
  });

  it('renders UnresolvedLinksModal and allows navigation / note creation', () => {
    const onClose = vi.fn();
    const onNavigateToSource = vi.fn();
    const onCreateMissingNote = vi.fn();

    const sampleUnresolved: LinkItem[] = [
      {
        source: 'projects/payments/settlement.md',
        raw_target: './missing-note.md',
        resolved: null,
        line: 12,
        col: 5,
        context: 'See [missing](./missing-note.md)',
      },
    ];

    render(
      <UnresolvedLinksModal
        isOpen={true}
        onClose={onClose}
        unresolvedLinks={sampleUnresolved}
        onNavigateToSource={onNavigateToSource}
        onCreateMissingNote={onCreateMissingNote}
      />
    );

    expect(screen.getByText(/Unresolved Links \(1\)/)).toBeInTheDocument();
    expect(screen.getByText('./missing-note.md')).toBeInTheDocument();
    expect(screen.getByText('Line 12')).toBeInTheDocument();

    // Click "Create Note"
    fireEvent.click(screen.getByText('Create Note'));
    expect(onCreateMissingNote).toHaveBeenCalledWith('./missing-note.md', 'projects/payments/settlement.md');
    expect(onClose).toHaveBeenCalled();
  });
});
