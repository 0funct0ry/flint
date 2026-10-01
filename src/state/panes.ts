/**
 * Pure pane/tab state model (M10.28).
 *
 * A **pane** is a screen region that owns an ordered strip of **tabs** plus its own active tab; a
 * **tab** is one open note. `viewMode` ('edit' | 'read' | 'split') keeps its pre-existing meaning —
 * how one note is displayed — and is merely scoped per tab here. "Split panes" (this module) and
 * `viewMode: 'split'` (editor + reader) are unrelated concepts and share no state.
 *
 * Everything here is a pure function over `PaneLayout` so the rules (dedupe-focus, pinned
 * ordering, collapse-on-empty, at-least-one-pane, rename-in-place) are unit-testable without React.
 * At most two panes exist (one level of split; nested splits are out of scope).
 */
import type { ViewMode } from '../components/TitleBar';

export interface HistoryEntry {
  path: string;
  scrollTop?: number;
  cursorPos?: number;
}

export interface Tab {
  /** Stable identity independent of path, so a rename updates the tab in place. */
  id: string;
  path: string;
  viewMode: ViewMode;
  isDirty: boolean;
  cursorPos?: number;
  scrollTop?: number;
  history: HistoryEntry[];
  historyIndex: number;
  showConflictBanner: boolean;
  diskVersionContent: string | null;
  pinned: boolean;
  /** The note no longer exists on disk; the tab stays open showing an empty state. */
  missing?: boolean;
}

export interface Pane {
  id: string;
  tabs: Tab[];
  activeTabId: string | null;
}

/** 'vertical' = panes side by side (vertical divider); 'horizontal' = stacked. */
export type PaneOrientation = 'horizontal' | 'vertical';

export interface PaneLayout {
  panes: Pane[];
  activePaneId: string;
  orientation: PaneOrientation;
}

export const MRU_LIMIT = 20;

let idCounter = 0;
export function newId(prefix: string): string {
  idCounter += 1;
  return `${prefix}-${Date.now().toString(36)}-${idCounter.toString(36)}`;
}

export function makeTab(path: string, viewMode: ViewMode, pinned = false): Tab {
  return {
    id: newId('tab'),
    path,
    viewMode,
    isDirty: false,
    history: [{ path }],
    historyIndex: 0,
    showConflictBanner: false,
    diskVersionContent: null,
    pinned,
  };
}

function makePane(): Pane {
  return { id: newId('pane'), tabs: [], activeTabId: null };
}

export function createLayout(): PaneLayout {
  const pane = makePane();
  return { panes: [pane], activePaneId: pane.id, orientation: 'vertical' };
}

// ---------------------------------------------------------------------------------------------
// Lookups
// ---------------------------------------------------------------------------------------------

export function findTabByPath(layout: PaneLayout, path: string): { pane: Pane; tab: Tab } | null {
  for (const pane of layout.panes) {
    const tab = pane.tabs.find((t) => t.path === path);
    if (tab) return { pane, tab };
  }
  return null;
}

export function findTabById(layout: PaneLayout, tabId: string): { pane: Pane; tab: Tab } | null {
  for (const pane of layout.panes) {
    const tab = pane.tabs.find((t) => t.id === tabId);
    if (tab) return { pane, tab };
  }
  return null;
}

export function getActivePane(layout: PaneLayout): Pane {
  return layout.panes.find((p) => p.id === layout.activePaneId) ?? layout.panes[0];
}

export function getActiveTab(layout: PaneLayout): Tab | null {
  const pane = getActivePane(layout);
  return pane.tabs.find((t) => t.id === pane.activeTabId) ?? null;
}

export function getPaneActiveTab(pane: Pane): Tab | null {
  return pane.tabs.find((t) => t.id === pane.activeTabId) ?? null;
}

/** ⌘1–⌘8 → Nth tab; ⌘9 → always the last tab (browser convention). `n` is 1-based. */
export function tabIdForShortcut(pane: Pane, n: number): string | null {
  if (pane.tabs.length === 0) return null;
  if (n >= 9) return pane.tabs[pane.tabs.length - 1].id;
  return pane.tabs[n - 1]?.id ?? null;
}

// ---------------------------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------------------------

function mapPane(layout: PaneLayout, paneId: string, fn: (p: Pane) => Pane): PaneLayout {
  return { ...layout, panes: layout.panes.map((p) => (p.id === paneId ? fn(p) : p)) };
}

