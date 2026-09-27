/**
 * Bridge for the M10.09 outline panel: reorder, copy-section, move-to-new-note, and delete all
 * need to dispatch a single transaction into the currently mounted `EditorView` from outside
 * `CenterPane`. `CenterPane` registers the dispatcher on mount and clears it on unmount; the
 * outline panel (`LeftSidebar`) only ever calls `applyOutlineEdit`.
 */
type OutlineEditDispatcher = (changes: { from: number; to: number; insert: string }[]) => void;

let dispatcher: OutlineEditDispatcher | null = null;

export function setOutlineEditDispatcher(next: OutlineEditDispatcher | null): void {
  dispatcher = next;
}

/** Dispatch one or more changes as a single CodeMirror transaction (one undo step) into the
 *  currently mounted editor, if any. Used by the outline panel (M10.09) via `LeftSidebar`. */
export function applyOutlineEdit(changes: { from: number; to: number; insert: string }[]): void {
  dispatcher?.(changes);
}
