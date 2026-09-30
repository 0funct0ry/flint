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
  markdown: { math: true, tables: true, footnotes: true, smartPunctuation: true, wikilinks: false, newLinkSyntax: 'markdown' },
  behaviour: { autosaveMs: 400, rewriteLinksOnRename: true, deleteToTrash: true, newNoteFolder: '', defaultMode: 'edit' },
  ui: { leftSidebar: 'tree', rightSidebarVisible: true, showNonNoteFiles: false },
  mcp: { enabled: false, port: null, requireAuth: false },
  templates: { defaultTemplate: null },
  newNote: { targetFolder: null, filenamePattern: '{{title}}', insertHeading: false },
  dailyNotes: { enabled: false, pathPattern: 'daily/{{date:YYYY-MM-DD}}.md', template: null },
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

function renderPanel(tabName?: string) {
  render(<SettingsPanel onClose={vi.fn()} onOpenTemplates={vi.fn()} />);
  if (tabName) fireEvent.click(screen.getByRole('tab', { name: tabName }));
}

describe('SettingsPanel', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('renders all sections', () => {
    mockUseSettings();
    render(<SettingsPanel onClose={vi.fn()} onOpenTemplates={vi.fn()} />);

    for (const name of ['General', 'Editor', 'Markdown', 'Behaviour', 'Notes & templates', 'MCP server', 'Ignore']) {
      expect(screen.getByRole('tab', { name })).toBeInTheDocument();
    }
  });

  it('calls setField with the correct dotted path and value when a field changes', () => {
    const { setField } = mockUseSettings();
    renderPanel('Editor');

    const fontSizeInput = screen.getByLabelText('Editor font size') as HTMLInputElement;
    fireEvent.change(fontSizeInput, { target: { value: '18' } });

    expect(setField).toHaveBeenCalledWith('editor.fontSize', 18);
  });

  it('calls resetField when reset is clicked on an overridden field, and disables reset otherwise', () => {
    const { resetField } = mockUseSettings({ origins: { 'editor.fontSize': 'workspace' } });
    renderPanel('Editor');

    const resetButtons = screen.getAllByRole('button', { name: 'Reset to default' });
    // editor.fontSize is the first FieldRow on the Editor tab; font family (default) is second.
    const fontSizeResetButton = resetButtons[0];
    expect(fontSizeResetButton).not.toBeDisabled();
    fireEvent.click(fontSizeResetButton);
    expect(resetField).toHaveBeenCalledWith('editor.fontSize');

    const themeResetButton = resetButtons[1];
    expect(themeResetButton).toBeDisabled();
  });

  it('renders a validation error under the correct ignore line', async () => {
    mockUseSettings();
    vi.spyOn(api, 'configValidateIgnore').mockResolvedValue([null, 'Unbalanced [ ] in glob pattern']);
    vi.useFakeTimers();

    renderPanel('Ignore');

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

    renderPanel('MCP server');

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

    renderPanel('MCP server');

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

    renderPanel('MCP server');

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
    renderPanel('MCP server');

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
    renderPanel('MCP server');

    fireEvent.click(screen.getByLabelText('Require bearer token for MCP server'));
    expect(setField).toHaveBeenCalledWith('mcp.requireAuth', true);
  });

  it('toggles markdown.wikilinks through setField', () => {
    const { setField } = mockUseSettings();
    renderPanel('Markdown');

    fireEvent.click(screen.getByLabelText('Wikilinks'));
    expect(setField).toHaveBeenCalledWith('markdown.wikilinks', true);
  });

  it('forces markdown.newLinkSyntax back to markdown when wikilinks is turned off', () => {
    const { setField } = mockUseSettings({
      config: {
        ...baseConfig,
        markdown: { ...baseConfig.markdown, wikilinks: true, newLinkSyntax: 'wikilink' },
      },
    });
    renderPanel('Markdown');

    fireEvent.click(screen.getByLabelText('Wikilinks'));
    expect(setField).toHaveBeenCalledWith('markdown.wikilinks', false);
    expect(setField).toHaveBeenCalledWith('markdown.newLinkSyntax', 'markdown');
  });

  it('disables the new link syntax selector while wikilinks is off', () => {
    mockUseSettings();
    renderPanel('Markdown');

    expect(screen.getByLabelText('New link syntax')).toBeDisabled();
  });

  describe('Templates / New notes / Daily notes (M10.26)', () => {
    it('renders all three new sections', () => {
      mockUseSettings();
      renderPanel('Notes & templates');

      expect(screen.getByText('Templates')).toBeInTheDocument();
      expect(screen.getByText('New notes')).toBeInTheDocument();
      expect(screen.getByText('Daily notes')).toBeInTheDocument();
    });

    it('shows the empty-templates hint and disables the pickers when there are no templates', async () => {
      mockUseSettings();
      vi.spyOn(api, 'templatesList').mockResolvedValue([]);
      renderPanel('Notes & templates');

      expect(
        await screen.findAllByText('No templates yet — create one from Manage templates above.')
      ).toHaveLength(2);
      expect(screen.getByLabelText('Default template')).toBeDisabled();
      expect(screen.getByLabelText('Daily note template')).toBeDisabled();
    });

    it('lists discovered templates in both pickers', async () => {
      mockUseSettings();
      vi.spyOn(api, 'templatesList').mockResolvedValue([
        { name: 'daily', path: 'daily.md' },
        { name: 'meeting', path: 'meeting.md' },
      ]);
      renderPanel('Notes & templates');

      expect(await screen.findByLabelText('Default template')).not.toBeDisabled();
      expect(screen.getAllByRole('option', { name: 'meeting' })).toHaveLength(2);
    });

    it('sets newNote.filenamePattern and newNote.insertHeading through setField', () => {
      const { setField } = mockUseSettings();
      renderPanel('Notes & templates');

      fireEvent.change(screen.getByLabelText('New note filename pattern'), {
        target: { value: '{{date}}-{{title}}' },
      });
      expect(setField).toHaveBeenCalledWith('newNote.filenamePattern', '{{date}}-{{title}}');

      fireEvent.click(screen.getByLabelText('Insert heading in new notes'));
      expect(setField).toHaveBeenCalledWith('newNote.insertHeading', true);
    });

    it('toggles dailyNotes.enabled and edits the path pattern through setField', () => {
      const { setField } = mockUseSettings();
      renderPanel('Notes & templates');

      fireEvent.click(screen.getByLabelText('Daily notes enabled'));
      expect(setField).toHaveBeenCalledWith('dailyNotes.enabled', true);

      fireEvent.change(screen.getByLabelText('Daily note path pattern'), {
        target: { value: 'journal/{{date:YYYY/MM/DD}}.md' },
      });
      expect(setField).toHaveBeenCalledWith('dailyNotes.pathPattern', 'journal/{{date:YYYY/MM/DD}}.md');
    });
  });
});
