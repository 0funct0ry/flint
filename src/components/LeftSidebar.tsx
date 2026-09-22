import React, { useState } from 'react';
import { TreeNodeItem, HeadingItem } from '../types';
import { FIXTURE_NOTES } from '../fixtures/workspace';

export type LeftTab = 'tree' | 'search' | 'outline';

export interface LeftSidebarProps {
  activeTab: LeftTab;
  onTabChange: (tab: LeftTab) => void;
  treeData: TreeNodeItem[];
  currentNotePath: string;
  onSelectNote: (path: string) => void;
  headings: HeadingItem[];
  isEmpty?: boolean;
  error?: string | null;
  onCreateNote?: () => void;
}

export const LeftSidebar: React.FC<LeftSidebarProps> = ({
  activeTab,
  onTabChange,
  treeData,
  currentNotePath,
  onSelectNote,
  headings,
  isEmpty = false,
  error = null,
  onCreateNote,
}) => {
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(
    new Set(['projects', 'projects/payments', 'archive', 'reading', 'guides'])
  );

  // Search panel state
  const [searchQuery, setSearchQuery] = useState('settlement window');
  const [caseSensitive, setCaseSensitive] = useState(true);
  const [wholeWord, setWholeWord] = useState(false);
  const [isRegex, setIsRegex] = useState(false);
  const [folderScope, setFolderScope] = useState(false);

  const toggleFolder = (path: string) => {
    setExpandedFolders((prev) => {
      const next = new Set(prev);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  };

  // Compute search hits across fixture notes
  const searchHits = React.useMemo(() => {
    if (!searchQuery.trim()) return [];
    const results: Array<{
      notePath: string;
      matches: Array<{ line: number; text: string; matchSpan: [number, number] }>;
    }> = [];

    Object.values(FIXTURE_NOTES).forEach((note) => {
      const lines = note.content.split('\n');
      const noteMatches: Array<{ line: number; text: string; matchSpan: [number, number] }> = [];

      lines.forEach((line, idx) => {
        let matchIdx = -1;
        if (caseSensitive) {
          matchIdx = line.indexOf(searchQuery);
        } else {
          matchIdx = line.toLowerCase().indexOf(searchQuery.toLowerCase());
        }

        if (matchIdx !== -1) {
          noteMatches.push({
            line: idx + 1,
            text: line,
            matchSpan: [matchIdx, matchIdx + searchQuery.length],
          });
        }
      });

      if (noteMatches.length > 0) {
        results.push({
          notePath: note.path,
          matches: noteMatches,
        });
      }
    });

    return results;
  }, [searchQuery, caseSensitive]);

  // Render recursive tree rows
  const renderTree = (items: TreeNodeItem[], depth = 0) => {
    return items.map((item) => {
      const isExpanded = expandedFolders.has(item.path);
      const isSelected = currentNotePath === item.path;
      const isFolder = item.is_folder;
      const isNote = Boolean(item.is_note);

      // Icon colors and specific highlights matching the screenshot
      const isGitIgnore = item.name === '.gitignore';
      const isMarkdownDoc = item.name.endsWith('.md');
      const isSpecialFolder = item.name === 'crates' || item.name === 'src';
      const isGreenFolder = item.name === '.flint';

      return (
        <React.Fragment key={item.id}>
          <div
            role="treeitem"
            aria-selected={isSelected}
            aria-expanded={isFolder ? isExpanded : undefined}
            onClick={() => {
              if (isFolder) {
                toggleFolder(item.path);
              } else if (isNote) {
                onSelectNote(item.path);
              }
            }}
            style={{ paddingLeft: `${depth * 14 + 10}px` }}
            className={`group flex items-center gap-2 h-[26px] pr-2 text-[var(--text-2)] cursor-pointer whitespace-nowrap select-none rounded-[4px] mx-1 hover:bg-[var(--panel-2)] transition-colors ${
              isSelected ? 'bg-[#2b3040] text-[#ffffff] font-medium' : ''
            } ${!isNote && !isFolder ? 'text-[var(--text-2)] opacity-80' : ''}`}
          >
            {/* Folder / File Icon (without caret) */}
            <span className="w-4 h-4 flex items-center justify-center shrink-0">
              {isFolder ? (
                /* Clean outlined folder icon matching screenshot */
                <svg
                  width="15"
                  height="15"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke={isExpanded ? 'var(--text)' : 'currentColor'}
                  strokeWidth="1.8"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  className="opacity-80 group-hover:opacity-100"
                >
                  <path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.93a2 2 0 0 1-1.66-.9l-.82-1.2A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z" />
                </svg>
              ) : isGitIgnore ? (
                /* Git branch / ignore icon */
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  className="opacity-85"
                >
                  <line x1="6" y1="3" x2="6" y2="15" />
                  <circle cx="18" cy="6" r="3" />
                  <circle cx="6" cy="18" r="3" />
                  <path d="M18 9a9 9 0 0 1-9 9" />
                </svg>
              ) : isMarkdownDoc ? (
                /* Book / Doc markdown icon */
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  className="opacity-85"
                >
                  <path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H20v20H6.5a2.5 2.5 0 0 1-2.5-2.5Z" />
                  <path d="M6 6h10" />
                  <path d="M6 10h10" />
                </svg>
              ) : (
                /* Clean file outline */
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  className="opacity-60"
                >
                  <path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z" />
                  <polyline points="14 2 14 8 20 8" />
                </svg>
              )}
            </span>

            {/* Name with subtle colors like in the screenshot */}
            <span
              className={`truncate text-[13px] leading-none ${
                isSpecialFolder
                  ? 'text-[#f6c177]'
                  : isGreenFolder
                  ? 'text-[#a6da95]'
                  : isSelected
                  ? 'text-white'
                  : 'text-[var(--text-2)] group-hover:text-[var(--text)]'
              }`}
            >
              {item.name}
            </span>
          </div>

          {isFolder && isExpanded && item.children && renderTree(item.children, depth + 1)}
        </React.Fragment>
      );
    });
  };


  return (
    <aside className="w-[236px] shrink-0 flex flex-col bg-[var(--panel)] border-r border-[var(--border)] min-h-0 select-none">
      {/* Tabs */}
      <div className="flex h-[31px] shrink-0 border-b border-[var(--border)]" role="tablist">
        <button
          role="tab"
          aria-selected={activeTab === 'tree'}
          onClick={() => onTabChange('tree')}
          className={`px-3 text-[11.5px] tracking-wide transition-colors ${
            activeTab === 'tree'
              ? 'text-[var(--text)] font-medium shadow-[inset_0_-2px_0_var(--accent)]'
              : 'text-[var(--muted)] hover:text-[var(--text)]'
          }`}
        >
          Workspace
        </button>
        <button
          role="tab"
          aria-selected={activeTab === 'search'}
          onClick={() => onTabChange('search')}
          className={`px-3 text-[11.5px] tracking-wide transition-colors ${
            activeTab === 'search'
              ? 'text-[var(--text)] font-medium shadow-[inset_0_-2px_0_var(--accent)]'
              : 'text-[var(--muted)] hover:text-[var(--text)]'
          }`}
        >
          Search
        </button>
        <button
          role="tab"
          aria-selected={activeTab === 'outline'}
          onClick={() => onTabChange('outline')}
          className={`px-3 text-[11.5px] tracking-wide transition-colors ${
            activeTab === 'outline'
              ? 'text-[var(--text)] font-medium shadow-[inset_0_-2px_0_var(--accent)]'
              : 'text-[var(--muted)] hover:text-[var(--text)]'
          }`}
        >
          Outline
        </button>
      </div>

      {/* Pane Content */}
      <div className="flex-1 overflow-auto py-1.5 min-h-0">
        {/* WORKSPACE TREE TAB */}
        {activeTab === 'tree' && (
          <div role="tree" aria-label="Workspace file tree" tabIndex={0} className="focus:outline-none h-full">
            {error ? (
              <div className="p-4 text-center">
                <div className="text-xs text-[var(--spark)] mb-2 font-medium">
                  {error}
                </div>
                <div className="text-[11px] text-[var(--muted)]">
                  Check workspace path and folder permissions.
                </div>
              </div>
            ) : isEmpty || treeData.length === 0 ? (
              <div className="p-4 flex flex-col items-center justify-center text-center h-48">
                <div className="text-xs text-[var(--muted)] mb-3 font-medium">
                  Workspace is empty
                </div>
                <button
                  onClick={onCreateNote}
                  className="px-2.5 py-1 text-xs bg-[var(--accent)] text-white rounded-[5px] hover:opacity-90 font-medium transition-opacity"
                >
                  Create your first note
                </button>
              </div>
            ) : (
              renderTree(treeData)
            )}
          </div>
        )}

        {/* SEARCH TAB */}
        {activeTab === 'search' && (
          <div className="flex flex-col h-full">
            <div className="p-2.5 pb-2 border-b border-[var(--border)]">
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search in workspace..."
                aria-label="Search note contents"
                className="w-full px-2 py-1 text-xs text-[var(--text)] bg-[var(--canvas)] border border-[var(--border)] rounded-[5px] focus:outline-none focus:border-[var(--accent)]"
              />
              <div className="flex gap-1.5 mt-2">
                <button
                  aria-pressed={caseSensitive}
                  onClick={() => setCaseSensitive(!caseSensitive)}
                  title="Match Case"
                  className={`font-mono text-[11px] px-1.5 py-0.5 border rounded ${
                    caseSensitive
                      ? 'border-[var(--accent)] text-[var(--accent)] bg-[var(--accent-soft)]'
                      : 'border-[var(--border)] text-[var(--muted)] hover:text-[var(--text)]'
                  }`}
                >
                  Aa
                </button>
                <button
                  aria-pressed={wholeWord}
                  onClick={() => setWholeWord(!wholeWord)}
                  title="Match Whole Word"
                  className={`font-mono text-[11px] px-1.5 py-0.5 border rounded ${
                    wholeWord
                      ? 'border-[var(--accent)] text-[var(--accent)] bg-[var(--accent-soft)]'
                      : 'border-[var(--border)] text-[var(--muted)] hover:text-[var(--text)]'
                  }`}
                >
                  ab
                </button>
                <button
                  aria-pressed={isRegex}
                  onClick={() => setIsRegex(!isRegex)}
                  title="Use Regular Expression"
                  className={`font-mono text-[11px] px-1.5 py-0.5 border rounded ${
                    isRegex
                      ? 'border-[var(--accent)] text-[var(--accent)] bg-[var(--accent-soft)]'
                      : 'border-[var(--border)] text-[var(--muted)] hover:text-[var(--text)]'
                  }`}
                >
                  .*
                </button>
                <button
                  aria-pressed={folderScope}
                  onClick={() => setFolderScope(!folderScope)}
                  title="Scope to active folder"
                  className={`font-mono text-[11px] px-1.5 py-0.5 border rounded ${
                    folderScope
                      ? 'border-[var(--accent)] text-[var(--accent)] bg-[var(--accent-soft)]'
                      : 'border-[var(--border)] text-[var(--muted)] hover:text-[var(--text)]'
                  }`}
                >
                  ▤
                </button>
              </div>
            </div>

            <div className="flex-1 overflow-auto p-1">
              {searchHits.length === 0 ? (
                <div className="p-4 text-center text-xs text-[var(--faint)]">
                  No matching results found.
                </div>
              ) : (
                searchHits.map((group) => (
                  <div key={group.notePath} className="mb-2">
                    <div className="px-2.5 py-1 text-[11.5px] font-medium text-[var(--muted)] truncate">
                      {group.notePath} · {group.matches.length}
                    </div>
                    {group.matches.map((hit, idx) => (
                      <div
                        key={idx}
                        onClick={() => onSelectNote(group.notePath)}
                        className="flex gap-2 px-2.5 py-1 text-[11.5px] font-mono text-[var(--text-2)] hover:bg-[var(--panel-2)] cursor-pointer truncate rounded"
                      >
                        <span className="text-[var(--faint)] min-w-[20px] text-right shrink-0">
                          {hit.line}
                        </span>
                        <span className="truncate">
                          {hit.text.slice(0, hit.matchSpan[0])}
                          <mark className="bg-[rgba(201,138,46,0.28)] text-inherit rounded-sm px-0.5">
                            {hit.text.slice(hit.matchSpan[0], hit.matchSpan[1])}
                          </mark>
                          {hit.text.slice(hit.matchSpan[1])}
                        </span>
                      </div>
                    ))}
                  </div>
                ))
              )}
            </div>
          </div>
        )}

        {/* OUTLINE TAB */}
        {activeTab === 'outline' && (
          <div className="flex flex-col">
            <div className="px-3 py-1.5 text-[11px] font-medium text-[var(--faint)] truncate">
              {currentNotePath.split('/').pop()}
            </div>
            {headings.length === 0 ? (
              <div className="p-4 text-center text-xs text-[var(--faint)]">
                No headings in this note.
              </div>
            ) : (
              headings.map((h, i) => {
                const indentClass =
                  h.level === 1 ? 'pl-2.5' : h.level === 2 ? 'pl-6' : 'pl-9';
                return (
                  <div
                    key={i}
                    className={`flex items-center gap-1.5 h-6 pr-2 text-[12px] text-[var(--text-2)] hover:bg-[var(--panel-2)] cursor-pointer select-none ${indentClass}`}
                  >
                    <span className="text-[var(--faint)] text-xs">§</span>
                    <span className="truncate">{h.text}</span>
                  </div>
                );
              })
            )}
          </div>
        )}
      </div>
    </aside>
  );
};