/** Stable-sort pinned tabs before unpinned ones. */
function sortPinned(tabs: Tab[]): Tab[] {
  return [...tabs.filter((t) => t.pinned), ...tabs.filter((t) => !t.pinned)];
}

/** Drop empty panes (keeping at least one) and make sure the active pane still exists. */
function normalize(layout: PaneLayout): PaneLayout {
  let panes = layout.panes;
  if (panes.length > 1) {
    const nonEmpty = panes.filter((p) => p.tabs.length > 0);
    // Collapse empties, but never below one pane.
    panes = nonEmpty.length > 0 ? nonEmpty : [panes[0]];
  }
  const activePaneId = panes.some((p) => p.id === layout.activePaneId) ? layout.activePaneId : panes[0].id;
  return { ...layout, panes, activePaneId };
}

function withActive(layout: PaneLayout, paneId: string, tabId: string | null): PaneLayout {
  return { ...mapPane(layout, paneId, (p) => ({ ...p, activeTabId: tabId })), activePaneId: paneId };
}

function otherPane(layout: PaneLayout, paneId: string): Pane | undefined {
  return layout.panes.find((p) => p.id !== paneId);
}

// ---------------------------------------------------------------------------------------------
// Opening / focusing
// ---------------------------------------------------------------------------------------------

export function setActiveTab(layout: PaneLayout, tabId: string): PaneLayout {
  const hit = findTabById(layout, tabId);
  if (!hit) return layout;
  return withActive(layout, hit.pane.id, tabId);
}

export function setActivePane(layout: PaneLayout, paneId: string): PaneLayout {
  if (!layout.panes.some((p) => p.id === paneId) || layout.activePaneId === paneId) return layout;
  return { ...layout, activePaneId: paneId };
}

function addTab(layout: PaneLayout, paneId: string, tab: Tab): PaneLayout {
  const next = mapPane(layout, paneId, (p) => ({
    ...p,
    tabs: sortPinned([...p.tabs, tab]),
    activeTabId: tab.id,
  }));
  return { ...next, activePaneId: paneId };
}

export interface OpenOptions {
  /** Open as a new tab in the *other* pane (creating it if only one exists) — ⇧↵. */
  newPane?: boolean;
  viewMode?: ViewMode;
}

/**
 * Open `path`. A note already open in any tab is focused, never duplicated. Otherwise it replaces
 * the active tab (pushing that tab's navigation history), unless the active tab is pinned or the
 * pane is empty, in which case a new tab is created.
 */
export function openNote(layout: PaneLayout, path: string, opts: OpenOptions = {}): PaneLayout {
  const existing = findTabByPath(layout, path);
  if (existing) return withActive(layout, existing.pane.id, existing.tab.id);

  const viewMode = opts.viewMode ?? getActiveTab(layout)?.viewMode ?? 'split';

  if (opts.newPane) {
    const active = getActivePane(layout);
    let next = layout;
    let target = otherPane(layout, active.id);
    if (!target) {
      const created = makePane();
      next = { ...layout, panes: [...layout.panes, created] };
      target = created;
    }
    return addTab(next, target.id, makeTab(path, viewMode));
  }

  const pane = getActivePane(layout);
  const activeTab = getPaneActiveTab(pane);
  if (!activeTab || activeTab.pinned) {
    return addTab(layout, pane.id, makeTab(path, viewMode));
  }
  // Stash where the reader was in the note being left, so Back restores it.
  const history = [
    ...activeTab.history
      .slice(0, activeTab.historyIndex + 1)
      .map((h, i) =>
        i === activeTab.historyIndex ? { ...h, scrollTop: activeTab.scrollTop, cursorPos: activeTab.cursorPos } : h
      ),
    { path },
  ];
  return mapPane(layout, pane.id, (p) => ({
    ...p,
    tabs: p.tabs.map((t) =>
      t.id === activeTab.id
        ? {
            ...t,
            path,
            history,
            historyIndex: history.length - 1,
            isDirty: false,
            showConflictBanner: false,
            diskVersionContent: null,
            scrollTop: undefined,
            cursorPos: undefined,
            missing: false,
          }
        : t
    ),
  }));
}

