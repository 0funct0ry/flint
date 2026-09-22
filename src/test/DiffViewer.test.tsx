import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { DiffViewer } from '../components/DiffViewer';

describe('DiffViewer', () => {
  it('does not render when isOpen is false', () => {
    const { container } = render(
      <DiffViewer
        isOpen={false}
        onClose={() => {}}
        notePath="test.md"
        bufferContent="Hello buffer"
        diskContent="Hello disk"
        onKeepVersion={() => {}}
        onLoadFromDisk={() => {}}
      />
    );
    expect(container.firstChild).toBeNull();
  });

  it('renders diff lines and buttons when open', () => {
    const onKeep = vi.fn();
    const onLoad = vi.fn();
    const onClose = vi.fn();

    render(
      <DiffViewer
        isOpen={true}
        onClose={onClose}
        notePath="notes/test.md"
        bufferContent="Line 1\nBuffer Edit\nLine 3"
        diskContent="Line 1\nDisk Edit\nLine 3"
        onKeepVersion={onKeep}
        onLoadFromDisk={onLoad}
      />
    );

    expect(screen.getByText('Diff Comparison:')).toBeInTheDocument();
    expect(screen.getByText('notes/test.md')).toBeInTheDocument();
    expect(screen.getByText('Buffer Edit')).toBeInTheDocument();
    expect(screen.getByText('Disk Edit')).toBeInTheDocument();

    const keepBtn = screen.getByRole('button', { name: /keep buffer version/i });
    const loadBtn = screen.getByRole('button', { name: /load version from disk/i });

    fireEvent.click(keepBtn);
    expect(onKeep).toHaveBeenCalledTimes(1);

    fireEvent.click(loadBtn);
    expect(onLoad).toHaveBeenCalledTimes(1);
  });
});
