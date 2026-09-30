import React, { useEffect, useRef, useState } from 'react';
import { useSettings } from '../context/SettingsContext';
import { api } from '../services/ipc';
import { McpStatus, TemplateMeta } from '../types';
import { KeyValueRows } from './KeyValueRows';

export interface SettingsPanelProps {
  onClose: () => void;
  /** Opens the full-screen Templates management view (create/edit/list/delete) — M10.27
   * follow-up: authoring/editing templates moved out of Settings and the New Note modal into its
   * own screen. */
  onOpenTemplates: () => void;
}

/** A small pill showing whether a field is at its default or overridden at workspace scope. */
const OriginBadge: React.FC<{ isOverride: boolean }> = ({ isOverride }) => (
  <span
    className={`text-[10px] px-1.5 py-[1px] rounded-[3px] font-medium tracking-wide ${
      isOverride
        ? 'text-[var(--accent)] bg-[var(--accent-soft)]'
        : 'text-[var(--faint)] bg-[var(--panel-2)]'
    }`}
  >
    {isOverride ? 'workspace' : 'default'}
  </span>
);

const ResetButton: React.FC<{ disabled: boolean; onClick: () => void }> = ({ disabled, onClick }) => (
  <button
    onClick={onClick}
    disabled={disabled}
    className="text-[11px] px-1.5 py-[2px] rounded-[4px] text-[var(--muted)] hover:bg-[var(--panel-2)] hover:text-[var(--text)] transition-colors disabled:opacity-30 disabled:cursor-not-allowed disabled:hover:bg-transparent"
    title="Reset to default"
    aria-label="Reset to default"
  >
    reset
  </button>
);

interface FieldRowProps {
  label: string;
  path: string;
  origins: Record<string, string>;
  onReset: (path: string) => void;
  children: React.ReactNode;
  hint?: string;
}

const FieldRow: React.FC<FieldRowProps> = ({ label, path, origins, onReset, children, hint }) => {
  const isOverride = origins[path] === 'workspace';
  return (
    <div className="flex items-center gap-2 px-3 py-2 border-b border-[var(--border)] last:border-b-0">
      <div className="flex-1 min-w-0">
        <div className="text-[12.5px] text-[var(--text)]">{label}</div>
        {hint && <div className="text-[11px] text-[var(--faint)]">{hint}</div>}
      </div>
      <div className="flex items-center gap-2 shrink-0">
        {children}
        <OriginBadge isOverride={isOverride} />
        <ResetButton disabled={!isOverride} onClick={() => onReset(path)} />
      </div>
    </div>
  );
};

const SectionHeader: React.FC<{ title: string }> = ({ title }) => (
  <div className="px-3 pt-3 pb-1.5 text-[11px] font-medium text-[var(--faint)] uppercase tracking-wide">
    {title}
  </div>
);

const selectClass =
  'text-[12.5px] bg-[var(--panel)] border border-[var(--border)] rounded-[4px] px-1.5 py-[3px] text-[var(--text)] focus-visible:outline-none';
const inputClass =
  'text-[12.5px] bg-[var(--panel)] border border-[var(--border)] rounded-[4px] px-1.5 py-[3px] text-[var(--text)] w-20 focus-visible:outline-none';
const checkboxClass = 'w-3.5 h-3.5 accent-[var(--accent)]';

const TABS = [
  { id: 'general', label: 'General' },
  { id: 'editor', label: 'Editor' },
  { id: 'markdown', label: 'Markdown' },
  { id: 'behaviour', label: 'Behaviour' },
  { id: 'notes', label: 'Notes & templates' },
  { id: 'mcp', label: 'MCP server' },
  { id: 'ignore', label: 'Ignore' },
] as const;
type TabId = (typeof TABS)[number]['id'];

