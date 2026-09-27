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
});
