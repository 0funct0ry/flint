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

export interface TreeNodeItem {
  id: string;
  name: string;
  path: string;
  isFolder: boolean;
  children?: TreeNodeItem[];
  isNote?: boolean;
}
