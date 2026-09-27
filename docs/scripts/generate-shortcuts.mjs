#!/usr/bin/env node
// Generates docs/src/content/docs/docs/keyboard-shortcuts.md from the app's own command
// registry (src/commands/appCommands.ts), so the reference page can never drift from the
// actual keybindings. Do not hand-edit the generated file — edit appCommands.ts instead.

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SOURCE = path.resolve(__dirname, '../../src/commands/appCommands.ts');
const OUTPUT = path.resolve(__dirname, '../src/content/docs/docs/keyboard-shortcuts.mdx');

const source = readFileSync(SOURCE, 'utf8');

// appCommands.ts is a plain array of object literals with string fields only (see that file's
// own comment for why); pulling the fields out with a regex avoids needing a TypeScript
// compile step just to read static data in this build script.
const entryPattern = /\{\s*id:\s*'([^']+)'\s*,\s*title:\s*'([^']+)'(?:\s*,\s*shortcut:\s*'[^']*')?(?:\s*,\s*shortcutDisplay:\s*'([^']*)')?\s*,?\s*\}/g;

const rows = [];
for (const match of source.matchAll(entryPattern)) {
  const [, id, title, shortcutDisplay] = match;
  rows.push({ id, title, shortcutDisplay: shortcutDisplay ?? '' });
}

if (rows.length === 0) {
  throw new Error(`generate-shortcuts: found no commands in ${SOURCE} — regex out of sync?`);
}

const withShortcuts = rows.filter((r) => r.shortcutDisplay);

const tableRows = withShortcuts
  .map((r) => `| ${r.title} | \`${r.shortcutDisplay}\` | \`${r.id}\` |`)
  .join('\n');

const body = `---
title: Keyboard Shortcuts
description: Every keyboard shortcut Flint registers, generated from the app's command registry.
---

import { Aside } from '@astrojs/starlight/components';

<Aside type="note">
This page is generated at build time from \`src/commands/appCommands.ts\` — the same command
registry the app uses at runtime — by \`docs/scripts/generate-shortcuts.mjs\`. Edit that file, not
this one; changes here are overwritten on the next build.
</Aside>

| Command | Shortcut | ID |
| --- | --- | --- |
${tableRows}

Commands with no keyboard shortcut (available only via the command palette, \`⌘⇧P\`):

${rows
  .filter((r) => !r.shortcutDisplay)
  .map((r) => `- ${r.title} (\`${r.id}\`)`)
  .join('\n')}
`;

writeFileSync(OUTPUT, body, 'utf8');
console.log(`generate-shortcuts: wrote ${withShortcuts.length} shortcuts to ${path.relative(process.cwd(), OUTPUT)}`);