/** Open a fresh tab for `path` in the active pane (still deduped by path). */
export function openInNewTab(layout: PaneLayout, path: string, viewMode?: ViewMode): PaneLayout {
  const existing = findTabByPath(layout, path);
  if (existing) return withActive(layout, existing.pane.id, existing.tab.id);
  return addTab(layout, getActivePane(layout).id, makeTab(path, viewMode ?? getActiveTab(layout)?.viewMode ?? 'split'));
}

/** "New pane" command: add an empty second pane (or just focus the other one if it exists). */
export function newPane(layout: PaneLayout): PaneLayout {
  const active = getActivePane(layout);
  const other = otherPane(layout, active.id);
  if (other) return { ...layout, activePaneId: other.id };
  const created = makePane();
  return { ...layout, panes: [...layout.panes, created], activePaneId: created.id };
}

export function toggleOrientation(layout: PaneLayout): PaneLayout {
  return { ...layout, orientation: layout.orientation === 'vertical' ? 'horizontal' : 'vertical' };
}

// ---------------------------------------------------------------------------------------------
// Closing
// ---------------------------------------------------------------------------------------------

function removeTabs(layout: PaneLayout, paneId: string, remove: (t: Tab) => boolean): PaneLayout {
  const next = mapPane(layout, paneId, (p) => {
    const tabs = p.tabs.filter((t) => !remove(t));
    let activeTabId = p.activeTabId;
    if (!tabs.some((t) => t.id === activeTabId)) {
      // Prefer the neighbour that slid into the closed tab's slot, else the last tab.
      const oldIdx = p.tabs.findIndex((t) => t.id === p.activeTabId);
      const fallback = tabs[Math.min(Math.max(oldIdx, 0), tabs.length - 1)];
      activeTabId = fallback ? fallback.id : null;
    }
    return { ...p, tabs, activeTabId };
  });
  return normalize(next);
}

export function closeTab(layout: PaneLayout, tabId: string): PaneLayout {
  const hit = findTabById(layout, tabId);
  if (!hit) return layout;
  return removeTabs(layout, hit.pane.id, (t) => t.id === tabId);
}

/** Close every other unpinned tab in the tab's pane; the target itself is kept and activated. */
export function closeOthers(layout: PaneLayout, tabId: string): PaneLayout {
  const hit = findTabById(layout, tabId);
  if (!hit) return layout;
  const next = removeTabs(layout, hit.pane.id, (t) => t.id !== tabId && !t.pinned);
  return setActiveTab(next, tabId);
}

export function closeToRight(layout: PaneLayout, tabId: string): PaneLayout {
  const hit = findTabById(layout, tabId);
  if (!hit) return layout;
  const idx = hit.pane.tabs.findIndex((t) => t.id === tabId);
  const rightIds = new Set(hit.pane.tabs.slice(idx + 1).filter((t) => !t.pinned).map((t) => t.id));
  const next = removeTabs(layout, hit.pane.id, (t) => rightIds.has(t.id));
  return setActiveTab(next, tabId);
}

/** Tabs `closeOthers`/`closeToRight` would close — callers save dirty ones first. */
export function tabsClosedByOthers(layout: PaneLayout, tabId: string): Tab[] {
  const hit = findTabById(layout, tabId);
  return hit ? hit.pane.tabs.filter((t) => t.id !== tabId && !t.pinned) : [];
}

export function tabsClosedToRight(layout: PaneLayout, tabId: string): Tab[] {
  const hit = findTabById(layout, tabId);
  if (!hit) return [];
  const idx = hit.pane.tabs.findIndex((t) => t.id === tabId);
  return hit.pane.tabs.slice(idx + 1).filter((t) => !t.pinned);
}

/** Close every tab whose path is `path` or lives under the folder `path/`. */
export function closeTabsUnder(layout: PaneLayout, path: string): PaneLayout {
  let next = layout;
  for (const pane of layout.panes) {
    next = removeTabs(next, pane.id, (t) => t.path === path || t.path.startsWith(`${path}/`));
    // `removeTabs` may collapse panes; later panes still resolve by id.
  }
  return next;
}

// ---------------------------------------------------------------------------------------------
// Pinning, reordering, moving
// ---------------------------------------------------------------------------------------------

export function togglePin(layout: PaneLayout, tabId: string): PaneLayout {
  const hit = findTabById(layout, tabId);
  if (!hit) return layout;
  return mapPane(layout, hit.pane.id, (p) => ({
    ...p,
    tabs: sortPinned(p.tabs.map((t) => (t.id === tabId ? { ...t, pinned: !t.pinned } : t))),
  }));
}

