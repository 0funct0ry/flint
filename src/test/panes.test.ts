import { describe, it, expect } from 'vitest';
import {
  createLayout,
  openNote,
  openInNewTab,
  closeTab,
  closeOthers,
  closeToRight,
  togglePin,
  reorderTab,
  moveToOtherPane,
  renamePath,
  markMissing,
  closeTabsUnder,
  newPane,
  patchTabByPath,
  stepHistory,
  pushMru,
  serializeLayout,
  restoreLayout,
  tabIdForShortcut,
  findTabByPath,
  getActivePane,
  getActiveTab,
  MRU_LIMIT,
} from '../state/panes';

const paths = (l: ReturnType<typeof createLayout>, i = 0) => l.panes[i].tabs.map((t) => t.path);

function withTabs(...ps: string[]) {
  let l = createLayout();
  for (const p of ps) l = openInNewTab(l, p);
  return l;
}

describe('openNote', () => {
  it('creates a tab in an empty pane, then replaces the active tab with history', () => {
    let l = openNote(createLayout(), 'a.md');
    expect(paths(l)).toEqual(['a.md']);
    l = openNote(l, 'b.md');
    expect(paths(l)).toEqual(['b.md']);
    const tab = getActiveTab(l)!;
    expect(tab.history.map((h) => h.path)).toEqual(['a.md', 'b.md']);
    expect(tab.historyIndex).toBe(1);
  });

  it('focuses an existing tab instead of duplicating, across panes', () => {
    let l = withTabs('a.md', 'b.md');
    l = openNote(l, 'c.md', { newPane: true });
    expect(l.panes).toHaveLength(2);
    l = openNote(l, 'a.md');
    expect(findTabByPath(l, 'a.md')).not.toBeNull();
    expect(l.panes.flatMap((p) => p.tabs).filter((t) => t.path === 'a.md')).toHaveLength(1);
    expect(getActivePane(l).id).toBe(l.panes[0].id);
    expect(getActiveTab(l)!.path).toBe('a.md');
  });

  it('newPane opens in a second pane, creating it once', () => {
    let l = openNote(createLayout(), 'a.md');
    l = openNote(l, 'b.md', { newPane: true });
    expect(l.panes).toHaveLength(2);
    expect(paths(l, 1)).toEqual(['b.md']);
    expect(getActivePane(l).id).toBe(l.panes[1].id);
    l = openNote(l, 'c.md', { newPane: true });
    expect(l.panes).toHaveLength(2); // never more than two
    expect(paths(l, 0)).toEqual(['a.md', 'c.md']);
  });

  it('opens a new tab rather than replacing a pinned active tab', () => {
    let l = openNote(createLayout(), 'a.md');
    l = togglePin(l, getActiveTab(l)!.id);
    l = openNote(l, 'b.md');
    expect(paths(l)).toEqual(['a.md', 'b.md']);
  });
});

