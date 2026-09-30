import { invoke } from "@tauri-apps/api/core";
import {
  BacklinkGroup,
  ContentHit,
  ContentHitGroup,
  ContentSearchOptions,
  DoctorReport,
  Fingerprint,
  FrontMatterField,
  LinkItem,
  NameHit,
  NoteContent,
  NoteMeta,
  CreatedNote,
  RenameResult,
  TagRenameResult,
  RenderResult,
  TreeNodeItem,
  WorkspaceInfo,
  WorkspaceStats,
  ConfigGetResult,
  FlintConfig,
  McpStatus,
  TemplateMeta,
  TemplateVariableDef,
  ResolvedTemplateVariable,
} from "../types";
import { FIXTURE_NOTES } from "../fixtures/workspace";
import { renderMarkdownToHtml, slugify, dedupSlug } from "./markdown";
import { parseFrontMatter, setFrontMatterFields } from "./frontmatter";

export const isTauriEnvironment = (): boolean => {
  return typeof window !== "undefined" && Boolean((window as any).__TAURI_INTERNALS__);
};

// Fallback in-memory storage for browser dev/test
const browserMockStorage: Record<
  string,
  { content: string; hash: string; modified: number }
> = {};
const DEFAULT_CONFIG: FlintConfig = {
  version: 1,
  theme: "system",
  editor: {
    fontSize: 14,
    fontFamily: "IBM Plex Mono",
    softWrap: true,
    tabSize: 2,
    showLineNumbers: false,
    vimMode: false,
  },
  markdown: {
    math: true,
    tables: true,
    footnotes: true,
    smartPunctuation: true,
    wikilinks: false,
    newLinkSyntax: "markdown",
  },
  behaviour: {
    autosaveMs: 400,
    rewriteLinksOnRename: true,
    deleteToTrash: true,
    newNoteFolder: "",
    defaultMode: "edit",
  },
  ui: {
    leftSidebar: "tree",
    rightSidebarVisible: true,
    showNonNoteFiles: false,
  },
  mcp: {
    enabled: false,
    port: null,
    requireAuth: false,
  },
  templates: {
    defaultTemplate: null,
    globalVariables: {},
  },
  newNote: {
    targetFolder: null,
    filenamePattern: "{{ title }}",
    insertHeading: false,
  },
  dailyNotes: {
    enabled: false,
    pathPattern: "daily/{{ date(fmt=\"YYYY-MM-DD\") }}.md",
    template: null,
  },
  ignore: ["node_modules/**", ".obsidian/**"],
  layout: {},
};

// Browser dev/test mock for `.flint/templates/` (M10.26) — mirrors the `flint init` seed so the
// picker and settings dropdowns have something non-empty to show outside the real Tauri app.
const browserMockTemplates: Record<string, string> = {
  "daily.md": "# {{ date() }}\n\n## Notes\n\n## Tasks\n\n- [ ] \n",
};

// Browser dev/test mock for folder-scoped template variables (M10.27 Journey C), keyed by
// workspace-relative folder path (`""` for the workspace root).
const browserMockFolderVariables: Record<string, Record<string, string>> = {};

/** Mirror of `compose_template` in flint-app: merge the editor text's own front matter with the
 * hidden `templateVariables` schema (kept first) instead of dropping or duplicating it. */
function composeMockTemplate(schema: string | undefined, editorText: string): string {
  const parsed = parseFrontMatter(editorText);
  const fields: [string, string][] = [];
  if (schema !== undefined) fields.push(["templateVariables", schema]);
  fields.push(...parsed.fields.filter(([k]) => k !== "templateVariables"));
  return fields.length > 0 ? setFrontMatterFields(parsed.body, fields) : parsed.body;
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : `${String(n)}`;
}

/** Minimal mirror of the Tera-based `flint_core::render_template` for the browser mock path —
 * only `{{ title|path|folder|var.x|date(fmt=…)|time() }}` with the `slugify`/`upper`/`lower`/`trim`
 * filters; `{% … %}` blocks, sequences and lookups exist only in the Rust engine. Anything the
 * mock can't evaluate is left as written, like the real engine's fallback. */
function mockFormatDate(now: Date, fmt: string): string {
  return fmt
    .replace(/YYYY/g, String(now.getFullYear()))
    .replace(/MM/g, pad2(now.getMonth() + 1))
    .replace(/DD/g, pad2(now.getDate()))
    .replace(/HH/g, pad2(now.getHours()))
    .replace(/mm/g, pad2(now.getMinutes()))
    .replace(/ss/g, pad2(now.getSeconds()));
}

