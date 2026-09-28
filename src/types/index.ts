export interface HeadingItem {
  level: number;
  text: string;
  anchor: string;
  /** 0-based source line number of the heading, used to scroll the editor precisely. */
  line?: number;
}

export interface LinkItem {
  source: string;
  raw_target?: string;
  rawTarget?: string;
  resolved?: string | null;
  line: number;
  col: number;
  context: string;
  /** Which link syntax produced this link (M10.23). Absent/older data means Markdown. */
  syntax?: "markdown" | "wikilink";
  /**
   * Non-empty only for a bare-name wikilink whose target stem matches more than one note
   * (M10.23) — candidate note paths, surfaced in the UI instead of silently picking one.
   */
  ambiguous_with?: string[];
  ambiguousWith?: string[];
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

/** Ordered `[key, rawValue]` front-matter pair, preserving source order and raw scalar/flow/block value text. */
export type FrontMatterField = [string, string];

export interface NoteContent {
  content: string;
  meta: NoteMeta;
  fingerprint: Fingerprint;
  front_matter_raw?: string | null;
  front_matter_fields: FrontMatterField[];
}

export interface NoteFixture {
  path: string;
  title: string;
  folder: string;
  frontMatter?: Record<string, any>;
  frontMatterFields?: FrontMatterField[];
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
  initial_note?: string;
  start_collapsed?: boolean;
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

// --- Local MCP server (M10.21) --------------------------------------------

export type McpPhase =
  | { state: "off" }
  | { state: "starting" }
  | { state: "listening"; url: string }
  | { state: "error"; message: string };

/** `McpPhase` plus whether bearer-token auth is required and whether a token has been
 * generated yet — auth is opt-in and off by default; the token itself is managed only from
 * Settings, never auto-generated at launch. */
export type McpStatus = McpPhase & {
  requiresAuth: boolean;
  hasToken: boolean;
};

export interface NoteEventPayload {
  path?: string;
  from?: string;
  to?: string;
}

export interface NameHit {
  path: string;
  title: string;
  score: number;
  match_indices_title: number[];
  match_indices_path: number[];
}

export interface ContentHit {
  line: number;
  col: number;
  match_length: number;
  line_text: string;
}

export interface ContentHitGroup {
  path: string;
  title: string;
  matches: ContentHit[];
}

export interface ContentSearchOptions {
  case_sensitive?: boolean;
  whole_word?: boolean;
  is_regex?: boolean;
  folder_scope?: string;
  includes?: string[];
  excludes?: string[];
}

export interface DoctorReport {
  workspace: string;
  note_count: number;
  link_count: number;
  broken_links: LinkItem[];
  orphan_notes: string[];
  unreadable_files: string[];
}

// --- Config (SPEC §12, M10.1) ---------------------------------------------

export type ConfigOrigin = "global" | "workspace";

export interface ConfigNotice {
  path: string;
  field: string;
  message: string;
}

export interface ConfigGetResult {
  config: unknown;
  origins: Record<string, ConfigOrigin>;
  notice: ConfigNotice | null;
}

export interface EditorConfig {
  fontSize: number;
  fontFamily: string;
  softWrap: boolean;
  tabSize: number;
  showLineNumbers: boolean;
  vimMode: boolean;
}

export interface MarkdownConfig {
  math: boolean;
  tables: boolean;
  footnotes: boolean;
  smartPunctuation: boolean;
  /** Second, opt-in link syntax: `[[target]]` etc. (M10.23). Off by default. */
  wikilinks: boolean;
  /**
   * Which syntax new links are inserted as. Forced to `"markdown"` whenever `wikilinks` is
   * off — wikilink insertion cannot be enabled while wikilink parsing is off.
   */
  newLinkSyntax: "markdown" | "wikilink";
}

export interface BehaviourConfig {
  autosaveMs: number;
  rewriteLinksOnRename: boolean;
  deleteToTrash: boolean;
  newNoteFolder: string;
  defaultMode: string;
}

export interface UiConfig {
  leftSidebar: string;
  rightSidebarVisible: boolean;
  showNonNoteFiles: boolean;
}

export interface McpConfig {
  enabled: boolean;
  port?: number | null;
  requireAuth: boolean;
}

export interface LayoutConfig {
  splitOrientation?: 'horizontal' | 'vertical';
  splitRatio?: number;
  leftSidebarWidth?: number;
  rightSidebarWidth?: number;
  leftSidebarCollapsed?: boolean;
  rightSidebarCollapsed?: boolean;
  activeLeftTab?: string;
  lastOpenNote?: string;
  noteModes?: Record<string, string>; // path -> 'edit'|'read'|'split'
}

export interface FlintConfig {
  version: number;
  theme: string;
  editor: EditorConfig;
  markdown: MarkdownConfig;
  behaviour: BehaviourConfig;
  ui: UiConfig;
  mcp: McpConfig;
  ignore: string[];
  layout?: LayoutConfig;
  [key: string]: unknown;
}

