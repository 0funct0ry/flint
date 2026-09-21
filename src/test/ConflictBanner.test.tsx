import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ConflictBanner } from '../components/ConflictBanner';

describe('ConflictBanner', () => {
  it('does not render when visible is false', () => {
    const { container } = render(
      <ConflictBanner
        visible={false}
        onKeepVersion={() => {}}
        onLoadFromDisk={() => {}}
        onShowDifferences={() => {}}
      />
    );
    expect(container.firstChild).toBeNull();
  });

  it('renders all warning text and buttons when visible is true', () => {
    const onKeep = vi.fn();
    const onLoad = vi.fn();
    const onDiff = vi.fn();

    render(
      <ConflictBanner
        visible={true}
        onKeepVersion={onKeep}
        onLoadFromDisk={onLoad}
        onShowDifferences={onDiff}
      />
    );

    expect(
      screen.getByText('This note changed on disk.')
    ).toBeInTheDocument();
    expect(
      screen.getByText('Your unsaved edits have not been overwritten.')
    ).toBeInTheDocument();

    const keepBtn = screen.getByRole('button', { name: /keep my version/i });
    const loadBtn = screen.getByRole('button', { name: /load from disk/i });
    const diffBtn = screen.getByRole('button', { name: /show differences/i });

    expect(keepBtn).toBeInTheDocument();
    expect(loadBtn).toBeInTheDocument();
    expect(diffBtn).toBeInTheDocument();

    fireEvent.click(keepBtn);
    expect(onKeep).toHaveBeenCalledTimes(1);

    fireEvent.click(loadBtn);
    expect(onLoad).toHaveBeenCalledTimes(1);

    fireEvent.click(diffBtn);
    expect(onDiff).toHaveBeenCalledTimes(1);
  });
});
