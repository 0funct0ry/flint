/**
 * Render Markdown content to HTML for reader pane preview.
 * Strips front matter and converts standard Markdown elements:
 * headings, blockquotes, code blocks, inline code, bold, italic,
 * task lists, unordered/ordered lists, tables, links, and paragraphs.
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

  const lines = content.split(/\r?\n/);
  const htmlOutput: string[] = [];

  let inCodeBlock = false;
  let codeBlockLang = '';
  let codeBlockContent: string[] = [];

  let inList: 'ul' | 'ol' | null = null;
  let inTable = false;
  let paragraphBuffer: string[] = [];

  function flushParagraph() {
    if (paragraphBuffer.length > 0) {
      const pText = paragraphBuffer.join(' ').trim();
      if (pText) {
        htmlOutput.push(`<p>${formatInline(pText)}</p>`);
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

  function escapeHtml(str: string): string {
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  function formatInline(text: string): string {
    // 1. Inline code: `code`
    let formatted = text.replace(/`([^`]+)`/g, (_, code) => `<code>${escapeHtml(code)}</code>`);

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

    // 6. Links: [text](target)
    formatted = formatted.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, label, href) => {
      if (href.startsWith('http://') || href.startsWith('https://') || href.startsWith('mailto:')) {
        return `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${label}</a>`;
      }
      // Internal note link
      const cleanHref = href.replace(/^\.\//, '');
      return `<a href="#/note/${escapeHtml(cleanHref)}">${label}</a>`;
    });

    return formatted;
  }

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i];
    const trimmed = rawLine.trim();

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
      htmlOutput.push(`<h${level}>${formatInline(hText)}</h${level}>`);
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

  return htmlOutput.join('\n');
}
