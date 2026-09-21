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
}

export const LeftSidebar: React.FC<LeftSidebarProps> = ({
  activeTab,
  onTabChange,
  treeData,
  currentNotePath,
  onSelectNote,
  headings,
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
      const isFolder = item.isFolder;
      const indentClass = depth === 0 ? '' : depth === 1 ? 'pl-[22px]' : depth === 2 ? 'pl-[36px]' : 'pl-[50px]';

      return (
        <React.Fragment key={item.id}>
          <div
            role="treeitem"
            aria-selected={isSelected}
            aria-expanded={isFolder ? isExpanded : undefined}
            onClick={() => {
              if (isFolder) {
                toggleFolder(item.path);
              } else if (item.isNote) {
                onSelectNote(item.path);
              }
            }}
            className={`flex items-center gap-1.5 h-6 px-2.5 text-[var(--text-2)] cursor-default whitespace-nowrap select-none hover:bg-[var(--panel-2)] transition-colors ${indentClass} ${
              isSelected ? 'bg-[var(--sel)] text-[var(--text)] font-medium' : ''
            } ${!item.isNote && !item.isFolder ? 'text-[var(--faint)]' : ''}`}
          >
            {/* Twisty arrow */}
            <span className="w-3 text-[var(--faint)] text-[9px] text-center shrink-0">
              {isFolder ? (isExpanded ? '▾' : '▸') : ''}
            </span>

            {/* Glyph icon */}
            <span
              className={`w-[13px] shrink-0 text-xs ${
                isSelected ? 'text-[var(--accent)]' : 'text-[var(--faint)]'
              }`}
            >
              {isFolder ? '▤' : item.isNote ? '◦' : '◌'}
            </span>

            {/* Name */}
            <span className="truncate text-[12.5px]">{item.name}</span>
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
          <div role="tree" aria-label="Workspace file tree" tabIndex={0} className="focus:outline-none">
            {renderTree(treeData)}
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