describe('close', () => {
  it('activates the neighbour and collapses an emptied pane', () => {
    let l = withTabs('a.md', 'b.md', 'c.md');
    const b = findTabByPath(l, 'b.md')!.tab.id;
    l = closeTab({ ...l }, getActiveTab(l)!.id); // closes c
    expect(getActiveTab(l)!.path).toBe('b.md');
    l = closeTab(l, b);
    expect(getActiveTab(l)!.path).toBe('a.md');
  });

  it('collapses a pane when its last tab closes but never leaves zero panes', () => {
    let l = openNote(createLayout(), 'a.md');
    l = openNote(l, 'b.md', { newPane: true });
    l = closeTab(l, findTabByPath(l, 'b.md')!.tab.id);
    expect(l.panes).toHaveLength(1);
    expect(getActivePane(l).id).toBe(l.panes[0].id);
    l = closeTab(l, findTabByPath(l, 'a.md')!.tab.id);
    expect(l.panes).toHaveLength(1);
    expect(l.panes[0].tabs).toHaveLength(0);
    expect(getActiveTab(l)).toBeNull();
  });

  it('closeOthers keeps pinned tabs and the target', () => {
    let l = withTabs('a.md', 'b.md', 'c.md', 'd.md');
    l = togglePin(l, findTabByPath(l, 'a.md')!.tab.id);
    l = closeOthers(l, findTabByPath(l, 'c.md')!.tab.id);
    expect(paths(l)).toEqual(['a.md', 'c.md']);
    expect(getActiveTab(l)!.path).toBe('c.md');
  });

  it('closeToRight closes unpinned tabs right of the target', () => {
    let l = withTabs('a.md', 'b.md', 'c.md', 'd.md');
    l = closeToRight(l, findTabByPath(l, 'b.md')!.tab.id);
    expect(paths(l)).toEqual(['a.md', 'b.md']);
  });

  it('closeTabsUnder removes a note or a folder of notes', () => {
    let l = withTabs('x/a.md', 'x/b.md', 'y.md');
    l = closeTabsUnder(l, 'x');
    expect(paths(l)).toEqual(['y.md']);
  });
});

describe('pin / reorder / move', () => {
  it('pinned tabs sort first and stay first after reorder', () => {
    let l = withTabs('a.md', 'b.md', 'c.md');
    l = togglePin(l, findTabByPath(l, 'c.md')!.tab.id);
    expect(paths(l)).toEqual(['c.md', 'a.md', 'b.md']);
    l = reorderTab(l, l.panes[0].id, 2, 0);
    expect(paths(l)).toEqual(['c.md', 'b.md', 'a.md']);
    l = reorderTab(l, l.panes[0].id, 0, 2); // pinned cannot sink below unpinned
    expect(paths(l)[0]).toBe('c.md');
  });

  it('moveToOtherPane creates pane 2 and collapses an emptied source pane', () => {
    let l = openNote(createLayout(), 'a.md');
    l = moveToOtherPane(l, getActiveTab(l)!.id);
    // Only tab moved out of pane 1 → pane 1 collapses, leaving exactly one pane holding it.
    expect(l.panes).toHaveLength(1);
    expect(paths(l)).toEqual(['a.md']);

    l = withTabs('a.md', 'b.md');
    l = moveToOtherPane(l, findTabByPath(l, 'b.md')!.tab.id);
    expect(l.panes).toHaveLength(2);
    expect(paths(l, 0)).toEqual(['a.md']);
    expect(paths(l, 1)).toEqual(['b.md']);
  });
});

describe('rename / delete', () => {
  it('renamePath updates every tab and history entry in place, keeping ids', () => {
    let l = openNote(createLayout(), 'a.md');
    l = openNote(l, 'b.md', { newPane: true });
    const idA = findTabByPath(l, 'a.md')!.tab.id;
    l = renamePath(l, 'a.md', 'renamed.md');
    expect(findTabByPath(l, 'renamed.md')!.tab.id).toBe(idA);
    expect(findTabByPath(l, 'a.md')).toBeNull();
    expect(findTabByPath(l, 'renamed.md')!.tab.history[0].path).toBe('renamed.md');
  });

  it('renamePath handles folder prefixes', () => {
    let l = withTabs('dir/a.md', 'dir/b.md', 'other.md');
    l = renamePath(l, 'dir', 'moved');
    expect(paths(l)).toEqual(['moved/a.md', 'moved/b.md', 'other.md']);
  });

  it('markMissing keeps the tab open and flags it', () => {
    let l = withTabs('a.md', 'b.md');
    l = patchTabByPath(l, 'a.md', { isDirty: true });
    l = markMissing(l, 'a.md');
    expect(paths(l)).toEqual(['a.md', 'b.md']);
    expect(findTabByPath(l, 'a.md')!.tab.missing).toBe(true);
    expect(findTabByPath(l, 'b.md')!.tab.missing).toBeFalsy();
  });
});