export function reorderTab(layout: PaneLayout, paneId: string, fromIndex: number, toIndex: number): PaneLayout {
  return mapPane(layout, paneId, (p) => {
    if (fromIndex === toIndex || fromIndex < 0 || fromIndex >= p.tabs.length) return p;
    const tabs = [...p.tabs];
    const [moved] = tabs.splice(fromIndex, 1);
    tabs.splice(Math.min(Math.max(toIndex, 0), tabs.length), 0, moved);
    return { ...p, tabs: sortPinned(tabs) };
  });
}

/** Explicit "Move to other pane" — the only way a tab changes panes. Creates pane 2 if needed. */
export function moveToOtherPane(layout: PaneLayout, tabId: string): PaneLayout {
  const hit = findTabById(layout, tabId);
  if (!hit) return layout;
  let next = layout;
  let target = otherPane(layout, hit.pane.id);
  if (!target) {
    const created = makePane();
    next = { ...layout, panes: [...layout.panes, created] };
    target = created;
  }
  const { tab } = hit;
  next = mapPane(next, hit.pane.id, (p) => {
    const tabs = p.tabs.filter((t) => t.id !== tabId);
    const oldIdx = p.tabs.findIndex((t) => t.id === tabId);
    const activeTabId =
      p.activeTabId === tabId ? (tabs[Math.min(oldIdx, tabs.length - 1)]?.id ?? null) : p.activeTabId;
    return { ...p, tabs, activeTabId };
  });
  next = addTab(next, target.id, tab);
  return normalize(next);
}

// ---------------------------------------------------------------------------------------------
// Per-tab state
// ---------------------------------------------------------------------------------------------

export function patchTab(layout: PaneLayout, tabId: string, patch: Partial<Tab>): PaneLayout {
  const hit = findTabById(layout, tabId);
  if (!hit) return layout;
  return mapPane(layout, hit.pane.id, (p) => ({
    ...p,
    tabs: p.tabs.map((t) => (t.id === tabId ? { ...t, ...patch } : t)),
  }));
}

/** A path is open in at most one tab, so path-keyed updates are unambiguous. */
export function patchTabByPath(layout: PaneLayout, path: string, patch: Partial<Tab>): PaneLayout {
  const hit = findTabByPath(layout, path);
  return hit ? patchTab(layout, hit.tab.id, patch) : layout;
}

/** Step a tab's own back/forward history by `delta` (−1 / +1). Returns the target path, if any. */
export function stepHistory(
  layout: PaneLayout,
  tabId: string,
  delta: -1 | 1
): { layout: PaneLayout; entry: HistoryEntry } | null {
  const hit = findTabById(layout, tabId);
  if (!hit) return null;
  const { tab } = hit;
  const target = tab.historyIndex + delta;
  if (target < 0 || target >= tab.history.length) return null;
  const entry = tab.history[target];
  // Note: an earlier tab may already be open on this path elsewhere; `open` dedupes that case in
  // the caller. Here we just move this tab's own cursor through its own history.
  if (findTabByPath(layout, entry.path) && entry.path !== tab.path) {
    const other = findTabByPath(layout, entry.path)!;
    if (other.tab.id !== tab.id) return null;
  }
  const history = tab.history.map((h, i) =>
    i === tab.historyIndex ? { ...h, scrollTop: tab.scrollTop, cursorPos: tab.cursorPos } : h
  );
  const next = patchTab(layout, tabId, {
    path: entry.path,
    history,
    historyIndex: target,
    isDirty: false,
    showConflictBanner: false,
    diskVersionContent: null,
    scrollTop: entry.scrollTop,
    cursorPos: entry.cursorPos,
    missing: false,
  });
  return { layout: next, entry };
}

// ---------------------------------------------------------------------------------------------
// Rename / delete propagation
// ---------------------------------------------------------------------------------------------

function remapPath(p: string, from: string, to: string): string {
  if (p === from) return to;
  if (p.startsWith(`${from}/`)) return `${to}${p.slice(from.length)}`;
  return p;
}