export const SettingsPanel: React.FC<SettingsPanelProps> = ({ onClose, onOpenTemplates }) => {
  const [tab, setTab] = useState<TabId>('general');
  const { config, origins, notice, setField, resetField, dismissNotice } = useSettings();
  const [ignoreText, setIgnoreText] = useState(config.ignore.join('\n'));
  const [ignoreErrors, setIgnoreErrors] = useState<Record<number, string>>({});
  const validateTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [mcpStatus, setMcpStatus] = useState<McpStatus>({
    state: 'off',
    requiresAuth: false,
    hasToken: false,
  });
  const [mcpToken, setMcpToken] = useState<string | null>(null);
  const [mcpRotating, setMcpRotating] = useState(false);
  const [mcpTokenCopied, setMcpTokenCopied] = useState(false);
  const [templates, setTemplates] = useState<TemplateMeta[]>([]);

  useEffect(() => {
    api.mcpStatus().then(setMcpStatus);
  }, []);

  useEffect(() => {
    api.templatesList().then(setTemplates);
  }, []);

  useEffect(() => {
    if (mcpStatus.requiresAuth && mcpStatus.hasToken) {
      api.mcpGetToken().then(setMcpToken);
    } else {
      setMcpToken(null);
    }
  }, [mcpStatus.requiresAuth, mcpStatus.hasToken]);

  const handleGenerateOrRotateToken = () => {
    setMcpRotating(true);
    api
      .mcpRotateToken()
      .then((token) => {
        setMcpToken(token);
        return api.mcpStatus();
      })
      .then(setMcpStatus)
      .finally(() => setMcpRotating(false));
  };

  const handleCopyToken = () => {
    if (!mcpToken) return;
    navigator.clipboard?.writeText(mcpToken).then(() => {
      setMcpTokenCopied(true);
      setTimeout(() => setMcpTokenCopied(false), 1500);
    });
  };

  // Reflect external config changes (e.g. reset, or a fresh load) into the textarea.
  useEffect(() => {
    setIgnoreText(config.ignore.join('\n'));
  }, [config.ignore]);

  useEffect(() => {
    return () => {
      if (validateTimerRef.current) clearTimeout(validateTimerRef.current);
    };
  }, []);

  const handleIgnoreChange = (value: string) => {
    setIgnoreText(value);
    if (validateTimerRef.current) clearTimeout(validateTimerRef.current);
    validateTimerRef.current = setTimeout(() => {
      const lines = value.split('\n');
      api.configValidateIgnore(lines).then((results) => {
        const errors: Record<number, string> = {};
        results.forEach((err, idx) => {
          if (err) errors[idx] = err;
        });
        setIgnoreErrors(errors);
      });
    }, 300);
  };

  const persistIgnore = () => {
    const patterns = ignoreText.split('\n').map((l) => l.trim()).filter((l) => l.length > 0);
    setField('ignore', patterns);
  };

  return (
    <div className="flex-1 flex flex-col bg-[var(--panel)] min-h-0 select-none" role="region" aria-label="Settings">
      <div className="flex items-center h-[31px] shrink-0 px-3 border-b border-[var(--border)]">
        <span className="text-[11.5px] tracking-wide font-medium text-[var(--text)]">Settings</span>
        <button
          onClick={onClose}
          className="ml-auto w-5 h-5 flex items-center justify-center rounded text-[var(--muted)] hover:bg-[var(--panel-2)] hover:text-[var(--text)] transition-colors text-xs font-semibold"
          title="Close settings"
          aria-label="Close settings"
        >
          ✕
        </button>
      </div>

      {notice && (
        <div className="flex items-start gap-2 px-3 py-2 border-b border-[var(--border)] bg-[var(--accent-soft)] text-[12.5px] text-[var(--text)]">
          <span className="text-[var(--spark)] mt-[1px]">⚠</span>
          <span className="flex-1">{notice.message}</span>
          <button
            onClick={dismissNotice}
            className="text-[var(--muted)] hover:text-[var(--text)] text-xs shrink-0"
            aria-label="Dismiss notice"
          >
            ✕
          </button>
        </div>
      )}

      <div className="shrink-0 border-b border-[var(--border)]">
      <div
        role="tablist"
        aria-label="Settings sections"
        className="flex items-center gap-0.5 w-full max-w-[720px] mx-auto px-6 pt-4 overflow-x-auto overflow-y-hidden"
        onKeyDown={(e) => {
          if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
          const idx = TABS.findIndex((t) => t.id === tab);
          const next = TABS[(idx + (e.key === 'ArrowRight' ? 1 : TABS.length - 1)) % TABS.length];
          setTab(next.id);
          e.preventDefault();
          document.getElementById(`settings-tab-${next.id}`)?.focus();
        }}
      >
        {TABS.map((t) => (
          <button
            key={t.id}
            id={`settings-tab-${t.id}`}
            role="tab"
            aria-selected={tab === t.id}
            tabIndex={tab === t.id ? 0 : -1}
            onClick={() => setTab(t.id)}
            className={`text-[12px] px-2.5 py-1.5 -mb-px border-b-2 whitespace-nowrap transition-colors ${
              tab === t.id
                ? 'border-[var(--accent)] text-[var(--text)]'
                : 'border-transparent text-[var(--muted)] hover:text-[var(--text)]'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>
      </div>

      <div className="flex-1 overflow-auto min-h-0" role="tabpanel" aria-labelledby={`settings-tab-${tab}`}>
      <div className="w-full max-w-[720px] mx-auto px-6 py-4">
        {tab === 'general' && (
        <>
        <SectionHeader title="General" />
        <FieldRow label="Theme" path="theme" origins={origins} onReset={resetField}>
          <select
            className={selectClass}
            value={config.theme}
            onChange={(e) => setField('theme', e.target.value)}
            aria-label="Theme"
          >
            <option value="light">light</option>
            <option value="dark">dark</option>
            <option value="system">system</option>
          </select>
        </FieldRow>

        </>
        )}
        {tab === 'editor' && (
        <>
        <SectionHeader title="Editor" />
        <FieldRow label="Font size" path="editor.fontSize" origins={origins} onReset={resetField}>
          <input
            type="number"
            className={inputClass}
            value={config.editor.fontSize}
            onChange={(e) => setField('editor.fontSize', Number(e.target.value))}
            aria-label="Editor font size"
          />
        </FieldRow>
        <FieldRow label="Font family" path="editor.fontFamily" origins={origins} onReset={resetField}>
          <input
            type="text"
            className={`${inputClass} w-36`}
            value={config.editor.fontFamily}
            onChange={(e) => setField('editor.fontFamily', e.target.value)}
            aria-label="Editor font family"
          />
        </FieldRow>
        <FieldRow label="Soft wrap" path="editor.softWrap" origins={origins} onReset={resetField}>
          <input
            type="checkbox"
            className={checkboxClass}
            checked={config.editor.softWrap}
            onChange={(e) => setField('editor.softWrap', e.target.checked)}
            aria-label="Soft wrap"
          />
        </FieldRow>
        <FieldRow label="Tab size" path="editor.tabSize" origins={origins} onReset={resetField}>
          <input
            type="number"
            className={inputClass}
            value={config.editor.tabSize}
            onChange={(e) => setField('editor.tabSize', Number(e.target.value))}
            aria-label="Tab size"
          />
        </FieldRow>
        <FieldRow label="Show line numbers" path="editor.showLineNumbers" origins={origins} onReset={resetField}>
          <input
            type="checkbox"
            className={checkboxClass}
            checked={config.editor.showLineNumbers}
            onChange={(e) => setField('editor.showLineNumbers', e.target.checked)}
            aria-label="Show line numbers"
          />
        </FieldRow>
        <FieldRow
          label="Vim mode"
          path="editor.vimMode"
          origins={origins}
          onReset={resetField}
          hint="Stored only — no vim keybinding package is installed yet"
        >
          <input
            type="checkbox"
            className={checkboxClass}
            checked={config.editor.vimMode}
            onChange={(e) => setField('editor.vimMode', e.target.checked)}
            aria-label="Vim mode"
          />
        </FieldRow>

        </>
        )}
        {tab === 'markdown' && (
        <>
        <SectionHeader title="Markdown" />
        <FieldRow label="Math" path="markdown.math" origins={origins} onReset={resetField}>
          <input
            type="checkbox"
            className={checkboxClass}
            checked={config.markdown.math}
            onChange={(e) => setField('markdown.math', e.target.checked)}
            aria-label="Math"
          />
        </FieldRow>
        <FieldRow label="Tables" path="markdown.tables" origins={origins} onReset={resetField}>
          <input
            type="checkbox"
            className={checkboxClass}
            checked={config.markdown.tables}
            onChange={(e) => setField('markdown.tables', e.target.checked)}
            aria-label="Tables"
          />
        </FieldRow>
        <FieldRow label="Footnotes" path="markdown.footnotes" origins={origins} onReset={resetField}>
          <input
            type="checkbox"
            className={checkboxClass}
            checked={config.markdown.footnotes}
            onChange={(e) => setField('markdown.footnotes', e.target.checked)}
            aria-label="Footnotes"
          />
        </FieldRow>
        <FieldRow label="Smart punctuation" path="markdown.smartPunctuation" origins={origins} onReset={resetField}>
          <input
            type="checkbox"
            className={checkboxClass}
            checked={config.markdown.smartPunctuation}
            onChange={(e) => setField('markdown.smartPunctuation', e.target.checked)}
            aria-label="Smart punctuation"
          />
        </FieldRow>
        <FieldRow label="Wikilinks" path="markdown.wikilinks" origins={origins} onReset={resetField}>
          <input
            type="checkbox"
            className={checkboxClass}
            checked={config.markdown.wikilinks}
            onChange={(e) => {
              const enabled = e.target.checked;
              setField('markdown.wikilinks', enabled);
              // Wikilink insertion cannot be enabled while wikilink parsing is off — that
              // combination would insert dead text (M10.23).
              if (!enabled && config.markdown.newLinkSyntax !== 'markdown') {
                setField('markdown.newLinkSyntax', 'markdown');
              }
            }}
            aria-label="Wikilinks"
          />
        </FieldRow>
        <FieldRow
          label="New link syntax"
          path="markdown.newLinkSyntax"
          origins={origins}
          onReset={resetField}
        >
          <select
            className={selectClass}
            value={config.markdown.newLinkSyntax}
            disabled={!config.markdown.wikilinks}
            onChange={(e) => setField('markdown.newLinkSyntax', e.target.value)}
            aria-label="New link syntax"
          >
            <option value="markdown">markdown</option>
            <option value="wikilink">wikilink</option>
          </select>
        </FieldRow>

        </>
        )}
        {tab === 'behaviour' && (
        <>
        <SectionHeader title="Behaviour" />
        <FieldRow label="Autosave (ms)" path="behaviour.autosaveMs" origins={origins} onReset={resetField}>
          <input
            type="number"
            className={inputClass}
            value={config.behaviour.autosaveMs}
            onChange={(e) => setField('behaviour.autosaveMs', Number(e.target.value))}
            aria-label="Autosave delay in milliseconds"
          />
        </FieldRow>
        <FieldRow label="Rewrite links on rename" path="behaviour.rewriteLinksOnRename" origins={origins} onReset={resetField}>
          <input
            type="checkbox"
            className={checkboxClass}
            checked={config.behaviour.rewriteLinksOnRename}
            onChange={(e) => setField('behaviour.rewriteLinksOnRename', e.target.checked)}
            aria-label="Rewrite links on rename"
          />
        </FieldRow>
        <FieldRow label="Delete to trash" path="behaviour.deleteToTrash" origins={origins} onReset={resetField}>
          <input
            type="checkbox"
            className={checkboxClass}
            checked={config.behaviour.deleteToTrash}
            onChange={(e) => setField('behaviour.deleteToTrash', e.target.checked)}
            aria-label="Delete to trash"
          />
        </FieldRow>
        <FieldRow label="New note folder" path="behaviour.newNoteFolder" origins={origins} onReset={resetField}>
          <input
            type="text"
            className={`${inputClass} w-36`}
            value={config.behaviour.newNoteFolder}
            onChange={(e) => setField('behaviour.newNoteFolder', e.target.value)}
            aria-label="New note folder"
          />
        </FieldRow>
        <FieldRow label="Default mode" path="behaviour.defaultMode" origins={origins} onReset={resetField}>
          <select
            className={selectClass}
            value={config.behaviour.defaultMode}
            onChange={(e) => setField('behaviour.defaultMode', e.target.value)}
            aria-label="Default mode"
          >
            <option value="edit">edit</option>
            <option value="read">read</option>
            <option value="split">split</option>
          </select>
        </FieldRow>

        </>
        )}
        {tab === 'general' && (
        <>
        <SectionHeader title="UI" />
        <FieldRow label="Left sidebar" path="ui.leftSidebar" origins={origins} onReset={resetField}>
          <select
            className={selectClass}
            value={config.ui.leftSidebar}
            onChange={(e) => setField('ui.leftSidebar', e.target.value)}
            aria-label="Left sidebar default tab"
          >
            <option value="tree">tree</option>
            <option value="search">search</option>
            <option value="outline">outline</option>
          </select>
        </FieldRow>
        <FieldRow label="Right sidebar visible" path="ui.rightSidebarVisible" origins={origins} onReset={resetField}>
          <input
            type="checkbox"
            className={checkboxClass}
            checked={config.ui.rightSidebarVisible}
            onChange={(e) => setField('ui.rightSidebarVisible', e.target.checked)}
            aria-label="Right sidebar visible"
          />
        </FieldRow>
        <FieldRow label="Show non-note files" path="ui.showNonNoteFiles" origins={origins} onReset={resetField}>
          <input
            type="checkbox"
            className={checkboxClass}
            checked={config.ui.showNonNoteFiles}
            onChange={(e) => setField('ui.showNonNoteFiles', e.target.checked)}
            aria-label="Show non-note files"
          />
        </FieldRow>

        </>
        )}
        {tab === 'mcp' && (
        <>
        <SectionHeader title="MCP Server" />
        <FieldRow
          label="Enabled"
          path="mcp.enabled"
          origins={origins}
          onReset={resetField}
          hint="Takes effect on next launch. Loopback-only, bearer-token gated — see Docs > MCP Server."
        >
          <input
            type="checkbox"
            className={checkboxClass}
            checked={config.mcp.enabled}
            onChange={(e) => setField('mcp.enabled', e.target.checked)}
            aria-label="MCP server enabled"
          />
        </FieldRow>
        <FieldRow
          label="Port"
          path="mcp.port"
          origins={origins}
          onReset={resetField}
          hint="Falls back to an ephemeral port if taken. Blank uses the default (4870)."
        >
          <input
            type="number"
            className={inputClass}
            value={config.mcp.port ?? ''}
            onChange={(e) => setField('mcp.port', e.target.value === '' ? null : Number(e.target.value))}
            aria-label="MCP server port"
          />
        </FieldRow>
        <FieldRow
          label="Require bearer token"
          path="mcp.requireAuth"
          origins={origins}
          onReset={resetField}
          hint="Off by default: any local process/user can connect. Takes effect on next launch."
        >
          <input
            type="checkbox"
            className={checkboxClass}
            checked={config.mcp.requireAuth}
            onChange={(e) => setField('mcp.requireAuth', e.target.checked)}
            aria-label="Require bearer token for MCP server"
          />
        </FieldRow>
        <div className="flex items-center gap-2 px-3 py-2 border-b border-[var(--border)] text-[12.5px] text-[var(--text)]">
          <span className="flex-1 min-w-0">
            Status:{' '}
            {mcpStatus.state === 'listening' && (
              <span className="text-[var(--accent)] break-all">listening on {mcpStatus.url}</span>
            )}
            {mcpStatus.state === 'starting' && <span className="text-[var(--muted)]">starting</span>}
            {mcpStatus.state === 'error' && (
              <span className="text-[var(--spark)]">error: {mcpStatus.message}</span>
            )}
            {mcpStatus.state === 'off' && <span className="text-[var(--faint)]">off</span>}
          </span>
          {mcpStatus.state === 'listening' && mcpStatus.requiresAuth && (
            <button
              onClick={handleGenerateOrRotateToken}
              disabled={mcpRotating}
              className="text-[11px] px-1.5 py-[2px] rounded-[4px] text-[var(--muted)] hover:bg-[var(--panel-2)] hover:text-[var(--text)] transition-colors disabled:opacity-30"
            >
              {mcpRotating ? 'working…' : mcpStatus.hasToken ? 'rotate token' : 'generate token'}
            </button>
          )}
        </div>
        {mcpStatus.state === 'listening' && mcpStatus.requiresAuth && mcpToken && (
          <div className="flex items-center gap-2 px-3 py-2 border-b border-[var(--border)] text-[12px]">
            <code className="flex-1 min-w-0 truncate font-mono text-[var(--text)] bg-[var(--panel-2)] rounded-[4px] px-1.5 py-[3px]">
              {mcpToken}
            </code>
            <button
              onClick={handleCopyToken}
              className="text-[11px] px-1.5 py-[2px] rounded-[4px] text-[var(--muted)] hover:bg-[var(--panel-2)] hover:text-[var(--text)] transition-colors"
            >
              {mcpTokenCopied ? 'copied' : 'copy'}
            </button>
          </div>
        )}
        {mcpStatus.state === 'listening' && mcpStatus.requiresAuth && !mcpStatus.hasToken && (
          <div className="px-3 pb-2 text-[11px] text-[var(--faint)]">
            Every MCP request is rejected until a token is generated.
          </div>
        )}

        </>
        )}
        {tab === 'notes' && (
        <>
        <SectionHeader title="Templates" />
        <div className="flex items-center justify-between px-3 pb-2">
          <span className="text-[11.5px] text-[var(--muted)]">
            Create, edit, and delete templates from their own screen.
          </span>
          <button
            onClick={onOpenTemplates}
            className="text-[11.5px] px-2.5 py-[4px] rounded-[5px] border border-[var(--border)] text-[var(--text)] hover:bg-[var(--panel-2)] transition-colors shrink-0"
          >
            Manage templates…
          </button>
        </div>
        <FieldRow
          label="Default template"
          path="templates.defaultTemplate"
          origins={origins}
          onReset={resetField}
          hint={
            templates.length === 0
              ? 'No templates yet — create one from Manage templates above.'
              : 'Pre-selected option in the new-note template picker.'
          }
        >
          <select
            className={selectClass}
            value={config.templates.defaultTemplate ?? ''}
            onChange={(e) => setField('templates.defaultTemplate', e.target.value || null)}
            aria-label="Default template"
            disabled={templates.length === 0}
          >
            <option value="">Blank</option>
            {templates.map((t) => (
              <option key={t.path} value={t.path}>
                {t.name}
              </option>
            ))}
          </select>
        </FieldRow>

        <div className="px-3 pb-3 flex flex-col gap-1.5">
          <span className="text-[11.5px] text-[var(--muted)]">
            Variables — defaults available to any template, anywhere in the workspace, unless
            overridden by a folder scope or a value typed into the New Note modal.
          </span>
          <KeyValueRows
            entries={Object.entries(config.templates.globalVariables ?? {})}
            onChange={(entries) => {
              const map: Record<string, string> = {};
              for (const [k, v] of entries) {
                if (k.trim()) map[k.trim()] = v;
              }
              setField('templates.globalVariables', map);
            }}
          />
        </div>

        </>
        )}
        {tab === 'notes' && (
        <>
        <SectionHeader title="New notes" />
        <FieldRow
          label="Target folder"
          path="newNote.targetFolder"
          origins={origins}
          onReset={resetField}
          hint="Workspace-relative folder new notes land in. Blank uses the currently open folder."
        >
          <input
            type="text"
            className={inputClass}
            style={{ width: '9rem' }}
            value={config.newNote.targetFolder ?? ''}
            onChange={(e) => setField('newNote.targetFolder', e.target.value || null)}
            aria-label="New note target folder"
          />
        </FieldRow>
        <FieldRow
          label="Filename pattern"
          path="newNote.filenamePattern"
          origins={origins}
          onReset={resetField}
          hint={'Template syntax: {{ title }}, {{ date() }}, {{ date(fmt="DD-MM-YYYY") }}, {{ time() }}.'}
        >
          <input
            type="text"
            className={inputClass}
            style={{ width: '9rem' }}
            value={config.newNote.filenamePattern}
            onChange={(e) => setField('newNote.filenamePattern', e.target.value)}
            aria-label="New note filename pattern"
          />
        </FieldRow>
        <FieldRow
          label="Insert heading"
          path="newNote.insertHeading"
          origins={origins}
          onReset={resetField}
          hint="Insert a # <title> heading when a new note has no template and would otherwise be empty."
        >
          <input
            type="checkbox"
            className={checkboxClass}
            checked={config.newNote.insertHeading}
            onChange={(e) => setField('newNote.insertHeading', e.target.checked)}
            aria-label="Insert heading in new notes"
          />
        </FieldRow>

        </>
        )}
        {tab === 'notes' && (
        <>
        <SectionHeader title="Daily notes" />
        <FieldRow
          label="Enabled"
          path="dailyNotes.enabled"
          origins={origins}
          onReset={resetField}
          hint="Adds Today/Yesterday/Tomorrow/Pick a date… to the command palette. Never creates a note automatically."
        >
          <input
            type="checkbox"
            className={checkboxClass}
            checked={config.dailyNotes.enabled}
            onChange={(e) => setField('dailyNotes.enabled', e.target.checked)}
            aria-label="Daily notes enabled"
          />
        </FieldRow>
        <FieldRow
          label="Path pattern"
          path="dailyNotes.pathPattern"
          origins={origins}
          onReset={resetField}
          hint={'e.g. daily/{{ date(fmt="YYYY-MM-DD") }}.md'}
        >
          <input
            type="text"
            className={inputClass}
            style={{ width: '11rem' }}
            value={config.dailyNotes.pathPattern}
            onChange={(e) => setField('dailyNotes.pathPattern', e.target.value)}
            aria-label="Daily note path pattern"
          />
        </FieldRow>
        <FieldRow
          label="Template"
          path="dailyNotes.template"
          origins={origins}
          onReset={resetField}
          hint={templates.length === 0 ? 'No templates yet — create one from Manage templates above.' : undefined}
        >
          <select
            className={selectClass}
            value={config.dailyNotes.template ?? ''}
            onChange={(e) => setField('dailyNotes.template', e.target.value || null)}
            aria-label="Daily note template"
            disabled={templates.length === 0}
          >
            <option value="">Blank</option>
            {templates.map((t) => (
              <option key={t.path} value={t.path}>
                {t.name}
              </option>
            ))}
          </select>
        </FieldRow>

        </>
        )}
        {tab === 'ignore' && (
        <>
        <SectionHeader title="Ignore" />
        <div className="px-3 pb-3">
          <textarea
            className="w-full h-28 text-[12px] font-mono bg-[var(--panel)] border border-[var(--border)] rounded-[4px] px-2 py-1.5 text-[var(--text)] resize-y focus-visible:outline-none"
            value={ignoreText}
            onChange={(e) => handleIgnoreChange(e.target.value)}
            onBlur={persistIgnore}
            aria-label="Ignore glob patterns, one per line"
            spellCheck={false}
          />
          {Object.keys(ignoreErrors).length > 0 && (
            <div className="mt-1.5 flex flex-col gap-0.5">
              {Object.entries(ignoreErrors).map(([lineIdx, message]) => (
                <div key={lineIdx} className="text-[11px] text-[var(--spark)]">
                  Line {Number(lineIdx) + 1}: {message}
                </div>
              ))}
            </div>
          )}
        </div>
        </>
        )}
      </div>
      </div>
    </div>
  );
};
