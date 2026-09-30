import { EditorView } from '@codemirror/view';
import { EditorState } from '@codemirror/state';
import * as ec from '../commands/editorCommands';
import { ContextMenuItem } from '../components/ContextMenu';

/**
 * Bridge from the module-level `EDITOR_COMMANDS` table (shared across every CodeMirror instance
 * in the app — the main note editor and the Templates screen's body editor) into whichever
 * instance is currently mounted and wants Table Builder support. Only one instance is ever
 * mounted at a time in this app (the Templates screen replaces the note editor entirely rather
 * than sitting alongside it), so this single slot is safe — set on mount, cleared on unmount, via
 * `setOpenTableBuilder`.
 */
let openTableBuilder: ((view: EditorView) => void) | null = null;

export function setOpenTableBuilder(fn: ((view: EditorView) => void) | null): void {
  openTableBuilder = fn;
}

export interface EditorCommandDef {
  id: string;
  title: string;
  /** CodeMirror keymap key string, e.g. `'Mod-b'`. Omit when an existing default binding
   *  (e.g. Select All's Mod-a from `defaultKeymap`) already covers it. */
  key?: string;
  shortcutDisplay: string;
  section: 'insert' | 'format' | 'paragraph' | 'link' | 'clipboard';
  run: ec.EditorCommand;
  isEnabled?: (state: EditorState) => boolean;
}

/**
 * Every Insert/Format/Paragraph/link/clipboard action, defined once and shared across the command
 * palette, every CodeMirror instance's keymap, and every CodeMirror instance's context menu
 * (M10.05, SPEC §9.3; shared with the Templates screen's body editor as of the M10.27 follow-up —
 * a template body is still Markdown, and should get the exact same editing affordances a note
 * does, not a stripped-down substitute).
 */