/** Update every tab (and its history) pointing at `from` (or under folder `from/`) in place. */
export function renamePath(layout: PaneLayout, from: string, to: string): PaneLayout {
  if (from === to) return layout;
  return {
    ...layout,
    panes: layout.panes.map((p) => ({
      ...p,
      tabs: p.tabs.map((t) => {
        const path = remapPath(t.path, from, to);
        const history = t.history.map((h) => ({ ...h, path: remapPath(h.path, from, to) }));
        return path === t.path && history.every((h, i) => h.path === t.history[i].path)
          ? t
          : { ...t, path, history, missing: false };
      }),
    })),
  };
}

/** Mark tabs on `path` (or under folder `path/`) as no longer existing; tabs stay open. */
export function markMissing(layout: PaneLayout, path: string): PaneLayout {
  return {
    ...layout,
    panes: layout.panes.map((p) => ({
      ...p,
      tabs: p.tabs.map((t) =>
        t.path === path || t.path.startsWith(`${path}/`)
          ? { ...t, missing: true, isDirty: false, showConflictBanner: false }
          : t
      ),
    })),
  };
}

// ---------------------------------------------------------------------------------------------
// MRU
// ---------------------------------------------------------------------------------------------

/** Most-recent-first, deduplicated by path, capped at `MRU_LIMIT`. */
export function pushMru(list: string[], path: string): string[] {
  if (!path) return list;
  if (list[0] === path) return list;
  return [path, ...list.filter((p) => p !== path)].slice(0, MRU_LIMIT);
}

// ---------------------------------------------------------------------------------------------
// Persistence (`layout.panes`) — structure only; scroll/cursor are ephemeral.
// ---------------------------------------------------------------------------------------------

export interface PersistedTab {
  path: string;
  pinned: boolean;
  viewMode: ViewMode;
}
export interface PersistedPane {
  tabs: PersistedTab[];
  /** Index into `tabs` of the pane's active tab, or -1 for none. */
  activeIndex: number;
}
export interface PersistedPanes {
  panes: PersistedPane[];
  activePaneIndex: number;
  orientation: PaneOrientation;
}

export function serializeLayout(layout: PaneLayout): PersistedPanes {
  return {
    panes: layout.panes.map((p) => ({
      tabs: p.tabs
        .filter((t) => !t.missing)
        .map((t) => ({ path: t.path, pinned: t.pinned, viewMode: t.viewMode })),
      activeIndex: p.tabs.filter((t) => !t.missing).findIndex((t) => t.id === p.activeTabId),
    })),
    activePaneIndex: Math.max(0, layout.panes.findIndex((p) => p.id === layout.activePaneId)),
    orientation: layout.orientation,
  };
}

const VIEW_MODES: ViewMode[] = ['edit', 'read', 'split'];

/** Rebuild a layout from persisted data, skipping paths `exists` rejects. Always ≥ 1 pane. */
export function restoreLayout(
  persisted: unknown,
  exists: (path: string) => boolean,
  defaultMode: ViewMode = 'split'
): PaneLayout | null {
  const data = persisted as Partial<PersistedPanes> | null | undefined;
  if (!data || !Array.isArray(data.panes) || data.panes.length === 0) return null;
  const seen = new Set<string>();
  const panes: Pane[] = [];
  let activePaneId: string | null = null;
  data.panes.slice(0, 2).forEach((pp, paneIdx) => {
    const pane = makePane();
    const rawTabs = Array.isArray(pp?.tabs) ? pp.tabs : [];
    const tabs: Tab[] = [];
    let activeTabId: string | null = null;
    rawTabs.forEach((pt, i) => {
      if (!pt || typeof pt.path !== 'string' || seen.has(pt.path) || !exists(pt.path)) return;
      seen.add(pt.path);
      const mode = VIEW_MODES.includes(pt.viewMode) ? pt.viewMode : defaultMode;
      const tab = makeTab(pt.path, mode, !!pt.pinned);
      tabs.push(tab);
      if (i === pp.activeIndex) activeTabId = tab.id;
    });
    pane.tabs = sortPinned(tabs);
    pane.activeTabId = activeTabId ?? pane.tabs[pane.tabs.length - 1]?.id ?? null;
    panes.push(pane);
    if (paneIdx === data.activePaneIndex) activePaneId = pane.id;
  });
  const orientation: PaneOrientation = data.orientation === 'horizontal' ? 'horizontal' : 'vertical';
  const layout = normalize({ panes, activePaneId: activePaneId ?? panes[0].id, orientation });
  // Nothing survived: there is nothing to restore.
  return layout.panes.every((p) => p.tabs.length === 0) ? null : layout;
}
