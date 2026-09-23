import { invoke } from "@tauri-apps/api/core";
import {
  BacklinkGroup,
  Fingerprint,
  LinkItem,
  NoteContent,
  NoteMeta,
  RenameResult,
  RenderResult,
  TreeNodeItem,
  WorkspaceInfo,
  WorkspaceStats,
} from "../types";
import { FIXTURE_NOTES } from "../fixtures/workspace";
import { renderMarkdownToHtml } from "./markdown";

export const isTauriEnvironment = (): boolean => {
  return typeof window !== "undefined" && Boolean((window as any).__TAURI_INTERNALS__);
};

// Fallback in-memory storage for browser dev/test
const browserMockStorage: Record<string, { content: string; hash: string; modified: number }> = {};
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
      headings: [{ level: 1, text: path.split("/").pop()?.replace(/\.md$/, "") || "Untitled", anchor: "title" }],
      outgoingLinks: [],
      backlinks: [],
      renderedHtml: `<p>Note content...</p>`,
      lastModifiedAgo: "just now",
    };

    const stored = browserMockStorage[path];
    const content = stored ? stored.content : fixture.content;
    const hash = stored ? stored.hash : "mock-hash-" + content.length;
    const modified = stored ? stored.modified : Date.now();

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
      front_matter_raw: fixture.frontMatter ? JSON.stringify(fixture.frontMatter) : null,
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

  async noteCreate(path: string, template?: string): Promise<NoteMeta> {
    if (isTauriEnvironment()) {
      return await invoke<NoteMeta>("note_create", { path, template });
    }

    const content = template || "";
    browserMockStorage[path] = {
      content,
      hash: "mock-hash-" + content.length + "-" + Date.now(),
      modified: Date.now(),
    };

    const title = path.split("/").pop()?.replace(/\.md$/, "") || "Untitled";
    return {
      path,
      title,
      size_bytes: content.length,
      modified_ms: Date.now(),
      headings: [],
      tags: [],
    };
  },

  async noteRename(from: string, to: string, rewriteLinks?: boolean): Promise<RenameResult> {
    if (isTauriEnvironment()) {
      return await invoke<RenameResult>("note_rename", { from, to, rewriteLinks });
    }

    if (browserMockStorage[from]) {
      browserMockStorage[to] = browserMockStorage[from];
      delete browserMockStorage[from];
    }

    return {
      moved: true,
      links_updated: 0,
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
    const headings = FIXTURE_NOTES[path]?.headings || [];

    return {
      html,
      headings,
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

  async openExternal(url: string): Promise<void> {
    if (isTauriEnvironment()) {
      return await invoke<void>("open_external", { url });
    }
    window.open(url, "_blank", "noopener,noreferrer");
  },
};