function mockApplyFilter(fn: string, value: string): string | undefined {
  switch (fn) {
    case "slugify":
      return value
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "");
    case "upper":
      return value.toUpperCase();
    case "lower":
      return value.toLowerCase();
    case "trim":
      return value.trim();
    default:
      return undefined;
  }
}

function mockRenderTemplate(
  body: string,
  ctx: { title: string; path: string; now: Date; variables?: Record<string, string> }
): string {
  return body.replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (whole, inner: string) => {
    const [head, ...filters] = inner.split("|").map((part) => part.trim());
    let value: string | undefined;
    const call = /^(date|time)\(\s*(?:fmt\s*=\s*"([^"]*)")?\s*\)$/.exec(head);
    if (call) {
      value = mockFormatDate(ctx.now, call[2] ?? (call[1] === "date" ? "YYYY-MM-DD" : "HH:mm"));
    } else if (head === "title") {
      value = ctx.title;
    } else if (head === "path") {
      value = ctx.path;
    } else if (head === "folder") {
      value = ctx.path.includes("/") ? ctx.path.slice(0, ctx.path.lastIndexOf("/")) : "";
    } else if (head.startsWith("var.")) {
      value = ctx.variables?.[head.slice(4)];
    }
    if (value === undefined) return whole;
    for (const fn of filters) {
      const next = mockApplyFilter(fn, value);
      if (next === undefined) return whole;
      value = next;
    }
    return value;
  });
}

const browserMockConfig: FlintConfig = JSON.parse(JSON.stringify(DEFAULT_CONFIG));

// Dotted paths explicitly overridden via configSet(), mirroring the real backend's
// workspace-vs-global `origins` map (present = "workspace" override, absent = default).
const browserMockOrigins: Record<string, "workspace"> = {};

function getAtPath(obj: unknown, path: string): unknown {
  const parts = path.split(".");
  let cur: any = obj;
  for (const part of parts) {
    if (cur === null || cur === undefined) return undefined;
    cur = cur[part];
  }
  return cur;
}

function setAtPath(obj: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split(".");
  let cur: any = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i];
    if (typeof cur[part] !== "object" || cur[part] === null) {
      cur[part] = {};
    }
    cur = cur[part];
  }
  cur[parts[parts.length - 1]] = value;
}

function deleteAtPath(obj: Record<string, unknown>, path: string): void {
  const parts = path.split(".");
  let cur: any = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i];
    if (typeof cur[part] !== "object" || cur[part] === null) return;
    cur = cur[part];
  }
  delete cur[parts[parts.length - 1]];
}
const browserMockTree: TreeNodeItem[] = [
  {
    id: "projects",
    name: "projects",
    path: "projects",
    is_folder: true,
    children: [
      {
        id: "projects/payments",
        name: "payments",
        path: "projects/payments",
        is_folder: true,
        children: [
          {
            id: "projects/payments/settlement.md",
            name: "settlement.md",
            path: "projects/payments/settlement.md",
            is_folder: false,
            is_note: true,
            title: "Settlement windows",
          },
          {
            id: "projects/payments/rails.md",
            name: "rails.md",
            path: "projects/payments/rails.md",
            is_folder: false,
            is_note: true,
            title: "Payment rails overview",
          },
          {
            id: "projects/payments/bbps-flows.md",
            name: "bbps-flows.md",
            path: "projects/payments/bbps-flows.md",
            is_folder: false,
            is_note: true,
            title: "BBPS transaction flows",
          },
        ],
      },
    ],
  },
  {
    id: "daily.md",
    name: "daily.md",
    path: "daily.md",
    is_folder: false,
    is_note: true,
    title: "Daily Log",
  },
];

