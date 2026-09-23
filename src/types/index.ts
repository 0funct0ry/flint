export interface HeadingItem {
  level: number;
  text: string;
  anchor: string;
}

export interface LinkItem {
  source: string;
  raw_target?: string;
  rawTarget?: string;
  resolved?: string | null;
  line: number;
  col: number;
  context: string;
}

export interface BacklinkOccurrence {
  line: number;
  context: string;
}

export interface BacklinkGroup {
  source_path?: string;
  sourcePath?: string;
  source_title?: string;
  sourceTitle?: string;
  folder: string;
  occurrences: BacklinkOccurrence[];
}

export interface WorkspaceStats {
  note_count: number;
  link_count: number;
  unresolved_count: number;
}

export interface IndexProgressEvent {
  indexed: number;
  total: number;
}

export interface Fingerprint {
  path: string;
  size_bytes: number;
  modified_ms: number;
  content_hash: string;
}

export interface NoteMeta {
  path: string;
  title: string;
  size_bytes: number;
  modified_ms: number;
  headings: HeadingItem[];
  tags: string[];
}

export interface NoteContent {
  content: string;
  meta: NoteMeta;
  fingerprint: Fingerprint;
  front_matter_raw?: string | null;
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

export interface RenameResult {
  moved: boolean;
  links_updated: number;
}

export interface RenderResult {
  html: string;
  headings: HeadingItem[];
}

export interface WatcherDegradedPayload {
  reason: string;
}

export interface NoteEventPayload {
  path?: string;
  from?: string;
  to?: string;
}

