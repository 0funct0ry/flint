import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { SettingsPanel } from '../components/SettingsPanel';
import * as SettingsContextModule from '../context/SettingsContext';
import { api } from '../services/ipc';
import { ConfigOrigin, FlintConfig } from '../types';

const baseConfig: FlintConfig = {
  version: 1,
  theme: 'system',
  editor: { fontSize: 14, fontFamily: 'IBM Plex Mono', softWrap: true, tabSize: 2, showLineNumbers: false, vimMode: false },
  markdown: { math: true, tables: true, footnotes: true, smartPunctuation: true },
  behaviour: { autosaveMs: 400, rewriteLinksOnRename: true, deleteToTrash: true, newNoteFolder: '', defaultMode: 'edit' },
  ui: { leftSidebar: 'tree', rightSidebarVisible: true, showNonNoteFiles: false },
  mcp: { enabled: false, port: null, requireAuth: false },
  ignore: ['node_modules/**'],
};

function mockUseSettings(overrides?: Partial<{
  config: FlintConfig;
  origins: Record<string, ConfigOrigin>;
  setField: ReturnType<typeof vi.fn>;
  resetField: ReturnType<typeof vi.fn>;
}>) {
  const setField = overrides?.setField || vi.fn();
  const resetField = overrides?.resetField || vi.fn();
  vi.spyOn(SettingsContextModule, 'useSettings').mockReturnValue({
    config: overrides?.config || baseConfig,
    origins: overrides?.origins || {},
    notice: null,
    loaded: true,
    setField,
    resetField,
    dismissNotice: vi.fn(),
    refresh: vi.fn(),
  });
  return { setField, resetField };
}

describe('SettingsPanel', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('renders all sections', () => {
    mockUseSettings();
    render(<SettingsPanel onClose={vi.fn()} />);

    expect(screen.getByText('General')).toBeInTheDocument();
    expect(screen.getByText('Editor')).toBeInTheDocument();
    expect(screen.getByText('Markdown')).toBeInTheDocument();
    expect(screen.getByText('Behaviour')).toBeInTheDocument();
    expect(screen.getByText('UI')).toBeInTheDocument();
    expect(screen.getByText('Ignore')).toBeInTheDocument();
  });

  it('calls setField with the correct dotted path and value when a field changes', () => {
    const { setField } = mockUseSettings();
    render(<SettingsPanel onClose={vi.fn()} />);

    const fontSizeInput = screen.getByLabelText('Editor font size') as HTMLInputElement;
    fireEvent.change(fontSizeInput, { target: { value: '18' } });

    expect(setField).toHaveBeenCalledWith('editor.fontSize', 18);
  });

  it('calls resetField when reset is clicked on an overridden field, and disables reset otherwise', () => {
    const { resetField } = mockUseSettings({ origins: { 'editor.fontSize': 'workspace' } });
    render(<SettingsPanel onClose={vi.fn()} />);

    const resetButtons = screen.getAllByRole('button', { name: 'Reset to default' });
    // The first FieldRow is theme (default, disabled); editor.fontSize is the second row.
    const fontSizeResetButton = resetButtons[1];
    expect(fontSizeResetButton).not.toBeDisabled();
    fireEvent.click(fontSizeResetButton);
    expect(resetField).toHaveBeenCalledWith('editor.fontSize');

    const themeResetButton = resetButtons[0];
    expect(themeResetButton).toBeDisabled();
  });

  it('renders a validation error under the correct ignore line', async () => {
    mockUseSettings();
    vi.spyOn(api, 'configValidateIgnore').mockResolvedValue([null, 'Unbalanced [ ] in glob pattern']);
    vi.useFakeTimers();

    render(<SettingsPanel onClose={vi.fn()} />);

    const textarea = screen.getByLabelText('Ignore glob patterns, one per line') as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: 'node_modules/**\n[bad' } });

    await act(async () => {
      vi.advanceTimersByTime(300);
      // let the resolved promise's .then() flush
      await Promise.resolve();
      await Promise.resolve();
    });

    vi.useRealTimers();

    expect(await screen.findByText(/Line 2: Unbalanced/)).toBeInTheDocument();
  });

  it('shows MCP server status with no token/rotate controls when auth is off (M10.21)', async () => {
    mockUseSettings();
    vi.spyOn(api, 'mcpStatus').mockResolvedValue({
      state: 'listening',
      url: 'http://127.0.0.1:4870/mcp',
      requiresAuth: false,
      hasToken: false,
    });

    render(<SettingsPanel onClose={vi.fn()} />);

    expect(await screen.findByText(/listening on http:\/\/127\.0\.0\.1:4870\/mcp/)).toBeInTheDocument();
    expect(screen.queryByText('rotate token')).not.toBeInTheDocument();
    expect(screen.queryByText('generate token')).not.toBeInTheDocument();
  });

  it('shows "generate token" when auth is required and none exists yet (M10.21)', async () => {
    mockUseSettings();
    vi.spyOn(api, 'mcpStatus').mockResolvedValue({
      state: 'listening',
      url: 'http://127.0.0.1:4870/mcp',
      requiresAuth: true,
      hasToken: false,
    });
    const rotateSpy = vi.spyOn(api, 'mcpRotateToken').mockResolvedValue('new-token');

    render(<SettingsPanel onClose={vi.fn()} />);

    const generateButton = await screen.findByText('generate token');
    expect(screen.getByText(/rejected until a token is generated/)).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(generateButton);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(rotateSpy).toHaveBeenCalled();
  });

  it('shows the token with a rotate button once one exists (M10.21)', async () => {
    mockUseSettings();
    vi.spyOn(api, 'mcpStatus').mockResolvedValue({
      state: 'listening',
      url: 'http://127.0.0.1:4870/mcp',
      requiresAuth: true,
      hasToken: true,
    });
    vi.spyOn(api, 'mcpGetToken').mockResolvedValue('existing-token');
    const rotateSpy = vi.spyOn(api, 'mcpRotateToken').mockResolvedValue('rotated-token');

    render(<SettingsPanel onClose={vi.fn()} />);

    expect(await screen.findByText('existing-token')).toBeInTheDocument();
    const rotateButton = screen.getByText('rotate token');

    await act(async () => {
      fireEvent.click(rotateButton);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(rotateSpy).toHaveBeenCalled();
  });

  it('toggles mcp.enabled through setField', () => {
    const { setField } = mockUseSettings();
    vi.spyOn(api, 'mcpStatus').mockResolvedValue({
      state: 'off',
      requiresAuth: false,
      hasToken: false,
    });
    render(<SettingsPanel onClose={vi.fn()} />);

    fireEvent.click(screen.getByLabelText('MCP server enabled'));
    expect(setField).toHaveBeenCalledWith('mcp.enabled', true);
  });

  it('toggles mcp.requireAuth through setField', () => {
    const { setField } = mockUseSettings();
    vi.spyOn(api, 'mcpStatus').mockResolvedValue({
      state: 'off',
      requiresAuth: false,
      hasToken: false,
    });
    render(<SettingsPanel onClose={vi.fn()} />);

    fireEvent.click(screen.getByLabelText('Require bearer token for MCP server'));
    expect(setField).toHaveBeenCalledWith('mcp.requireAuth', true);
  });
});
