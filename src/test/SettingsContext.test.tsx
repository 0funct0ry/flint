import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { SettingsProvider, useSettings } from '../context/SettingsContext';
import { api } from '../services/ipc';

function FontSizeProbe() {
  const { config, origins, notice, setField, resetField, dismissNotice } = useSettings();
  return (
    <div>
      <span data-testid="font-size">{config.editor.fontSize}</span>
      <span data-testid="font-size-origin">{origins['editor.fontSize'] || 'default'}</span>
      <span data-testid="notice">{notice ? notice.message : ''}</span>
      <button onClick={() => setField('editor.fontSize', 18)}>bump</button>
      <button onClick={() => resetField('editor.fontSize')}>reset</button>
      <button onClick={() => dismissNotice()}>dismiss</button>
    </div>
  );
}

describe('SettingsContext', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('loads the initial config from configGetAll on mount', async () => {
    vi.spyOn(api, 'configGetAll').mockResolvedValue({
      config: {
        version: 1,
        theme: 'system',
        editor: { fontSize: 16, fontFamily: 'IBM Plex Mono', softWrap: true, tabSize: 2, showLineNumbers: false, vimMode: false },
        markdown: { math: true, tables: true, footnotes: true, smartPunctuation: true },
        behaviour: { autosaveMs: 400, rewriteLinksOnRename: true, deleteToTrash: true, newNoteFolder: '', defaultMode: 'edit' },
        ui: { leftSidebar: 'tree', rightSidebarVisible: true, showNonNoteFiles: false },
        ignore: [],
      } as any,
      origins: {},
      notice: null,
    });

    render(
      <SettingsProvider>
        <FontSizeProbe />
      </SettingsProvider>
    );

    expect(await screen.findByText('16')).toBeInTheDocument();
  });

  it('applies setField optimistically and synchronously, before the IPC promise resolves', async () => {
    vi.spyOn(api, 'configGetAll').mockResolvedValue({
      config: {
        version: 1,
        theme: 'system',
        editor: { fontSize: 14, fontFamily: 'IBM Plex Mono', softWrap: true, tabSize: 2, showLineNumbers: false, vimMode: false },
        markdown: { math: true, tables: true, footnotes: true, smartPunctuation: true },
        behaviour: { autosaveMs: 400, rewriteLinksOnRename: true, deleteToTrash: true, newNoteFolder: '', defaultMode: 'edit' },
        ui: { leftSidebar: 'tree', rightSidebarVisible: true, showNonNoteFiles: false },
        ignore: [],
      } as any,
      origins: {},
      notice: null,
    });
    // Never resolves: proves the UI does not wait on it.
    vi.spyOn(api, 'configSet').mockReturnValue(new Promise(() => {}));

    render(
      <SettingsProvider>
        <FontSizeProbe />
      </SettingsProvider>
    );

    await screen.findByText('14');

    act(() => {
      screen.getByText('bump').click();
    });

    expect(screen.getByTestId('font-size').textContent).toBe('18');
    expect(screen.getByTestId('font-size-origin').textContent).toBe('workspace');
  });

  it('resetField removes the workspace override', async () => {
    vi.spyOn(api, 'configGetAll').mockResolvedValue({
      config: {
        version: 1,
        theme: 'system',
        editor: { fontSize: 20, fontFamily: 'IBM Plex Mono', softWrap: true, tabSize: 2, showLineNumbers: false, vimMode: false },
        markdown: { math: true, tables: true, footnotes: true, smartPunctuation: true },
        behaviour: { autosaveMs: 400, rewriteLinksOnRename: true, deleteToTrash: true, newNoteFolder: '', defaultMode: 'edit' },
        ui: { leftSidebar: 'tree', rightSidebarVisible: true, showNonNoteFiles: false },
        ignore: [],
      } as any,
      origins: { 'editor.fontSize': 'workspace' },
      notice: null,
    });
    vi.spyOn(api, 'configReset').mockResolvedValue(undefined);

    render(
      <SettingsProvider>
        <FontSizeProbe />
      </SettingsProvider>
    );

    await screen.findByText('20');
    expect(screen.getByTestId('font-size-origin').textContent).toBe('workspace');

    await act(async () => {
      screen.getByText('reset').click();
      await Promise.resolve();
    });

    expect(screen.getByTestId('font-size-origin').textContent).toBe('default');
  });

  it('dismissNotice clears the notice', async () => {
    vi.spyOn(api, 'configGetAll').mockResolvedValue({
      config: {
        version: 1,
        theme: 'system',
        editor: { fontSize: 14, fontFamily: 'IBM Plex Mono', softWrap: true, tabSize: 2, showLineNumbers: false, vimMode: false },
        markdown: { math: true, tables: true, footnotes: true, smartPunctuation: true },
        behaviour: { autosaveMs: 400, rewriteLinksOnRename: true, deleteToTrash: true, newNoteFolder: '', defaultMode: 'edit' },
        ui: { leftSidebar: 'tree', rightSidebarVisible: true, showNonNoteFiles: false },
        ignore: [],
      } as any,
      origins: {},
      notice: { path: 'config.json', field: 'editor.fontSize', message: 'Failed to parse config; using defaults' },
    });

    render(
      <SettingsProvider>
        <FontSizeProbe />
      </SettingsProvider>
    );

    expect(await screen.findByText('Failed to parse config; using defaults')).toBeInTheDocument();

    act(() => {
      screen.getByText('dismiss').click();
    });

    expect(screen.getByTestId('notice').textContent).toBe('');
  });

  it('throws a descriptive error when useSettings is called outside a Provider', () => {
    const Bare = () => {
      useSettings();
      return null;
    };
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => render(<Bare />)).toThrow(/SettingsProvider/);
    spy.mockRestore();
  });
});
