/**
 * Render Markdown content to HTML for reader pane preview.
 * Strips front matter and converts standard Markdown elements:
 * headings, blockquotes, code blocks, inline code, bold, italic,
 * math ($...$ and $$...$$), task lists, unordered/ordered lists, tables, links, and paragraphs.
 */
export function renderMarkdownToHtml(markdown: string): string {
  if (!markdown) return '';

  // 1. Strip YAML front matter if present at byte 0
  let content = markdown;
  if (content.startsWith('---\n') || content.startsWith('---\r\n')) {
    const endIdx = content.indexOf('\n---', 3);
    const endIdxCrlf = content.indexOf('\r\n---', 3);
    if (endIdx !== -1) {
      const rest = content.slice(endIdx + 4);
      content = rest.startsWith('\n') ? rest.slice(1) : rest.startsWith('\r\n') ? rest.slice(2) : rest;
    } else if (endIdxCrlf !== -1) {
      const rest = content.slice(endIdxCrlf + 5);
      content = rest.startsWith('\n') ? rest.slice(1) : rest.startsWith('\r\n') ? rest.slice(2) : rest;
    }
  }

  // 2. Protect code fences and inline code spans first so math within code is preserved
  const codeSpans: Array<{ placeholder: string; raw: string }> = [];

  // Protect code fences ```...``` or ~~~...~~~
  content = content.replace(/(```[\s\S]*?```|~~~[\s\S]*?~~~)/g, (match) => {
    const placeholder = `FLINTCODEFENCEPLACEHOLDER${codeSpans.length}`;
    codeSpans.push({ placeholder, raw: match });
    return placeholder;
  });

  // Protect inline code spans `...`
  content = content.replace(/(`+)([\s\S]*?)\1/g, (match) => {
    const placeholder = `FLINTINLINECODEPLACEHOLDER${codeSpans.length}`;
    codeSpans.push({ placeholder, raw: match });
    return placeholder;
  });

  // 3. Extract math delimiters $$...$$ and $...$
  const mathSpans: Array<{ placeholder: string; content: string; isBlock: boolean }> = [];

  // Protect block math $$...$$
  content = content.replace(/\$\$([\s\S]*?)\$\$/g, (_, math) => {
    const placeholder = `FLINTMATHBLOCKPLACEHOLDER${mathSpans.length}`;
    mathSpans.push({ placeholder, content: math.trim(), isBlock: true });
    return `\n\n${placeholder}\n\n`;
  });

  // Protect inline math $...$ (not preceded or followed by space/newlines, ignoring escaped \$)
  content = content.replace(/(?<!\\)\$([^\s$](?:[^$\n]*?[^\s$])?)\$/g, (_, math) => {
    const placeholder = `FLINTMATHINLINEPLACEHOLDER${mathSpans.length}`;
    mathSpans.push({ placeholder, content: math, isBlock: false });
    return placeholder;
  });

  // Restore protected code fences and inline code spans back to markdown content
  for (const span of codeSpans) {
    content = content.split(span.placeholder).join(span.raw);
  }

  const lines = content.split(/\r?\n/);
  const htmlOutput: string[] = [];

  let inCodeBlock = false;
  let codeBlockLang = '';
  let codeBlockContent: string[] = [];

  let inList: 'ul' | 'ol' | null = null;
  let inTable = false;
  let paragraphBuffer: string[] = [];
  const slugCounts = new Map<string, number>();

  function flushParagraph() {
    if (paragraphBuffer.length > 0) {
      const pText = paragraphBuffer.join(' ').trim();
      if (pText) {
        if (pText.startsWith('FLINTMATHBLOCKPLACEHOLDER')) {
          htmlOutput.push(pText);
        } else {
          htmlOutput.push(`<p>${formatInline(pText)}</p>`);
        }
      }
      paragraphBuffer = [];
    }
  }

  function flushList() {
    if (inList) {
      htmlOutput.push(`</${inList}>`);
      inList = null;
    }
  }

  function flushTable() {
    if (inTable) {
      htmlOutput.push(`</tbody></table></div>`);
      inTable = false;
    }
  }

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i];
    const trimmed = rawLine.trim();

    // Check for direct block math placeholder
    if (trimmed.startsWith('FLINTMATHBLOCKPLACEHOLDER')) {
      flushParagraph();
      flushList();
      flushTable();
      htmlOutput.push(trimmed);
      continue;
    }

    // Code blocks
    if (trimmed.startsWith('```') || trimmed.startsWith('~~~')) {
      if (inCodeBlock) {
        // End code block
        htmlOutput.push(
          `<pre><code class="language-${escapeHtml(codeBlockLang)}">${escapeHtml(
            codeBlockContent.join('\n')
          )}</code></pre>`
        );
        inCodeBlock = false;
        codeBlockLang = '';
        codeBlockContent = [];
      } else {
        flushParagraph();
        flushList();
        flushTable();
        inCodeBlock = true;
        codeBlockLang = trimmed.slice(3).trim();
        codeBlockContent = [];
      }
      continue;
    }

    if (inCodeBlock) {
      codeBlockContent.push(rawLine);
      continue;
    }

    // Blank line
    if (!trimmed) {
      flushParagraph();
      flushList();
      flushTable();
      continue;
    }

    // Headings: #, ##, ###, ####, #####, ######
    const headingMatch = trimmed.match(/^(#{1,6})\s+(.*)$/);
    if (headingMatch) {
      flushParagraph();
      flushList();
      flushTable();
      const level = headingMatch[1].length;
      const hText = headingMatch[2].trim();
      const anchor = dedupSlug(slugCounts, slugify(hText));
      htmlOutput.push(`<h${level} id="${anchor}">${formatInline(hText)}</h${level}>`);
      continue;
    }

    // Blockquote: > text
    if (trimmed.startsWith('>')) {
      flushParagraph();
      flushList();
      flushTable();
      const bqText = trimmed.replace(/^>\s*/, '');
      htmlOutput.push(`<blockquote><p>${formatInline(bqText)}</p></blockquote>`);
      continue;
    }

    // Tables: | Col 1 | Col 2 |
    if (trimmed.startsWith('|') && trimmed.endsWith('|')) {
      flushParagraph();
      flushList();

      const cells = trimmed
        .slice(1, -1)
        .split('|')
        .map((c) => c.trim());

      // Check if separator line (e.g. |---|---|)
      const isSeparator = cells.every((c) => /^:?-+:?$/.test(c));
      if (isSeparator) {
        continue;
      }

      if (!inTable) {
        inTable = true;
        htmlOutput.push(`<div style="overflow-x:auto"><table><thead><tr>`);
        cells.forEach((cell) => {
          htmlOutput.push(`<th>${formatInline(cell)}</th>`);
        });
        htmlOutput.push(`</tr></thead><tbody>`);
      } else {
        htmlOutput.push(`<tr>`);
        cells.forEach((cell) => {
          htmlOutput.push(`<td>${formatInline(cell)}</td>`);
        });
        htmlOutput.push(`</tr>`);
      }
      continue;
    } else {
      flushTable();
    }

    // Task list / Unordered list items: - [ ] or - [x] or - item / * item
    const taskMatch = trimmed.match(/^[-*+]\s+\[([ xX])\]\s+(.*)$/);
    if (taskMatch) {
      flushParagraph();
      flushTable();
      if (inList !== 'ul') {
        flushList();
        htmlOutput.push(`<ul>`);
        inList = 'ul';
      }
      const isChecked = taskMatch[1].toLowerCase() === 'x';
      const itemText = taskMatch[2];
      htmlOutput.push(
        `<li class="task-list-item"><input type="checkbox" disabled ${
          isChecked ? 'checked' : ''
        } style="margin-right:6px;" />${formatInline(itemText)}</li>`
      );
      continue;
    }

    const ulMatch = trimmed.match(/^[-*+]\s+(.*)$/);
    if (ulMatch) {
      flushParagraph();
      flushTable();
      if (inList !== 'ul') {
        flushList();
        htmlOutput.push(`<ul>`);
        inList = 'ul';
      }
      htmlOutput.push(`<li>${formatInline(ulMatch[1])}</li>`);
      continue;
    }

    // Ordered list: 1. item
    const olMatch = trimmed.match(/^\d+\.\s+(.*)$/);
    if (olMatch) {
      flushParagraph();
      flushTable();
      if (inList !== 'ol') {
        flushList();
        htmlOutput.push(`<ol>`);
        inList = 'ol';
      }
      htmlOutput.push(`<li>${formatInline(olMatch[1])}</li>`);
      continue;
    }

    // Horizontal Rule: --- or *** or ___ (at least 3 characters, optional whitespace)
    if (/^(?:[-*_]\s*){3,}$/.test(trimmed)) {
      flushParagraph();
      flushList();
      flushTable();
      htmlOutput.push('<hr />');
      continue;
    }

    // Normal paragraph text
    flushList();
    flushTable();
    paragraphBuffer.push(trimmed);
  }

  flushParagraph();
  flushList();
  flushTable();

  if (inCodeBlock) {
    htmlOutput.push(
      `<pre><code class="language-${escapeHtml(codeBlockLang)}">${escapeHtml(
        codeBlockContent.join('\n')
      )}</code></pre>`
    );
  }

  let finalHtml = htmlOutput.join('\n');

  // Restore math spans
  for (const span of mathSpans) {
    const replacement = span.isBlock
      ? `<div class="flint-math-block" data-math="${escapeHtml(span.content)}"></div>`
      : `<span class="flint-math-inline" data-math="${escapeHtml(span.content)}"></span>`;
    finalHtml = finalHtml.split(span.placeholder).join(replacement);
  }

  return finalHtml;
}

export function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

export function slugify(text: string): string {
  return text
    .toLowerCase()
    .split('')
    .map((ch) => (/[a-z0-9]/.test(ch) ? ch : '-'))
    .join('')
    .split('-')
    .filter((s) => s.length > 0)
    .join('-');
}

/** Disambiguate a slug against slugs already seen in the same note, appending -2, -3, ... on repeats. */
export function dedupSlug(seen: Map<string, number>, baseSlug: string): string {
  const count = (seen.get(baseSlug) || 0) + 1;
  seen.set(baseSlug, count);
  return count === 1 ? baseSlug : `${baseSlug}-${count}`;
}

function formatInline(text: string): string {
  // First escape raw HTML to prevent XSS holes
  const escaped = escapeHtml(text);

  // 1. Inline code: `code`
  let formatted = escaped.replace(/`([^`]+)`/g, (_, code) => `<code>${code}</code>`);

  // 2. Bold & Italic: ***text***
  formatted = formatted.replace(/\*\*\*([^*]+)\*\*\*/g, '<strong><em>$1</em></strong>');

  // 3. Bold: **text** or __text__
  formatted = formatted.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  formatted = formatted.replace(/__([^_]+)__/g, '<strong>$1</strong>');

  // 4. Italic: *text* or _text_
  formatted = formatted.replace(/\*([^*]+)\*/g, '<em>$1</em>');
  formatted = formatted.replace(/_([^_]+)_/g, '<em>$1</em>');

  // 5. Strikethrough: ~~text~~
  formatted = formatted.replace(/~~([^~]+)~~/g, '<del>$1</del>');

  // 6. Linked images: [![alt](img-src)](link-href)
  formatted = formatted.replace(
    /\[!\[([^\]]*)\]\(([^)]+)\)\]\(([^)]+)\)/g,
    (_, alt, imgSrc, linkHref) => {
      const rawImgSrc = unescapeEntities(imgSrc);
      const rawLinkHref = unescapeEntities(linkHref);
      if (rawLinkHref.startsWith('http://') || rawLinkHref.startsWith('https://') || rawLinkHref.startsWith('mailto:')) {
        return `<a href="${escapeHtml(rawLinkHref)}" target="_blank" rel="noopener noreferrer"><img src="${escapeHtml(rawImgSrc)}" alt="${escapeHtml(alt)}" style="max-width:100%;height:auto;" /></a>`;
      }
      const cleanHref = rawLinkHref.replace(/^\.\//, '');
      return `<a href="#/note/${escapeHtml(cleanHref)}"><img src="${escapeHtml(rawImgSrc)}" alt="${escapeHtml(alt)}" style="max-width:100%;height:auto;" /></a>`;
    }
  );

  // 7. Plain images: ![alt](src)
  formatted = formatted.replace(
    /!\[([^\]]*)\]\(([^)]+)\)/g,
    (_, alt, src) => {
      const rawSrc = unescapeEntities(src);
      return `<img src="${escapeHtml(rawSrc)}" alt="${escapeHtml(alt)}" style="max-width:100%;height:auto;" />`;
    }
  );

  // 8. Links: [text](target) - handle unescaped link markdown inside escaped string
  formatted = formatted.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, label, href) => {
    const rawHref = unescapeEntities(href);

    if (rawHref.startsWith('http://') || rawHref.startsWith('https://') || rawHref.startsWith('mailto:')) {
      return `<a href="${escapeHtml(rawHref)}" target="_blank" rel="noopener noreferrer">${label}</a>`;
    }
    // Internal note link
    const cleanHref = rawHref.replace(/^\.\//, '');
    return `<a href="#/note/${escapeHtml(cleanHref)}">${label}</a>`;
  });

  return formatted;
}

/** Reverse escapeHtml entities back to raw characters for href/src attributes */
function unescapeEntities(str: string): string {
  return str
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'");
}
