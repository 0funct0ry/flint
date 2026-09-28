import React from 'react';
import type { McpStatus } from '../types';

export interface StatusBarProps {
  workspaceName: string;
  noteCount: number;
  linkCount: number;
  unresolvedCount: number;
  wordCount: number;
  charCount: number;
  cursorLine?: number;
  cursorCol?: number;
  selectionLength?: number;
  lineEnding?: 'LF' | 'CRLF';
  indexingProgress?: { indexed: number; total: number } | null;
  isWatcherDegraded?: boolean;
  mcpStatus?: McpStatus;
  onClickUnresolved?: () => void;
  onRotateMcpToken?: () => void;
}

export const StatusBar: React.FC<StatusBarProps> = ({
  workspaceName,
  noteCount,
  linkCount,
  unresolvedCount,
  wordCount,
  charCount,
  cursorLine,
  cursorCol,
  selectionLength = 0,
  lineEnding = 'LF',
  indexingProgress = null,
  isWatcherDegraded = false,
  mcpStatus = { state: 'off', requiresAuth: false, hasToken: false },
  onClickUnresolved,
  onRotateMcpToken,
}) => {
  return (
    <footer className="flex items-center gap-3.5 h-6 shrink-0 px-3 border-t border-[var(--border)] bg-[var(--panel-2)] text-[11.5px] text-[var(--muted)] font-mono select-none">
      <span className="text-[var(--text-2)] font-medium">{workspaceName}</span>
      <span>{noteCount.toLocaleString()} notes</span>
      <span>{linkCount.toLocaleString()} links</span>
      <span>{wordCount.toLocaleString()} words</span>
      <span>{charCount.toLocaleString()} chars</span>
      {unresolvedCount > 0 ? (
        <button
          onClick={onClickUnresolved}
          className="text-[var(--spark)] hover:underline cursor-pointer bg-transparent border-0 p-0 font-mono text-[11.5px]"
          title="Click to view all unresolved links"
        >
          {unresolvedCount} unresolved
        </button>
      ) : (
        <span>0 unresolved</span>
      )}

      {indexingProgress && (
        <div className="flex items-center gap-1.5 text-[var(--accent)] text-[11px]">
          <span className="animate-spin inline-block">◐</span>
          <span>
            Indexing {indexingProgress.indexed} / {indexingProgress.total}
          </span>
        </div>
      )}

      <div className="ml-auto flex items-center gap-3.5">
        {cursorLine !== undefined && cursorCol !== undefined && (
          <span>
            Ln {cursorLine}, Col {cursorCol}
            {selectionLength > 0 ? ` (${selectionLength} selected)` : ''}
          </span>
        )}
        <span>Markdown</span>
        <span>UTF-8</span>
        <span>{lineEnding}</span>
        {mcpStatus.state === 'listening' && mcpStatus.requiresAuth && (
          <button
            onClick={onRotateMcpToken}
            className="text-[var(--accent)] hover:underline cursor-pointer bg-transparent border-0 p-0 font-mono text-[11.5px]"
            title={`MCP server listening on ${mcpStatus.url}. Click to ${
              mcpStatus.hasToken ? 'rotate its token' : 'generate a token'
            }.`}
          >
            mcp: listening
          </button>
        )}
        {mcpStatus.state === 'listening' && !mcpStatus.requiresAuth && (
          <span
            className="text-[var(--muted)]"
            title={`MCP server listening on ${mcpStatus.url}. No authentication — any local process or user can connect.`}
          >
            mcp: listening
          </span>
        )}
        {mcpStatus.state === 'starting' && (
          <span className="text-[var(--muted)]" title="Local MCP server is starting">
            mcp: starting
          </span>
        )}
        {mcpStatus.state === 'error' && (
          <span className="text-[var(--spark)]" title={`MCP server error: ${mcpStatus.message}`}>
            mcp: error
          </span>
        )}
        {isWatcherDegraded ? (
          <span
            className="text-[var(--spark)] flex items-center gap-1"
            title="Native filesystem watcher unavailable. Falling back to 5s polling."
          >
            ⚠️ polling (degraded)
          </span>
        ) : (
          <span className="text-[var(--faint)]" title="Watching the filesystem">
            watching
          </span>
        )}
      </div>
    </footer>
  );
};

