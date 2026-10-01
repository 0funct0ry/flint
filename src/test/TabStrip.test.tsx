import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { TabStrip } from '../components/TabStrip';
import { makeTab } from '../state/panes';

function setup(overrides: Partial<React.ComponentProps<typeof TabStrip>> = {}) {
  const a = makeTab('a.md', 'split');
  const b = { ...makeTab('b.md', 'split'), isDirty: true };
  const c = { ...makeTab('c.md', 'split'), pinned: true };
  const props = {
    paneId: 'p1',
    tabs: [c, a, b],
    activeTabId: a.id,
    isActivePane: true,
    titleFor: (t: { path: string }) => t.path.replace('.md', ''),
    onActivate: vi.fn(),
    onClose: vi.fn(),
    onCloseOthers: vi.fn(),
    onCloseToRight: vi.fn(),
    onTogglePin: vi.fn(),
    onMoveToOtherPane: vi.fn(),
    onReorder: vi.fn(),
    ...overrides,
  };
  render(<TabStrip {...props} />);
  return { props, a, b, c };
}

describe('TabStrip', () => {
  it('renders tabs with selection, dirty dot and a pin indicator instead of × for pinned tabs', () => {
    const { a } = setup();
    expect(screen.getAllByRole('tab')).toHaveLength(3);
    expect(screen.getByTitle('a.md')).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByLabelText('Unsaved changes')).toBeInTheDocument();
    expect(screen.getByLabelText('Unpin c')).toBeInTheDocument();
    expect(screen.queryByLabelText('Close c')).toBeNull();
    expect(screen.getByLabelText('Close a')).toBeInTheDocument();
    expect(a.id).toBeTruthy();
  });

  it('click activates, × closes, middle-click closes', () => {
    const { props, a, b } = setup();
    fireEvent.click(screen.getByTitle('b.md'));
    expect(props.onActivate).toHaveBeenCalledWith(b.id);
    fireEvent.click(screen.getByLabelText('Close a'));
    expect(props.onClose).toHaveBeenCalledWith(a.id);
    fireEvent(screen.getByTitle('b.md'), new MouseEvent('auxclick', { bubbles: true, button: 1 }));
    expect(props.onClose).toHaveBeenCalledWith(b.id);
  });

  it('arrow keys move between tabs with roving tabindex', () => {
    const { props, b } = setup();
    const active = screen.getByTitle('a.md');
    expect(active).toHaveAttribute('tabindex', '0');
    fireEvent.keyDown(active, { key: 'ArrowRight' });
    expect(props.onActivate).toHaveBeenCalledWith(b.id);
  });

  it('right-click opens the context menu with pane actions', () => {
    const { props, a } = setup();
    fireEvent.contextMenu(screen.getByTitle('a.md'));
    fireEvent.click(screen.getByText('Move to other pane'));
    expect(props.onMoveToOtherPane).toHaveBeenCalledWith(a.id);
    fireEvent.contextMenu(screen.getByTitle('a.md'));
    fireEvent.click(screen.getByText('Pin'));
    expect(props.onTogglePin).toHaveBeenCalledWith(a.id);
  });

  it('drag reorders within the pane', () => {
    const { props } = setup();
    const tabs = screen.getAllByRole('tab');
    const dt = { setData: vi.fn(), effectAllowed: '' };
    fireEvent.dragStart(tabs[1], { dataTransfer: dt });
    fireEvent.dragOver(tabs[2], { dataTransfer: dt });
    fireEvent.drop(tabs[2], { dataTransfer: dt });
    expect(props.onReorder).toHaveBeenCalledWith(1, 2);
  });

  it('renders nothing for an empty pane', () => {
    const { container } = render(
      <TabStrip
        paneId="p"
        tabs={[]}
        activeTabId={null}
        isActivePane
        titleFor={() => ''}
        onActivate={vi.fn()}
        onClose={vi.fn()}
        onCloseOthers={vi.fn()}
        onCloseToRight={vi.fn()}
        onTogglePin={vi.fn()}
        onMoveToOtherPane={vi.fn()}
        onReorder={vi.fn()}
      />
    );
    expect(container).toBeEmptyDOMElement();
  });
});
