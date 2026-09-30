import type { Command } from './registry';

/**
 * Static metadata for every command App.tsx registers into `commandRegistry`, minus the
 * handler (which needs live component state/closures). This is the single source of truth
 * for the app's keyboard shortcuts — `docs/scripts/generate-shortcuts.mjs` reads this file
 * directly to generate the Keyboard Shortcuts reference page, so it can never drift from
 * what App.tsx actually registers.
 */
export type CommandMetadata = Omit<Command, 'handler'>;

export const APP_COMMANDS: CommandMetadata[] = [
  { id: 'file.new_note', title: 'New note', shortcut: '⌘N', shortcutDisplay: '⌘N' },
  { id: 'file.new_folder', title: 'New folder', shortcut: '⌘⇧N', shortcutDisplay: '⌘⇧N' },
  // M10.27 Journey A: author a template without leaving Flint.
  { id: 'file.new_template', title: 'New template…' },
  { id: 'view.manage_templates', title: 'Manage templates…' },
  { id: 'file.close', title: 'Close active note', shortcut: '⌘W', shortcutDisplay: '⌘W' },
  { id: 'palette.notes', title: 'Search notes by name', shortcut: '⌘P', shortcutDisplay: '⌘P' },
  { id: 'palette.commands', title: 'Show all commands', shortcut: '⌘⇧P', shortcutDisplay: '⌘⇧P' },
  { id: 'search.content', title: 'Search content in workspace', shortcut: '⌘⇧F', shortcutDisplay: '⌘⇧F' },
  { id: 'file.save', title: 'Save note now', shortcut: '⌘S', shortcutDisplay: '⌘S' },
  { id: 'view.cycle_mode', title: 'Cycle view mode (edit / read / split)', shortcut: '⌘E', shortcutDisplay: '⌘E' },
  { id: 'view.toggle_left_sidebar', title: 'Toggle left sidebar', shortcut: '⌘B', shortcutDisplay: '⌘B' },
  { id: 'view.toggle_right_sidebar', title: 'Toggle right sidebar', shortcut: '⌘⌥B', shortcutDisplay: '⌘⌥B' },
  { id: 'theme.toggle', title: 'Toggle light / dark theme' },
  { id: 'view.open_settings', title: 'Settings', shortcut: '⌘,', shortcutDisplay: '⌘,' },
  // Daily notes (M10.26) — only registered while `dailyNotes.enabled` is on; see App.tsx.
  { id: 'daily.today', title: 'Daily note: Today' },
  { id: 'daily.yesterday', title: 'Daily note: Yesterday' },
  { id: 'daily.tomorrow', title: 'Daily note: Tomorrow' },
  { id: 'daily.pick_date', title: 'Daily note: Pick a date…' },
];
