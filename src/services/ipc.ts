import { invoke } from "@tauri-apps/api/core";
import { TreeNodeItem, WorkspaceInfo } from "../types";

export const isTauriEnvironment = (): boolean => {
  return typeof window !== "undefined" && Boolean((window as any).__TAURI_INTERNALS__);
};

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
};
