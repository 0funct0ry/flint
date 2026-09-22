import { invoke } from "@tauri-apps/api/core";
import { Fingerprint, NoteContent, TreeNodeItem, WorkspaceInfo } from "../types";
import { FIXTURE_NOTES } from "../fixtures/workspace";

export const isTauriEnvironment = (): boolean => {
  return typeof window !== "undefined" && Boolean((window as any).__TAURI_INTERNALS__);
};

// Fallback in-memory storage for browser dev/test
const browserMockStorage: Record<string, { content: string; hash: string; modified: number }> = {};

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
    return [
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
};

