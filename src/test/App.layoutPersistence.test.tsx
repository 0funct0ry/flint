import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, act, waitFor } from '@testing-library/react';
import { App } from '../App';
import { SettingsProvider } from '../context/SettingsContext';
import { api } from '../services/ipc';
import { commandRegistry } from '../commands/registry';

// M10.1 task 7: several rapid layout-affecting interactions within the debounce window must
// coalesce into exactly one debounced config_set call per changed layout field, not one per event.
describe('App layout persistence debouncing', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it(
    'coalesces rapid sidebar toggles into a single debounced configSet call',
    async () => {
      const configSetSpy = vi.spyOn(api, 'configSet').mockResolvedValue(undefined);

      render(
        <SettingsProvider>
          <App />
        </SettingsProvider>
      );

      // Let the initial workspace-open / settings-load async work settle.
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 50));
      });

      configSetSpy.mockClear();

      // Rapidly toggle the left sidebar several times in quick succession (well within the
      // 450ms layout-save debounce window used in App.tsx).
      act(() => {
        commandRegistry.execute('view.toggle_left_sidebar');
        commandRegistry.execute('view.toggle_left_sidebar');
        commandRegistry.execute('view.toggle_left_sidebar');
      });

      // Nothing persisted yet — still inside the debounce window.
      const callsBeforeFlush = configSetSpy.mock.calls.filter(
        ([path]) => path === 'layout.leftSidebarCollapsed'
      );
      expect(callsBeforeFlush.length).toBe(0);

      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 600));
      });

      await waitFor(() => {
        const calls = configSetSpy.mock.calls.filter(
          ([path]) => path === 'layout.leftSidebarCollapsed'
        );
        expect(calls.length).toBe(1);
      });
    },
    10000
  );

  it(
    'persists pane/tab structure and the MRU as one debounced write each (M10.28)',
    async () => {
      // jsdom has no scrollIntoView; the tree calls it when a note becomes selected.
      Element.prototype.scrollIntoView = vi.fn();
      const configSetSpy = vi.spyOn(api, 'configSet').mockResolvedValue(undefined);
      const { container } = render(
        <SettingsProvider>
          <App />
        </SettingsProvider>
      );
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 50));
      });
      configSetSpy.mockClear();

      const treeItem = (name: string) =>
        Array.from(container.querySelectorAll('[role="treeitem"]')).find(
          (el) => el.textContent?.trim() === name
        ) as HTMLElement;

      // Two quick navigations in one pane, then open the palette-style "other pane" via the
      // command registry: expect exactly one `layout.panes` write for the settled structure.
      await act(async () => {
        treeItem('settlement.md').click();
        await new Promise((resolve) => setTimeout(resolve, 20));
        treeItem('rails.md').click();
        await new Promise((resolve) => setTimeout(resolve, 20));
        commandRegistry.execute('tab.move_to_other_pane');
        await new Promise((resolve) => setTimeout(resolve, 600));
      });

      await waitFor(() => {
        const calls = configSetSpy.mock.calls.filter(([path]) => path === 'layout.panes');
        expect(calls.length).toBe(1);
        const value = calls[0][1] as any;
        // The only tab moved out of pane 1, collapsing it: one pane holding rails.md.
        expect(value.panes).toHaveLength(1);
        expect(value.panes[0].tabs.map((t: any) => t.path)).toEqual(['projects/payments/rails.md']);
        const recents = configSetSpy.mock.calls.filter(([path]) => path === 'layout.recentNotes');
        expect(recents.length).toBe(1);
        expect((recents[0][1] as string[])[0]).toBe('projects/payments/rails.md');
      });
    },
    10000
  );
});
