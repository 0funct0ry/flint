import { describe, it, expect } from 'vitest';
import { slugify, escapeHtml, renderMarkdownToHtml } from '../services/markdown';

describe('M10.02 Markdown Sanitization & Slugification', () => {
  it('escapes raw HTML script tags to prevent XSS during live preview', () => {
    const rawInput = '<script>alert("xss")</script>';
    const escaped = escapeHtml(rawInput);
    expect(escaped).toBe('&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;');

    const rendered = renderMarkdownToHtml('# Title\n\n<script>alert("xss")</script>');
    expect(rendered).not.toContain('<script>');
    expect(rendered).toContain('&lt;script&gt;');
  });

  it('escapes onerror handlers and img tags to prevent inline execution', () => {
    const rawInput = '<img src="x" onerror="alert(1)">';
    const rendered = renderMarkdownToHtml(rawInput);
    expect(rendered).not.toContain('<img src="x"');
    expect(rendered).toContain('&lt;img src=&quot;x&quot; onerror=&quot;alert(1)&quot;&gt;');
  });

  it('correctly slugifies headings matching Rust backend behavior', () => {
    expect(slugify('Hello World!')).toBe('hello-world');
    expect(slugify('Section 1.2: Advanced Rules')).toBe('section-1-2-advanced-rules');
    expect(slugify('---Heading with spaces---')).toBe('heading-with-spaces');
    expect(slugify('Special @#$% Characters')).toBe('special-characters');
    expect(slugify('Multiple   Spaces & & Symbols')).toBe('multiple-spaces-symbols');
  });

  it('generates matching id anchors in rendered headings', () => {
    const md = '## My Section Heading!';
    const rendered = renderMarkdownToHtml(md);
    expect(rendered).toContain('<h2 id="my-section-heading">My Section Heading!</h2>');
  });

  it('renders plain images with ![alt](src)', () => {
    const md = '![Logo](https://example.com/logo.png)';
    const rendered = renderMarkdownToHtml(md);
    expect(rendered).toContain('<img src="https://example.com/logo.png" alt="Logo"');
    expect(rendered).toContain('style="max-width:100%;height:auto;"');
  });

  it('renders linked images [![alt](img)](link)', () => {
    const md = '[![Build](https://img.shields.io/badge/build-passing-brightgreen)](https://example.com/ci)';
    const rendered = renderMarkdownToHtml(md);
    expect(rendered).toContain('<a href="https://example.com/ci"');
    expect(rendered).toContain('<img src="https://img.shields.io/badge/build-passing-brightgreen" alt="Build"');
    expect(rendered).toContain('target="_blank"');
  });

  it('renders local/relative images', () => {
    const md = '![screenshot](./assets/screenshot.png)';
    const rendered = renderMarkdownToHtml(md);
    expect(rendered).toContain('<img src="./assets/screenshot.png" alt="screenshot"');
  });

  it('renders horizontal rules from ---, ***, and ___', () => {
    const md = 'Paragraph 1\n\n---\n\nParagraph 2\n\n***\n\n___';
    const rendered = renderMarkdownToHtml(md);
    expect(rendered).toContain('<hr />');
    expect(rendered).not.toContain('<p>---</p>');
    expect(rendered).not.toContain('<p>***</p>');
    expect(rendered).not.toContain('<p>___</p>');
    expect(rendered).toContain('<p>Paragraph 1</p>');
    expect(rendered).toContain('<p>Paragraph 2</p>');
  });
});

