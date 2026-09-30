import { FrontMatterField } from '../types';

/**
 * Browser-mock mirror of `flint_core::parse_front_matter` / `set_front_matter_fields`
 * (crates/flint-core/src/lib.rs) used only when there is no Tauri backend to ask. It exists so
 * the dev-preview / test mocks derive front-matter fields from the note's actual content on
 * every read, the same way the real backend does, instead of caching a separate field list that
 * can drift from a manually edited buffer.
 */

interface ParsedFrontMatter {
  raw: string | null;
  body: string;
  fields: FrontMatterField[];
}

export function parseFrontMatter(content: string): ParsedFrontMatter {
  const withoutFence = content.startsWith('---\n')
    ? content.slice(4)
    : content.startsWith('---\r\n')
    ? content.slice(5)
    : null;

  if (withoutFence === null) {
    return { raw: null, body: content, fields: [] };
  }

  const endMatch = withoutFence.match(/\r?\n---/);
  if (!endMatch || endMatch.index === undefined) {
    return { raw: null, body: content, fields: [] };
  }

  const raw = withoutFence.slice(0, endMatch.index);
  const afterEnd = withoutFence.slice(endMatch.index);
  const body = afterEnd.replace(/^\r?\n---\r?\n?/, '');

  const fields: FrontMatterField[] = [];
  let blockListIndex: number | null = null;

  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;

    const leadingWs = line.length - line.trimStart().length;
    const colonIdx = line.indexOf(':');
    if (colonIdx !== -1 && leadingWs === 0) {
      const key = line.slice(0, colonIdx).trim();
      const value = line.slice(colonIdx + 1).trim();
      if (value === '') {
        fields.push([key, '']);
        blockListIndex = fields.length - 1;
      } else {
        fields.push([key, value]);
        blockListIndex = null;
      }
      continue;
    }
    if (blockListIndex !== null && trimmed.startsWith('- ')) {
      const item = `- ${trimmed.slice(2).trim()}`;
      const existing = fields[blockListIndex][1];
      fields[blockListIndex][1] = existing === '' ? item : `${existing}\n${item}`;
      continue;
    }
    blockListIndex = null;
  }

  return { raw, body, fields };
}

/** Rebuild note content with an updated ordered set of front-matter fields, mirroring
 *  `flint_core::set_front_matter_fields`: the body is left untouched, and a note with no
 *  front matter yet gets a new `---` block inserted at byte 0. */
export function setFrontMatterFields(content: string, fields: FrontMatterField[]): string {
  const { body } = parseFrontMatter(content);

  if (fields.length === 0) {
    return body;
  }

  let fm = '---\n';
  for (const [key, value] of fields) {
    fm += `${key}:`;
    if (value === '') {
      fm += '\n';
    } else if (value.startsWith('- ') || value.includes('\n- ')) {
      fm += '\n';
      for (const line of value.split('\n')) {
        fm += `${line}\n`;
      }
    } else {
      fm += ` ${value}\n`;
    }
  }
  fm += '---\n';

  return fm + body;
}

/** Replace a note's body while leaving its front-matter block (if any) byte-for-byte unchanged —
 *  mirrors `flint_core::set_note_body`, the inverse counterpart of `setFrontMatterFields` above. */
export function setBody(content: string, newBody: string): string {
  const { raw } = parseFrontMatter(content);
  if (raw === null) return newBody;
  return `---\n${raw}\n---\n${newBody}`;
}
