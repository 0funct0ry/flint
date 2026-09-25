import React from 'react';

export type ViewMode = 'edit' | 'read' | 'split';

export interface TitleBarProps {
  breadcrumb: string;
  viewMode: ViewMode;
  onViewModeChange: (mode: ViewMode) => void;
  onOpenPalette: () => void;
  onToggleTheme: () => void;
  theme: 'light' | 'dark';
  leftSidebarVisible?: boolean;
  onToggleLeftSidebar?: () => void;
  rightSidebarVisible?: boolean;
  onToggleRightSidebar?: () => void;
}

export const TitleBar: React.FC<TitleBarProps> = ({
  breadcrumb,
  viewMode,
  onViewModeChange,
  onOpenPalette,
  onToggleTheme,
  theme,
  leftSidebarVisible = true,
  onToggleLeftSidebar,
  rightSidebarVisible = true,
  onToggleRightSidebar,
}) => {
  const parts = breadcrumb.split('/');
  const root = parts[0] || 'projects';
  const rest = parts.slice(1);

  return (
    <div className="flex items-center gap-3 h-[38px] shrink-0 px-3 border-b border-[var(--border)] bg-[var(--panel-2)] select-none">
      {/* Workspace Breadcrumb */}
      <div className="flex items-center gap-1.5 text-[var(--muted)] text-xs truncate">
        <span>{root}</span>
        {rest.map((segment, idx) => (
          <React.Fragment key={idx}>
            <span className="text-[var(--faint)]">›</span>
            <b
              className={
                idx === rest.length - 1
                  ? 'text-[var(--text)] font-semibold'
                  : 'text-[var(--text-2)] font-medium'
              }
            >
              {segment}
            </b>
          </React.Fragment>
        ))}
      </div>

      {/* Right controls */}
      <div className="ml-auto flex items-center gap-1.5">
        {/* Palette Hint Button */}
        <button
          onClick={onOpenPalette}
          className="flex items-center gap-2 px-2.5 py-[3px] min-w-[190px] border border-[var(--border)] rounded-[5px] text-[var(--faint)] text-xs bg-[var(--panel)] hover:border-[var(--muted)] transition-colors"
          title="Open Command Palette (⌘P)"
        >
          <span className="text-[11px]">⌕</span>
          <span>Search notes</span>
          <kbd className="ml-auto font-mono text-[10.5px] text-[var(--muted)] border border-[var(--border)] rounded px-1 py-[0.5px] bg-[var(--panel-2)]">
            ⌘P
          </kbd>
        </button>

        {/* Mode Segment */}
        <div className="flex border border-[var(--border)] rounded-[5px] overflow-hidden" role="group" aria-label="View mode">
          {(['edit', 'read', 'split'] as ViewMode[]).map((mode) => (
            <button
              key={mode}
              data-mode={mode}
              aria-pressed={viewMode === mode}
              onClick={() => onViewModeChange(mode)}
              className={`px-2.5 py-[3px] text-xs capitalize transition-colors ${
                viewMode === mode
                  ? 'bg-[var(--accent-soft)] text-[var(--accent)] font-medium'
                  : 'text-[var(--muted)] hover:text-[var(--text)] hover:bg-[var(--panel)]'
              } ${mode !== 'edit' ? 'border-l border-[var(--border)]' : ''}`}
            >
              {mode}
            </button>
          ))}
        </div>

        {/* Left Sidebar Toggle Button */}
        {onToggleLeftSidebar && (
          <button
            onClick={onToggleLeftSidebar}
            className={`w-[26px] h-[24px] grid place-items-center rounded-[5px] transition-colors text-xs ${
              leftSidebarVisible
                ? 'text-[var(--text)] bg-[var(--panel)]'
                : 'text-[var(--muted)] hover:bg-[var(--panel)] hover:text-[var(--text)]'
            }`}
            title={`${leftSidebarVisible ? 'Hide' : 'Show'} left sidebar (⌘B)`}
            aria-label={`${leftSidebarVisible ? 'Hide' : 'Show'} left sidebar`}
            aria-pressed={leftSidebarVisible}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <rect width="18" height="18" x="3" y="3" rx="2" ry="2" />
              <line x1="9" x2="9" y1="3" y2="21" />
            </svg>
          </button>
        )}

        {/* Right Sidebar Toggle Button */}
        {onToggleRightSidebar && (
          <button
            onClick={onToggleRightSidebar}
            className={`w-[26px] h-[24px] grid place-items-center rounded-[5px] transition-colors text-xs ${
              rightSidebarVisible
                ? 'text-[var(--text)] bg-[var(--panel)]'
                : 'text-[var(--muted)] hover:bg-[var(--panel)] hover:text-[var(--text)]'
            }`}
            title={`${rightSidebarVisible ? 'Hide' : 'Show'} links sidebar (⌘⌥B)`}
            aria-label={`${rightSidebarVisible ? 'Hide' : 'Show'} links sidebar`}
            aria-pressed={rightSidebarVisible}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <rect width="18" height="18" x="3" y="3" rx="2" ry="2" />
              <line x1="15" x2="15" y1="3" y2="21" />
            </svg>
          </button>
        )}

        {/* Theme Toggle */}
        <button
          onClick={onToggleTheme}
          className="w-[26px] h-[24px] grid place-items-center rounded-[5px] text-[var(--muted)] hover:bg-[var(--panel)] hover:text-[var(--text)] transition-colors text-sm"
          title="Toggle light/dark theme"
          aria-label="Toggle theme"
        >
          {theme === 'dark' ? '☼' : '◐'}
        </button>

        {/* Settings Button */}
        <button
          className="w-[26px] h-[24px] grid place-items-center rounded-[5px] text-[var(--muted)] hover:bg-[var(--panel)] hover:text-[var(--text)] transition-colors text-xs"
          title="Settings (⌘,)"
          aria-label="Settings"
        >
          ⚙
        </button>
      </div>
    </div>
  );
};