describe('history', () => {
  it('steps per-tab history back and forward', () => {
    let l = openNote(createLayout(), 'a.md');
    l = openNote(l, 'b.md');
    const id = getActiveTab(l)!.id;
    const back = stepHistory(l, id, -1)!;
    expect(back.entry.path).toBe('a.md');
    expect(getActiveTab(back.layout)!.path).toBe('a.md');
    expect(stepHistory(back.layout, id, -1)).toBeNull();
    const fwd = stepHistory(back.layout, id, 1)!;
    expect(getActiveTab(fwd.layout)!.path).toBe('b.md');
  });

  it('tabs keep independent histories', () => {
    let l = openNote(createLayout(), 'a.md');
    l = openNote(l, 'b.md');
    l = openInNewTab(l, 'c.md');
    expect(getActiveTab(l)!.history).toHaveLength(1);
  });
});

describe('shortcuts and MRU', () => {
  it('⌘1..8 pick the Nth tab and ⌘9 always the last', () => {
    const l = withTabs('a.md', 'b.md', 'c.md', 'd.md', 'e.md', 'f.md', 'g.md', 'h.md', 'i.md', 'j.md', 'k.md');
    const pane = l.panes[0];
    expect(pane.tabs.find((t) => t.id === tabIdForShortcut(pane, 2))!.path).toBe('b.md');
    expect(pane.tabs.find((t) => t.id === tabIdForShortcut(pane, 9))!.path).toBe('k.md');
    expect(tabIdForShortcut(createLayout().panes[0], 1)).toBeNull();
    expect(tabIdForShortcut(withTabs('a.md').panes[0], 5)).toBeNull();
  });

  it('pushMru dedupes, is most-recent-first, and caps at 20', () => {
    let m: string[] = [];
    for (let i = 0; i < 25; i++) m = pushMru(m, `n${i}.md`);
    expect(m).toHaveLength(MRU_LIMIT);
    expect(m[0]).toBe('n24.md');
    m = pushMru(m, 'n10.md');
    expect(m[0]).toBe('n10.md');
    expect(m.filter((p) => p === 'n10.md')).toHaveLength(1);
  });
});

describe('persistence', () => {
  it('round-trips structure across two panes', () => {
    let l = withTabs('a.md', 'b.md', 'c.md');
    l = togglePin(l, findTabByPath(l, 'b.md')!.tab.id);
    l = moveToOtherPane(l, findTabByPath(l, 'c.md')!.tab.id);
    l = openNote(l, 'd.md', { newPane: true });
    l = { ...l, orientation: 'horizontal' };
    const persisted = JSON.parse(JSON.stringify(serializeLayout(l)));
    const restored = restoreLayout(persisted, () => true)!;
    expect(restored.panes.map((p) => p.tabs.map((t) => [t.path, t.pinned]))).toEqual(
      l.panes.map((p) => p.tabs.map((t) => [t.path, t.pinned]))
    );
    expect(getActiveTab(restored)!.path).toBe(getActiveTab(l)!.path);
    expect(restored.orientation).toBe('horizontal');
  });

  it('skips paths that no longer exist, and returns null when nothing survives', () => {
    const l = withTabs('a.md', 'gone.md');
    const persisted = serializeLayout(l);
    const restored = restoreLayout(persisted, (p) => p !== 'gone.md')!;
    expect(paths(restored)).toEqual(['a.md']);
    expect(restoreLayout(persisted, () => false)).toBeNull();
    expect(restoreLayout(undefined, () => true)).toBeNull();
    expect(restoreLayout({ panes: 'nope' }, () => true)).toBeNull();
  });

  it('newPane adds an empty pane once, then just focuses the other', () => {
    let l = openNote(createLayout(), 'a.md');
    l = newPane(l);
    expect(l.panes).toHaveLength(2);
    l = newPane(l);
    expect(l.panes).toHaveLength(2);
  });
});
