import React, { useEffect, useRef, useState } from 'react';
import { useSettings } from '../context/SettingsContext';
import { api } from '../services/ipc';
import { McpStatus } from '../types';

export interface SettingsPanelProps {
  onClose: () => void;
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

export const SettingsPanel: React.FC<SettingsPanelProps> = ({ onClose }) => {
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

  useEffect(() => {
    api.mcpStatus().then(setMcpStatus);
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

      <div className="flex-1 overflow-auto min-h-0">
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
      </div>
    </div>
  );
};