export const api = {
  async workspaceOpen(path?: string): Promise<WorkspaceInfo> {
    if (isTauriEnvironment()) {
      return await invoke<WorkspaceInfo>("workspace_open", { path });
    }
    return {
      name: "projects",
      path: "~/notes/projects",
      is_empty: false,
    };
  },

  async workspaceTree(showNonNoteFiles?: boolean): Promise<TreeNodeItem[]> {
    if (isTauriEnvironment()) {
      return await invoke<TreeNodeItem[]>("workspace_tree", { showNonNoteFiles });
    }
    return JSON.parse(JSON.stringify(browserMockTree));
  },

  async noteRead(path: string): Promise<NoteContent> {
    if (isTauriEnvironment()) {
      return await invoke<NoteContent>("note_read", { path });
    }

    const fixture = FIXTURE_NOTES[path] || {
      path,
      title: path.split("/").pop()?.replace(/\.md$/, "") || "Untitled",
      folder: path.split("/").slice(0, -1).join("/"),
      tags: [],
      content: `# ${path.split("/").pop()?.replace(/\.md$/, "") || "Untitled"}\n\nNote content...`,
      headings: [{ level: 1, text: path.split("/").pop()?.replace(/\.md$/, "") || "Untitled", anchor: "title", line: 0 }],
      outgoingLinks: [],
      backlinks: [],
      renderedHtml: `<p>Note content...</p>`,
      lastModifiedAgo: "just now",
    };

    const stored = browserMockStorage[path];
    const content = stored ? stored.content : fixture.content;
    const hash = stored ? stored.hash : "mock-hash-" + content.length;
    const modified = stored ? stored.modified : Date.now();

    // Derive front matter straight from the note's actual content on every read (matching the
    // real backend's `parse_front_matter`), so fields added/edited by hand in the buffer or the
    // markdown file show up in the panel without a separate cache to keep in sync.
    const { raw: frontMatterRaw, fields: frontMatterFields } = parseFrontMatter(content);

    return {
      content,
      meta: {
        path,
        title: fixture.title,
        size_bytes: content.length,
        modified_ms: modified,
        headings: fixture.headings,
        tags: fixture.tags,
      },
      fingerprint: {
        path,
        size_bytes: content.length,
        modified_ms: modified,
        content_hash: hash,
      },
      front_matter_raw: frontMatterRaw,
      front_matter_fields: frontMatterFields,
    };
  },

  async noteWrite(
    path: string,
    content: string,
    fingerprint?: Fingerprint
  ): Promise<Fingerprint> {
    if (isTauriEnvironment()) {
      return await invoke<Fingerprint>("note_write", { path, content, fingerprint });
    }

    // Mock conflict check in browser environment
    const current = browserMockStorage[path];
    if (fingerprint && current && current.hash !== fingerprint.content_hash) {
      throw new Error("Conflict detected: note on disk was modified externally");
    }

    const newHash = "mock-hash-" + content.length + "-" + Date.now();
    const now = Date.now();
    browserMockStorage[path] = {
      content,
      hash: newHash,
      modified: now,
    };

    return {
      path,
      size_bytes: content.length,
      modified_ms: now,
      content_hash: newHash,
    };
  },

  async frontmatterSet(
    path: string,
    fields: FrontMatterField[],
    fingerprint?: Fingerprint
  ): Promise<Fingerprint> {
    if (isTauriEnvironment()) {
      return await invoke<Fingerprint>("frontmatter_set", { path, fields, fingerprint });
    }

    // Mock conflict check in browser environment, mirroring noteWrite.
    const current = browserMockStorage[path];
    if (fingerprint && current && current.hash !== fingerprint.content_hash) {
      throw new Error("Conflict detected: note on disk was modified externally");
    }

    const fixture = FIXTURE_NOTES[path];
    const previousContent = current ? current.content : fixture?.content || "";
    const content = setFrontMatterFields(previousContent, fields);
    const newHash = "mock-hash-" + content.length + "-" + Date.now() + "-fm";
    const now = Date.now();
    browserMockStorage[path] = {
      content,
      hash: newHash,
      modified: now,
    };

    return {
      path,
      size_bytes: content.length,
      modified_ms: now,
      content_hash: newHash,
    };
  },

  /**
   * `template`, when given, is a path relative to `.flint/templates/` (M10.26) — rendered with
   * Tera syntax (`{{ date() }}`, `{{ title }}`, …) — not literal content.
   */
  async noteCreate(path: string, template?: string, variables?: Record<string, string>): Promise<CreatedNote> {
    if (isTauriEnvironment()) {
      return await invoke<CreatedNote>("note_create", { path, template, variables });
    }

    const title = path.split("/").pop()?.replace(/\.md$/, "") || "Untitled";
    const ctx = { title, path, now: new Date(), variables };
    let content: string;
    if (template) {
      // The template's own front-matter fields carry over to the note, except the
      // `templateVariables` schema field (mirrors `render_template_file` on the Rust side).
      const parsed = parseFrontMatter(browserMockTemplates[template] ?? "");
      content = mockRenderTemplate(parsed.body, ctx);
      const fields = parsed.fields
        .filter(([k]) => k !== "templateVariables")
        .map(([k, v]) => [k, mockRenderTemplate(v, ctx)] as [string, string]);
      if (fields.length > 0) content = setFrontMatterFields(content, fields);
    } else if (browserMockConfig.newNote.insertHeading) {
      content = mockRenderTemplate("# {{ title }}\n", ctx);
    } else {
      content = "";
    }
    browserMockStorage[path] = {
      content,
      hash: "mock-hash-" + content.length + "-" + Date.now(),
      modified: Date.now(),
    };

    return {
      path,
      title,
      size_bytes: content.length,
      modified_ms: Date.now(),
      headings: [],
      tags: [],
    };
  },

  async templatesList(): Promise<TemplateMeta[]> {
    if (isTauriEnvironment()) {
      return await invoke<TemplateMeta[]>("templates_list");
    }
    return Object.keys(browserMockTemplates).map((path) => ({
      name: path.replace(/\.md$/, ""),
      path,
    }));
  },

  /** Author a new `.flint/templates/<slug>.md` file with a declared variable schema and an
   * authored Markdown body (M10.27 Journey A / follow-up body editor). Returns the created
   * template's metadata so callers can select it directly. */
  async templateCreate(
    name: string,
    variables: TemplateVariableDef[],
    body: string
  ): Promise<TemplateMeta> {
    if (isTauriEnvironment()) {
      return await invoke<TemplateMeta>("template_create", { name, variables, body });
    }
    const slug = slugify(name);
    const path = `${slug}.md`;
    browserMockTemplates[path] = composeMockTemplate(JSON.stringify(variables), body);
    return { name, path };
  },

  /** Read a template file's declared variable schema (M10.27 Journey A, "Edit template
   * variables…"). */
  async templateVariablesGet(templatePath: string): Promise<TemplateVariableDef[]> {
    if (isTauriEnvironment()) {
      return await invoke<TemplateVariableDef[]>("template_variables_get", {
        templatePath,
      });
    }
    const raw = browserMockTemplates[templatePath] ?? "";
    const { fields } = parseFrontMatter(raw);
    const field = fields.find(([k]) => k === "templateVariables");
    if (!field) return [];
    try {
      return JSON.parse(field[1].replace(/^"|"$/g, "").replace(/\\"/g, '"'));
    } catch {
      return [];
    }
  },

  /** Rewrite only a template file's `templateVariables` front-matter field (M10.27). */
  async templateVariablesSet(templatePath: string, variables: TemplateVariableDef[]): Promise<void> {
    if (isTauriEnvironment()) {
      await invoke("template_variables_set", { templatePath, variables });
      return;
    }
    const current = browserMockTemplates[templatePath] ?? "";
    browserMockTemplates[templatePath] = setFrontMatterFields(current, [
      ["templateVariables", JSON.stringify(variables)],
    ]);
  },

  /** Read a template file's body (everything after its front-matter block, if any) for the
   * Templates screen's CodeMirror body editor (M10.27 follow-up). */
  async templateBodyGet(templatePath: string): Promise<string> {
    if (isTauriEnvironment()) {
      return await invoke<string>("template_body_get", { templatePath });
    }
    const raw = browserMockTemplates[templatePath] ?? "";
    const parsed = parseFrontMatter(raw);
    const visible = parsed.fields.filter(([k]) => k !== "templateVariables");
    return visible.length > 0 ? setFrontMatterFields(parsed.body, visible) : parsed.body;
  },

  /** Rewrite only a template file's body, leaving its `templateVariables` front-matter field
   * untouched (M10.27 follow-up). */
  async templateBodySet(templatePath: string, body: string): Promise<void> {
    if (isTauriEnvironment()) {
      await invoke("template_body_set", { templatePath, body });
      return;
    }
    const current = browserMockTemplates[templatePath] ?? "";
    const schema = parseFrontMatter(current).fields.find(([k]) => k === "templateVariables")?.[1];
    browserMockTemplates[templatePath] = composeMockTemplate(schema, body);
  },

  /** Server-side precedence resolution for the New Note modal's variable fields (M10.27 Journey
   * B/C): explicit > nearest-ancestor folder scope > global scope > schema default. */
  async resolveNewNoteVariables(
    templatePath: string | undefined,
    targetFolder: string | undefined
  ): Promise<ResolvedTemplateVariable[]> {
    if (isTauriEnvironment()) {
      return await invoke<ResolvedTemplateVariable[]>("resolve_new_note_variables", {
        templatePath,
        targetFolder,
      });
    }
    if (!templatePath) return [];
    const defs = await api.templateVariablesGet(templatePath);
    const globalScope = browserMockConfig.templates.globalVariables ?? {};
    const folderScope = browserMockFolderVariables[targetFolder ?? ""] ?? {};
    return defs.map((def) => ({
      def,
      resolvedDefault: folderScope[def.name] ?? globalScope[def.name] ?? def.default,
    }));
  },

  /** Read one folder's variable scope (M10.27 Journey C). */
  async folderVariablesGet(folderPath: string): Promise<Record<string, string>> {
    if (isTauriEnvironment()) {
      return await invoke<Record<string, string>>("folder_variables_get", { folderPath });
    }
    return { ...(browserMockFolderVariables[folderPath] ?? {}) };
  },

  /** Write one folder's variable scope (M10.27 Journey C, "Folder variables…" modal). */
  async folderVariablesSet(folderPath: string, variables: Record<string, string>): Promise<void> {
    if (isTauriEnvironment()) {
      await invoke("folder_variables_set", { folderPath, variables });
      return;
    }
    browserMockFolderVariables[folderPath] = { ...variables };
  },

  /**
   * Open (creating on first use) the daily note for a day. `offsetDays` is relative to today
   * (`-1` yesterday, `0`/undefined today, `1` tomorrow); `date` (`YYYY-MM-DD`) picks an explicit
   * day and wins over `offsetDays`. Never called automatically — only from an explicit command.
   */
  async dailyNoteOpen(
    offsetDays?: number,
    date?: string,
    variables?: Record<string, string>
  ): Promise<CreatedNote> {
    if (isTauriEnvironment()) {
      return await invoke<CreatedNote>("daily_note_open", { offsetDays, date, variables });
    }

    const target = date ? new Date(`${date}T00:00:00`) : new Date();
    if (!date) {
      target.setDate(target.getDate() + (offsetDays ?? 0));
    }
    const pathCtx = { title: "", path: "", now: target };
    const relPath = mockRenderTemplate(browserMockConfig.dailyNotes.pathPattern, pathCtx);

    const existing = browserMockStorage[relPath];
    if (existing) {
      const title = relPath.split("/").pop()?.replace(/\.md$/, "") || "Untitled";
      return {
        path: relPath,
        title,
        size_bytes: existing.content.length,
        modified_ms: existing.modified,
        headings: [],
        tags: [],
      };
    }

    const dailyTemplate = browserMockConfig.dailyNotes.template ?? undefined;
    return api.noteCreate(relPath, dailyTemplate);
  },

  async noteRename(from: string, to: string, rewriteLinks?: boolean): Promise<RenameResult> {
    if (isTauriEnvironment()) {
      return await invoke<RenameResult>("note_rename", { from, to, rewriteLinks });
    }

    if (browserMockStorage[from]) {
      browserMockStorage[to] = browserMockStorage[from];
      delete browserMockStorage[from];
    }

    // `.flint/templates/*.md` files are plain notes too (M10.27) but live in a separate mock
    // store; renaming one (e.g. the Templates screen's rename affordance) must move it there too.
    const templatesPrefix = ".flint/templates/";
    if (from.startsWith(templatesPrefix) && to.startsWith(templatesPrefix)) {
      const fromKey = from.slice(templatesPrefix.length);
      const toKey = to.slice(templatesPrefix.length);
      if (browserMockTemplates[fromKey] !== undefined) {
        browserMockTemplates[toKey] = browserMockTemplates[fromKey];
        delete browserMockTemplates[fromKey];
      }
    }

    return {
      moved: true,
      links_updated: 0,
    };
  },

  async tagRename(oldTag: string, newTag: string): Promise<TagRenameResult> {
    if (isTauriEnvironment()) {
      return await invoke<TagRenameResult>("tag_rename", { old: oldTag, new: newTag });
    }

    return {
      renamed: true,
      notes_updated: 0,
    };
  },

  async noteDuplicate(path: string): Promise<NoteMeta> {
    if (isTauriEnvironment()) {
      return await invoke<NoteMeta>("note_duplicate", { path });
    }

    const stem = path.replace(/\.md$/, "");
    const newPath = `${stem} 1.md`;
    const sourceContent = browserMockStorage[path]?.content || FIXTURE_NOTES[path]?.content || "";

    browserMockStorage[newPath] = {
      content: sourceContent,
      hash: "mock-hash-" + sourceContent.length + "-" + Date.now(),
      modified: Date.now(),
    };

    return {
      path: newPath,
      title: newPath.split("/").pop()?.replace(/\.md$/, "") || "Untitled",
      size_bytes: sourceContent.length,
      modified_ms: Date.now(),
      headings: [],
      tags: [],
    };
  },

  async noteDelete(path: string, permanent?: boolean): Promise<void> {
    if (isTauriEnvironment()) {
      return await invoke<void>("note_delete", { path, permanent });
    }
    delete browserMockStorage[path];
    // `.flint/templates/*.md` files are plain notes too (M10.27) but live in a separate mock
    // store (see `noteRename` above for the same distinction).
    const templatesPrefix = ".flint/templates/";
    if (path.startsWith(templatesPrefix)) {
      delete browserMockTemplates[path.slice(templatesPrefix.length)];
    }
  },

  async folderCreate(path: string): Promise<void> {
    if (isTauriEnvironment()) {
      return await invoke<void>("folder_create", { path });
    }
  },

  async folderDelete(path: string, permanent?: boolean): Promise<void> {
    if (isTauriEnvironment()) {
      return await invoke<void>("folder_delete", { path, permanent });
    }
  },

  async revealInFileManager(path: string): Promise<void> {
    if (isTauriEnvironment()) {
      return await invoke<void>("reveal_in_file_manager", { path });
    }
  },

  async noteRender(path: string, content?: string, theme?: string): Promise<RenderResult> {
    if (isTauriEnvironment()) {
      return await invoke<RenderResult>("note_render", { path, content, theme });
    }

    const rawContent = content !== undefined
      ? content
      : browserMockStorage[path]?.content || FIXTURE_NOTES[path]?.content || "";

    const html = renderMarkdownToHtml(rawContent);
    const headings: Array<{ level: number; text: string; anchor: string; line: number }> = [];
    const slugCounts = new Map<string, number>();
    const rawLines = rawContent.split('\n');
    for (let i = 0; i < rawLines.length; i++) {
      const trimmed = rawLines[i].trim();
      const match = trimmed.match(/^(#{1,6})\s+(.*)$/);
      if (match) {
        headings.push({
          level: match[1].length,
          text: match[2].trim(),
          anchor: dedupSlug(slugCounts, slugify(match[2].trim())),
          line: i,
        });
      }
    }

    return {
      html,
      headings: headings.length > 0 ? (headings as any) : FIXTURE_NOTES[path]?.headings || [],
    };
  },

  async linksOutgoing(path: string, content?: string): Promise<LinkItem[]> {
    if (isTauriEnvironment()) {
      return await invoke<LinkItem[]>("links_outgoing", { path, content });
    }

    // Mock link extraction for browser environment
    const noteContent = content !== undefined
      ? content
      : browserMockStorage[path]?.content || FIXTURE_NOTES[path]?.content || "";

    const lines = noteContent.split('\n');
    const links: LinkItem[] = [];

    lines.forEach((line, lineIdx) => {
      const regex = /\[([^\]]+)\]\(([^)]+)\)/g;
      let match;
      while ((match = regex.exec(line)) !== null) {
        const rawTarget = match[2];
        const isExternal = rawTarget.startsWith("http://") || rawTarget.startsWith("https://") || rawTarget.startsWith("mailto:");
        let resolved: string | null = null;
        if (!isExternal) {
          const cleanTarget = rawTarget.split('#')[0].replace(/^\.\//, '');
          const withExt = cleanTarget.endsWith('.md') ? cleanTarget : `${cleanTarget}.md`;
          const folder = path.split('/').slice(0, -1).join('/');
          const candidate = folder ? `${folder}/${withExt}` : withExt;
          if (browserMockStorage[candidate] || FIXTURE_NOTES[candidate]) {
            resolved = candidate;
          }
        }
        links.push({
          source: path,
          raw_target: rawTarget,
          resolved,
          line: lineIdx + 1,
          col: match.index + 1,
          context: line.trim(),
        });
      }
    });

    return links;
  },

  async linksBacklinks(path: string): Promise<BacklinkGroup[]> {
    if (isTauriEnvironment()) {
      return await invoke<BacklinkGroup[]>("links_backlinks", { path });
    }

    // Mock backlinks for browser dev
    const note = FIXTURE_NOTES[path];
    if (note && note.backlinks) {
      return note.backlinks;
    }
    return [];
  },

  async workspaceStats(): Promise<WorkspaceStats> {
    if (isTauriEnvironment()) {
      return await invoke<WorkspaceStats>("workspace_stats");
    }

    const noteCount = Object.keys(FIXTURE_NOTES).length;
    let linkCount = 0;
    let unresolvedCount = 0;
    Object.values(FIXTURE_NOTES).forEach((n) => {
      linkCount += n.outgoingLinks.length;
      unresolvedCount += n.outgoingLinks.filter((l) => !l.resolved && !l.raw_target?.startsWith('http')).length;
    });

    return {
      note_count: noteCount,
      link_count: linkCount,
      unresolved_count: unresolvedCount,
    };
  },

  async indexUnresolved(): Promise<LinkItem[]> {
    if (isTauriEnvironment()) {
      return await invoke<LinkItem[]>("index_unresolved");
    }

    const unresolved: LinkItem[] = [];
    Object.values(FIXTURE_NOTES).forEach((n) => {
      n.outgoingLinks.forEach((l) => {
        if (!l.resolved && !l.raw_target?.startsWith('http')) {
          unresolved.push(l);
        }
      });
    });
    return unresolved;
  },

  async indexNotes(): Promise<NoteMeta[]> {
    if (isTauriEnvironment()) {
      return await invoke<NoteMeta[]>("index_notes");
    }

    return Object.values(FIXTURE_NOTES).map((n) => ({
      path: n.path,
      title: n.title,
      size_bytes: n.content.length,
      modified_ms: Date.now(),
      headings: n.headings,
      tags: n.tags,
    }));
  },

  async searchNames(query: string, limit?: number): Promise<NameHit[]> {
    if (isTauriEnvironment()) {
      return await invoke<NameHit[]>("search_names", { query, limit });
    }

    const trimmed = query.trim().toLowerCase();
    const notes = Object.values(FIXTURE_NOTES);
    if (!trimmed) {
      return notes.slice(0, limit || 30).map((n) => ({
        path: n.path,
        title: n.title,
        score: 0,
        match_indices_title: [],
        match_indices_path: [],
      }));
    }

    const results: NameHit[] = [];
    notes.forEach((n) => {
      const titleLower = n.title.toLowerCase();
      const pathLower = n.path.toLowerCase();
      if (titleLower.includes(trimmed)) {
        const start = titleLower.indexOf(trimmed);
        results.push({
          path: n.path,
          title: n.title,
          score: 100 - start,
          match_indices_title: Array.from({ length: trimmed.length }, (_, i) => start + i),
          match_indices_path: [],
        });
      } else if (pathLower.includes(trimmed)) {
        const start = pathLower.indexOf(trimmed);
        results.push({
          path: n.path,
          title: n.title,
          score: 50 - start,
          match_indices_title: [],
          match_indices_path: Array.from({ length: trimmed.length }, (_, i) => start + i),
        });
      }
    });

    results.sort((a, b) => b.score - a.score);
    return results.slice(0, limit || 30);
  },

  async searchContent(query: string, options?: ContentSearchOptions): Promise<ContentHitGroup[]> {
    if (isTauriEnvironment()) {
      return await invoke<ContentHitGroup[]>("search_content", { query, options });
    }

    if (!query.trim()) return [];

    const caseSensitive = options?.case_sensitive || false;
    const wholeWord = options?.whole_word || false;
    const isRegex = options?.is_regex || false;
    const folderScope = options?.folder_scope;

    let regex: RegExp;
    try {
      if (isRegex) {
        const pat = wholeWord ? `\\b(?:${query})\\b` : query;
        regex = new RegExp(pat, caseSensitive ? "g" : "gi");
      } else {
        const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const pat = wholeWord ? `\\b${escaped}\\b` : escaped;
        regex = new RegExp(pat, caseSensitive ? "g" : "gi");
      }
    } catch (e: any) {
      throw new Error(`Invalid regex: ${e?.message || String(e)}`);
    }

    const groups: ContentHitGroup[] = [];
    Object.values(FIXTURE_NOTES).forEach((n) => {
      if (folderScope && !n.path.startsWith(folderScope)) {
        return;
      }

      const lines = n.content.split("\n");
      const hits: ContentHit[] = [];

      lines.forEach((line, lineIdx) => {
        let match: RegExpExecArray | null;
        regex.lastIndex = 0;
        while ((match = regex.exec(line)) !== null) {
          hits.push({
            line: lineIdx + 1,
            col: match.index + 1,
            match_length: match[0].length,
            line_text: line,
          });
          if (!regex.global) break;
        }
      });

      if (hits.length > 0) {
        groups.push({
          path: n.path,
          title: n.title,
          matches: hits,
        });
      }
    });

    return groups;
  },

  async workspaceDoctor(): Promise<DoctorReport> {
    if (isTauriEnvironment()) {
      return await invoke<DoctorReport>("workspace_doctor");
    }

    return {
      workspace: "projects",
      note_count: Object.keys(FIXTURE_NOTES).length,
      link_count: 12,
      broken_links: [],
      orphan_notes: [],
      unreadable_files: [],
    };
  },

  async chooseFolder(): Promise<string | null> {
    if (isTauriEnvironment()) {
      // Returns Option<String> serialised as null or the path string
      return await invoke<string | null>("choose_folder");
    }
    // In browser dev mode, return a mock path
    return "/Users/dev/notes";
  },

  async openExternal(url: string): Promise<void> {
    if (isTauriEnvironment()) {
      return await invoke<void>("open_external", { url });
    }
    window.open(url, "_blank", "noopener,noreferrer");
  },

  async recentWorkspaces(): Promise<string[]> {
    if (isTauriEnvironment()) {
      return await invoke<string[]>("recent_workspaces");
    }
    return [];
  },

  /** Fetch a single dotted-path config value (unwraps the backend's ConfigGetResult). */
  async configGet<T = unknown>(key: string): Promise<T | null> {
    if (isTauriEnvironment()) {
      const result = await invoke<ConfigGetResult>("config_get", { key });
      return (result.config as T) ?? null;
    }
    const raw = getAtPath(browserMockConfig, key);
    return raw === undefined ? null : (raw as T);
  },

  /** Fetch the full merged config plus per-path origins and any parse-failure notice. */
  async configGetAll(): Promise<ConfigGetResult> {
    if (isTauriEnvironment()) {
      return await invoke<ConfigGetResult>("config_get", { key: null });
    }
    return {
      config: JSON.parse(JSON.stringify(browserMockConfig)),
      origins: { ...browserMockOrigins },
      notice: null,
    };
  },

  async configSet(key: string, value: unknown): Promise<void> {
    if (isTauriEnvironment()) {
      return await invoke<void>("config_set", { key, value });
    }
    setAtPath(browserMockConfig as unknown as Record<string, unknown>, key, value);
    browserMockOrigins[key] = "workspace";
  },

  async configReset(key: string): Promise<void> {
    if (isTauriEnvironment()) {
      return await invoke<void>("config_reset", { key });
    }
    const defaultValue = getAtPath(DEFAULT_CONFIG, key);
    if (defaultValue === undefined) {
      deleteAtPath(browserMockConfig as unknown as Record<string, unknown>, key);
    } else {
      setAtPath(browserMockConfig as unknown as Record<string, unknown>, key, JSON.parse(JSON.stringify(defaultValue)));
    }
    delete browserMockOrigins[key];
  },

  async configValidateIgnore(patterns: string[]): Promise<(string | null)[]> {
    if (isTauriEnvironment()) {
      return await invoke<(string | null)[]>("config_validate_ignore", { patterns });
    }
    // Dev-mode fallback: a simple glob-syntax sanity check, not a full validator.
    return patterns.map((pattern) => {
      const trimmed = pattern.trim();
      if (!trimmed) return null;
      const openBrackets = (trimmed.match(/\[/g) || []).length;
      const closeBrackets = (trimmed.match(/\]/g) || []).length;
      if (openBrackets !== closeBrackets) {
        return "Unbalanced [ ] in glob pattern";
      }
      if (trimmed.includes("\0")) {
        return "Pattern contains a NUL byte";
      }
      return null;
    });
  },

  /** Query the local MCP server's lifecycle state (M10.21). Off outside Tauri (browser dev). */
  async mcpStatus(): Promise<McpStatus> {
    if (isTauriEnvironment()) {
      return await invoke<McpStatus>("mcp_status");
    }
    return { state: "off", requiresAuth: false, hasToken: false };
  },

  /**
   * Generate (or, if one already exists, rotate) the MCP server's bearer token without
   * restarting Flint (M10.21) — the only way a token is ever created; persisted so it survives
   * restarts.
   */
  async mcpRotateToken(): Promise<string> {
    if (isTauriEnvironment()) {
      return await invoke<string>("mcp_rotate_token");
    }
    throw new Error("MCP server is not available outside the desktop app");
  },

  /** Read the currently-generated MCP token (if any) without rotating it, so Settings can
   * redisplay it (e.g. after reopening the panel) without invalidating a client's config. */
  async mcpGetToken(): Promise<string | null> {
    if (isTauriEnvironment()) {
      return await invoke<string | null>("mcp_get_token");
    }
    return null;
  },
};


