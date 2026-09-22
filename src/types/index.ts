export interface HeadingItem {
  level: number;
  text: string;
  anchor: string;
}

export interface LinkItem {
  source: string;
  rawTarget: string;
  resolved?: string;
  line: number;
  col: number;
  context: string;
}

export interface BacklinkOccurrence {
  line: number;
  context: string;
}

export interface BacklinkGroup {
  sourcePath: string;
  sourceTitle: string;
  folder: string;
  occurrences: BacklinkOccurrence[];
}

export interface NoteFixture {
  path: string;
  title: string;
  folder: string;
  frontMatter?: Record<string, any>;
  content: string;
  renderedHtml: string;
  headings: HeadingItem[];
  outgoingLinks: LinkItem[];
  backlinks: BacklinkGroup[];
  tags: string[];
  lastModifiedAgo: string;
}

export interface WorkspaceInfo {
  name: string;
  path: string;
  is_empty: boolean;
}

export interface TreeNodeItem {
  id: string;
  name: string;
  path: string;
  is_folder: boolean;
  children?: TreeNodeItem[];
  is_note?: boolean;
  title?: string;
}

