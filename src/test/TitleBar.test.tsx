import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { TitleBar } from '../components/TitleBar';

describe('TitleBar', () => {
  it('renders breadcrumb and mode controls correctly', () => {
    const onModeChange = vi.fn();
    const onOpenPalette = vi.fn();
    const onToggleTheme = vi.fn();

    render(
      <TitleBar
        breadcrumb="projects/payments/settlement.md"
        viewMode="split"
        onViewModeChange={onModeChange}
        onOpenPalette={onOpenPalette}
        onToggleTheme={onToggleTheme}
        theme="dark"
      />
    );

    expect(screen.getByText('projects')).toBeInTheDocument();
    expect(screen.getByText('payments')).toBeInTheDocument();
    expect(screen.getByText('settlement.md')).toBeInTheDocument();

    const editBtn = screen.getByRole('button', { name: /edit/i });
    const readBtn = screen.getByRole('button', { name: /read/i });
    const splitBtn = screen.getByRole('button', { name: /split/i });

    expect(editBtn).toHaveAttribute('aria-pressed', 'false');
    expect(readBtn).toHaveAttribute('aria-pressed', 'false');
    expect(splitBtn).toHaveAttribute('aria-pressed', 'true');

    fireEvent.click(editBtn);
    expect(onModeChange).toHaveBeenCalledWith('edit');

    const searchPaletteBtn = screen.getByRole('button', { name: /search notes/i });
    fireEvent.click(searchPaletteBtn);
    expect(onOpenPalette).toHaveBeenCalledTimes(1);

    const themeToggleBtn = screen.getByRole('button', { name: /toggle theme/i });
    fireEvent.click(themeToggleBtn);
    expect(onToggleTheme).toHaveBeenCalledTimes(1);
  });
});