export const EDITOR_COMMANDS: EditorCommandDef[] = [
  // Insert — always available.
  { id: 'editor.insert_footnote', title: 'Footnote', key: 'Mod-Alt-f', shortcutDisplay: '⌘⌥F', section: 'insert', run: ec.insertFootnote },
  { id: 'editor.insert_table', title: 'Table', key: 'Mod-Alt-t', shortcutDisplay: '⌘⌥T', section: 'insert', run: ec.insertTable },
  { id: 'editor.insert_table_builder', title: 'Table Builder', key: 'Mod-Alt-Shift-t', shortcutDisplay: '⌘⌥⇧T', section: 'insert', run: (view) => { openTableBuilder?.(view); return true; } },
  { id: 'editor.insert_callout', title: 'Callout', key: 'Mod-Alt-q', shortcutDisplay: '⌘⌥Q', section: 'insert', run: ec.insertCallout() },
  { id: 'editor.insert_hr', title: 'Horizontal Rule', key: 'Mod-Alt-h', shortcutDisplay: '⌘⌥H', section: 'insert', run: ec.insertHorizontalRule },
  { id: 'editor.insert_code_block', title: 'Code Block', key: 'Mod-Alt-c', shortcutDisplay: '⌘⌥C', section: 'insert', run: ec.insertCodeBlock },
  { id: 'editor.insert_math_block', title: 'Math Block', key: 'Mod-Alt-m', shortcutDisplay: '⌘⌥M', section: 'insert', run: ec.insertMathBlock },

  // Format — enabled only with a non-empty selection.
  { id: 'editor.format_bold', title: 'Bold', key: 'Mod-b', shortcutDisplay: '⌘B', section: 'format', run: ec.formatBold, isEnabled: ec.isFormatEnabled },
  { id: 'editor.format_italic', title: 'Italic', key: 'Mod-i', shortcutDisplay: '⌘I', section: 'format', run: ec.formatItalic, isEnabled: ec.isFormatEnabled },
  { id: 'editor.format_strikethrough', title: 'Strikethrough', key: 'Mod-Shift-x', shortcutDisplay: '⌘⇧X', section: 'format', run: ec.formatStrikethrough, isEnabled: ec.isFormatEnabled },
  { id: 'editor.format_inline_code', title: 'Inline Code', key: 'Mod-Shift-c', shortcutDisplay: '⌘⇧C', section: 'format', run: ec.formatInlineCode, isEnabled: ec.isFormatEnabled },
  { id: 'editor.format_comment', title: 'Comment', key: 'Mod-/', shortcutDisplay: '⌘/', section: 'format', run: ec.formatComment, isEnabled: ec.isFormatEnabled },

  // Paragraph — enabled only when the cursor/selection is inside a block-level element.
  { id: 'editor.paragraph_bullet_list', title: 'Bullet List', key: 'Mod-Shift-8', shortcutDisplay: '⌘⇧8', section: 'paragraph', run: ec.paragraphBulletList, isEnabled: ec.isParagraphEnabled },
  { id: 'editor.paragraph_numbered_list', title: 'Numbered List', key: 'Mod-Shift-7', shortcutDisplay: '⌘⇧7', section: 'paragraph', run: ec.paragraphNumberedList, isEnabled: ec.isParagraphEnabled },
  { id: 'editor.paragraph_task_list', title: 'Task List', key: 'Mod-Shift-9', shortcutDisplay: '⌘⇧9', section: 'paragraph', run: ec.paragraphTaskList, isEnabled: ec.isParagraphEnabled },
  { id: 'editor.paragraph_h1', title: 'Heading 1', key: 'Mod-Alt-1', shortcutDisplay: '⌘⌥1', section: 'paragraph', run: ec.paragraphHeading(1), isEnabled: ec.isParagraphEnabled },
  { id: 'editor.paragraph_h2', title: 'Heading 2', key: 'Mod-Alt-2', shortcutDisplay: '⌘⌥2', section: 'paragraph', run: ec.paragraphHeading(2), isEnabled: ec.isParagraphEnabled },
  { id: 'editor.paragraph_h3', title: 'Heading 3', key: 'Mod-Alt-3', shortcutDisplay: '⌘⌥3', section: 'paragraph', run: ec.paragraphHeading(3), isEnabled: ec.isParagraphEnabled },
  { id: 'editor.paragraph_h4', title: 'Heading 4', key: 'Mod-Alt-4', shortcutDisplay: '⌘⌥4', section: 'paragraph', run: ec.paragraphHeading(4), isEnabled: ec.isParagraphEnabled },
  { id: 'editor.paragraph_h5', title: 'Heading 5', key: 'Mod-Alt-5', shortcutDisplay: '⌘⌥5', section: 'paragraph', run: ec.paragraphHeading(5), isEnabled: ec.isParagraphEnabled },
  { id: 'editor.paragraph_h6', title: 'Heading 6', key: 'Mod-Alt-6', shortcutDisplay: '⌘⌥6', section: 'paragraph', run: ec.paragraphHeading(6), isEnabled: ec.isParagraphEnabled },
  { id: 'editor.paragraph_body', title: 'Body', key: 'Mod-Alt-0', shortcutDisplay: '⌘⌥0', section: 'paragraph', run: ec.paragraphBody, isEnabled: ec.isParagraphEnabled },
  { id: 'editor.paragraph_quote', title: 'Quote', key: 'Mod-Shift-.', shortcutDisplay: '⌘⇧.', section: 'paragraph', run: ec.paragraphQuote, isEnabled: ec.isParagraphEnabled },

  // Links — the first reuses the M6 note-path autocomplete flow, the second is a bare skeleton.
  { id: 'editor.insert_link', title: 'Add a link', key: 'Mod-Shift-k', shortcutDisplay: '⌘⇧K', section: 'link', run: ec.insertLinkWithAutocomplete },
  { id: 'editor.insert_external_link', title: 'Add external link', key: 'Mod-k', shortcutDisplay: '⌘K', section: 'link', run: ec.insertExternalLink },

  // Clipboard — via the Tauri clipboard API (SPEC §10.2 CSP), not `navigator.clipboard`.
  { id: 'editor.cut', title: 'Cut', key: 'Mod-x', shortcutDisplay: '⌘X', section: 'clipboard', run: ec.clipboardCut, isEnabled: ec.isClipboardCutCopyEnabled },
  { id: 'editor.copy', title: 'Copy', key: 'Mod-c', shortcutDisplay: '⌘C', section: 'clipboard', run: ec.clipboardCopy, isEnabled: ec.isClipboardCutCopyEnabled },
  { id: 'editor.paste', title: 'Paste', key: 'Mod-v', shortcutDisplay: '⌘V', section: 'clipboard', run: ec.clipboardPaste },
  // Select All already has its default keybinding (Mod-a) via `defaultKeymap`; listed here so
  // it also gets a palette entry and a context-menu entry per SPEC §9.3.
  { id: 'editor.select_all', title: 'Select all', shortcutDisplay: '⌘A', section: 'clipboard', run: ec.selectAllCommand },
];

/** Build the exact same Insert/Format/Paragraph/link/Cut-Copy-Paste context menu the main note
 * editor uses, for a given live `EditorView` — shared so every CodeMirror instance in the app
 * presents identical editing affordances. */
export function buildEditorContextMenuItems(view: EditorView): ContextMenuItem[] {
  const { state } = view;

  const sep = (id: string): ContextMenuItem => ({ id, label: '', separator: true, onClick: () => {} });

  const toItem = (cmd: EditorCommandDef): ContextMenuItem => {
    const enabled = cmd.isEnabled ? cmd.isEnabled(state) : true;
    return {
      id: cmd.id,
      label: cmd.title,
      shortcut: cmd.shortcutDisplay,
      disabled: !enabled,
      disabledReason: !enabled
        ? cmd.section === 'format' || cmd.section === 'clipboard'
          ? 'Select some text first'
          : cmd.section === 'paragraph'
          ? 'Place the cursor in a paragraph, list, or heading first'
          : undefined
        : undefined,
      onClick: () => {
        view.focus();
        cmd.run(view);
      },
    };
  };

  const byIds = (...ids: string[]) =>
    ids
      .map((id) => EDITOR_COMMANDS.find((c) => c.id === id))
      .filter((c): c is EditorCommandDef => !!c)
      .map(toItem);

  const formatSubmenu: ContextMenuItem[] = [
    ...byIds('editor.format_bold', 'editor.format_italic', 'editor.format_strikethrough', 'editor.format_inline_code'),
    sep('format-sep-1'),
    ...byIds('editor.format_comment'),
  ];

  const paragraphSubmenu: ContextMenuItem[] = [
    ...byIds('editor.paragraph_bullet_list', 'editor.paragraph_numbered_list', 'editor.paragraph_task_list'),
    sep('paragraph-sep-1'),
    ...byIds(
      'editor.paragraph_h1',
      'editor.paragraph_h2',
      'editor.paragraph_h3',
      'editor.paragraph_h4',
      'editor.paragraph_h5',
      'editor.paragraph_h6',
      'editor.paragraph_body',
      'editor.paragraph_quote'
    ),
  ];

  const insertSubmenu: ContextMenuItem[] = [
    ...byIds('editor.insert_footnote', 'editor.insert_table', 'editor.insert_table_builder', 'editor.insert_callout', 'editor.insert_hr'),
    sep('insert-sep-1'),
    ...byIds('editor.insert_code_block', 'editor.insert_math_block'),
  ];

  return [
    ...byIds('editor.insert_link', 'editor.insert_external_link'),
    sep('sep-1'),
    { id: 'group-format', label: 'Format', submenu: formatSubmenu, onClick: () => {} },
    { id: 'group-paragraph', label: 'Paragraph', submenu: paragraphSubmenu, onClick: () => {} },
    { id: 'group-insert', label: 'Insert', submenu: insertSubmenu, onClick: () => {} },
    sep('sep-2'),
    ...byIds('editor.cut', 'editor.copy', 'editor.paste', 'editor.select_all'),
  ];
}

/** The formatting keymap every CodeMirror instance in the app installs at `Prec.high`, derived
 * from `EDITOR_COMMANDS`' `key` entries — kept here so a new instance never drifts from the main
 * note editor's bindings. */
export function buildFormattingKeymap(): Array<{ key: string; run: ec.EditorCommand }> {
  return EDITOR_COMMANDS.filter((cmd): cmd is EditorCommandDef & { key: string } => !!cmd.key).map((cmd) => ({
    key: cmd.key,
    run: cmd.run,
  }));
}
