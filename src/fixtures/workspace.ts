import { NoteFixture, TreeNodeItem } from '../types';

export const FIXTURE_WORKSPACE_NAME = 'projects';
export const FIXTURE_ROOT_PATH = '~/notes/projects';

export const FIXTURE_NOTES: Record<string, NoteFixture> = {
  'projects/payments/settlement.md': {
    path: 'projects/payments/settlement.md',
    title: 'Settlement windows',
    folder: 'projects/payments',
    tags: ['payments', 'bbps', 'settlement'],
    lastModifiedAgo: 'edited 4m ago',
    frontMatter: {
      title: 'Settlement windows',
      tags: ['payments', 'bbps'],
    },
    headings: [
      { level: 1, text: 'Settlement windows', anchor: 'settlement-windows' },
      { level: 2, text: 'The two windows', anchor: 'the-two-windows' },
      { level: 2, text: 'Cut-off arithmetic', anchor: 'cut-off-arithmetic' },
      { level: 2, text: 'Failure handling', anchor: 'failure-handling' },
      { level: 3, text: 'Deemed acceptance', anchor: 'deemed-acceptance' },
    ],
    outgoingLinks: [
      {
        source: 'projects/payments/settlement.md',
        rawTarget: './rails.md',
        resolved: 'projects/payments/rails.md',
        line: 14,
        col: 5,
        context: 'See [the rails note](./rails.md) for how each window maps',
      },
      {
        source: 'projects/payments/settlement.md',
        rawTarget: './bbps-flows.md#netting',
        resolved: 'projects/payments/bbps-flows.md',
        line: 15,
        col: 5,
        context: 'and [BBPS flows](./bbps-flows.md#netting).',
      },
      {
        source: 'projects/payments/settlement.md',
        rawTarget: './recon-2026.md',
        resolved: undefined, // broken link
        line: 25,
        col: 28,
        context: 'Reconciliation notes live in [recon-2026](./recon-2026.md).',
      },
    ],
    backlinks: [
      {
        sourcePath: 'projects/payments/rails.md',
        sourceTitle: 'rails.md',
        folder: 'projects/payments',
        occurrences: [
          { line: 22, context: 'each window in [settlement](./settlement.md) maps to…' },
          { line: 45, context: '…the W2 cut-off, see [settlement](./settlement.md#cut)' },
        ],
      },
      {
        sourcePath: 'projects/payments/bbps-flows.md',
        sourceTitle: 'bbps-flows.md',
        folder: 'projects/payments',
        occurrences: [
          { line: 12, context: 'netting follows the [settlement](./settlement.md) table' },
        ],
      },
      {
        sourcePath: 'archive/2024-review.md',
        sourceTitle: '2024 review',
        folder: 'archive',
        occurrences: [
          { line: 94, context: 'we missed a [window](../projects/payments/settlement.md)' },
        ],
      },
    ],
    content: `---
title: Settlement windows
tags: [payments, bbps]
---

# Settlement windows

BBPS settles in two windows each business day. The first closes at
13:00 IST, the second at 23:30 IST. Everything after the second
window rolls into the next day's first cycle.

## The two windows

| Window | Cut-off   | Credit  |
|--------|-----------|---------|
| W1     | 13:00 IST | T+0     |
| W2     | 23:30 IST | T+1     |

See [the rails note](./rails.md) for how each window maps
onto NPCI's netting run, and [BBPS flows](./bbps-flows.md#netting).

## Cut-off arithmetic

Given a transaction at time $t$, the credit date is:

$$
D(t) = \\begin{cases} T   & t \\le 13{:}00 \\\\ T+1 & t > 13{:}00 \\end{cases}
$$

Reconciliation notes live in [recon-2026](./recon-2026.md).

## Failure handling

- [x] Timeout inside a window retries in the same window
- [ ] Timeout across a cut-off must re-quote the credit date
- [ ] Document deemed acceptance at \`T+3\`

### Deemed acceptance
Credit dates quoted to the customer are contractual. Re-quote on every cut-off crossing.

\`\`\`bash
$ flint search "deemed acceptance" --json
projects/payments/settlement.md:38
projects/payments/rails.md:71
\`\`\``,
    renderedHtml: `
      <h1>Settlement windows</h1>
      <p>BBPS settles in two windows each business day. The first closes at 13:00 IST, the
         second at 23:30 IST. Everything after the second window rolls into the next day's
         first cycle.</p>

      <h2>The two windows</h2>
      <div style="overflow-x:auto">
        <table>
          <thead><tr><th>Window</th><th>Cut-off</th><th>Credit</th></tr></thead>
          <tbody>
            <tr><td>W1</td><td>13:00 IST</td><td>T+0</td></tr>
            <tr><td>W2</td><td>23:30 IST</td><td>T+1</td></tr>
          </tbody>
        </table>
      </div>
      <p>See <a href="#/note/projects/payments/rails.md">the rails note</a> for how each window maps onto NPCI's netting run,
         and <a href="#/note/projects/payments/bbps-flows.md">BBPS flows</a>.</p>

      <h2>Cut-off arithmetic</h2>
      <p>Given a transaction at time <em>t</em>, the credit date is:</p>
      <div class="reader-math">D(t) = T if t ≤ 13:00 &nbsp;·&nbsp; T+1 if t &gt; 13:00</div>
      <p>Reconciliation notes live in
         <a href="#/note/projects/payments/recon-2026.md" class="broken" title="Note does not exist — click to create">recon-2026</a>.</p>

      <h2>Failure handling</h2>
      <ul>
        <li>☑ Timeout inside a window retries in the same window</li>
        <li>☐ Timeout across a cut-off must re-quote the credit date</li>
        <li>☐ Document deemed acceptance at <code>T+3</code></li>
      </ul>

      <h3>Deemed acceptance</h3>
      <blockquote>Credit dates quoted to the customer are contractual. Re-quote on every
        cut-off crossing.</blockquote>
      <pre><code>$ flint search "deemed acceptance" --json
projects/payments/settlement.md:38
projects/payments/rails.md:71</code></pre>
    `,
  },

  'projects/payments/rails.md': {
    path: 'projects/payments/rails.md',
    title: 'Payment rails overview',
    folder: 'projects/payments',
    tags: ['payments', 'rails', 'architecture'],
    lastModifiedAgo: 'edited 2h ago',
    headings: [
      { level: 1, text: 'Payment rails overview', anchor: 'payment-rails-overview' },
      { level: 2, text: 'Supported Rails', anchor: 'supported-rails' },
      { level: 2, text: 'Settlement Mapping', anchor: 'settlement-mapping' },
    ],
    outgoingLinks: [
      {
        source: 'projects/payments/rails.md',
        rawTarget: './settlement.md',
        resolved: 'projects/payments/settlement.md',
        line: 22,
        col: 10,
        context: 'each window in [settlement](./settlement.md) maps to…',
      },
    ],
    backlinks: [
      {
        sourcePath: 'projects/payments/settlement.md',
        sourceTitle: 'settlement.md',
        folder: 'projects/payments',
        occurrences: [
          { line: 14, context: 'See [the rails note](./rails.md) for how each window maps' },
        ],
      },
    ],
    content: `# Payment rails overview

Flint integrates with modern payment rails for accounting and automated verification.

## Supported Rails

1. **UPI / IMPS** — 24x7 instant settlement.
2. **NEFT / RTGS** — Batch-oriented gross settlement.
3. **BBPS** — Centralized recurring bill processing.

## Settlement Mapping

Each settlement window in [settlement](./settlement.md) maps to specific bank netting cycles.
Make sure all idempotency keys are retained across retries.`,
    renderedHtml: `
      <h1>Payment rails overview</h1>
      <p>Flint integrates with modern payment rails for accounting and automated verification.</p>
      <h2>Supported Rails</h2>
      <ol>
        <li><strong>UPI / IMPS</strong> — 24x7 instant settlement.</li>
        <li><strong>NEFT / RTGS</strong> — Batch-oriented gross settlement.</li>
        <li><strong>BBPS</strong> — Centralized recurring bill processing.</li>
      </ol>
      <h2>Settlement Mapping</h2>
      <p>Each settlement window in <a href="#/note/projects/payments/settlement.md">settlement</a> maps to specific bank netting cycles. Make sure all idempotency keys are retained across retries.</p>
    `,
  },

  'projects/payments/bbps-flows.md': {
    path: 'projects/payments/bbps-flows.md',
    title: 'BBPS transaction flows',
    folder: 'projects/payments',
    tags: ['payments', 'bbps'],
    lastModifiedAgo: 'edited 1d ago',
    headings: [
      { level: 1, text: 'BBPS transaction flows', anchor: 'bbps-transaction-flows' },
      { level: 2, text: 'Netting and Clearing', anchor: 'netting-and-clearing' },
    ],
    outgoingLinks: [
      {
        source: 'projects/payments/bbps-flows.md',
        rawTarget: './settlement.md',
        resolved: 'projects/payments/settlement.md',
        line: 12,
        col: 8,
        context: 'netting follows the [settlement](./settlement.md) table',
      },
    ],
    backlinks: [
      {
        sourcePath: 'projects/payments/settlement.md',
        sourceTitle: 'settlement.md',
        folder: 'projects/payments',
        occurrences: [
          { line: 15, context: 'and [BBPS flows](./bbps-flows.md#netting).' },
        ],
      },
    ],
    content: `# BBPS transaction flows

Detailed flow sequences for Biller and Agent institutions.

## Netting and Clearing

All netting follows the [settlement](./settlement.md) table schedules.
Any dispute raised in T+1 is reconciled in the subsequent clearing session.`,
    renderedHtml: `
      <h1>BBPS transaction flows</h1>
      <p>Detailed flow sequences for Biller and Agent institutions.</p>
      <h2>Netting and Clearing</h2>
      <p>All netting follows the <a href="#/note/projects/payments/settlement.md">settlement</a> table schedules. Any dispute raised in T+1 is reconciled in the subsequent clearing session.</p>
    `,
  },

  'archive/2024-review.md': {
    path: 'archive/2024-review.md',
    title: '2024 Year in Review',
    folder: 'archive',
    tags: ['review', 'archive'],
    lastModifiedAgo: 'edited 3w ago',
    headings: [
      { level: 1, text: '2024 Year in Review', anchor: '2024-year-in-review' },
      { level: 2, text: 'Operational Highlights', anchor: 'operational-highlights' },
    ],
    outgoingLinks: [
      {
        source: 'archive/2024-review.md',
        rawTarget: '../projects/payments/settlement.md',
        resolved: 'projects/payments/settlement.md',
        line: 94,
        col: 14,
        context: 'we missed a [window](../projects/payments/settlement.md)',
      },
    ],
    backlinks: [],
    content: `# 2024 Year in Review

Summary of architecture milestones and platform improvements.

## Operational Highlights

- Reached 99.99% system availability.
- During high volume week, we missed a [window](../projects/payments/settlement.md) cut-off by 3 minutes before mitigation.`,
    renderedHtml: `
      <h1>2024 Year in Review</h1>
      <p>Summary of architecture milestones and platform improvements.</p>
      <h2>Operational Highlights</h2>
      <ul>
        <li>Reached 99.99% system availability.</li>
        <li>During high volume week, we missed a <a href="#/note/projects/payments/settlement.md">window</a> cut-off by 3 minutes before mitigation.</li>
      </ul>
    `,
  },

  'daily.md': {
    path: 'daily.md',
    title: 'Daily Log — 2026-09-22',
    folder: '',
    tags: ['daily', 'log'],
    lastModifiedAgo: 'edited 10m ago',
    headings: [
      { level: 1, text: 'Daily Log — 2026-09-22', anchor: 'daily-log-2026-09-22' },
      { level: 2, text: 'Tasks for Today', anchor: 'tasks-for-today' },
      { level: 2, text: 'Notes & Ideas', anchor: 'notes-ideas' },
    ],
    outgoingLinks: [
      {
        source: 'daily.md',
        rawTarget: 'projects/payments/settlement.md',
        resolved: 'projects/payments/settlement.md',
        line: 8,
        col: 10,
        context: 'Review [settlement](./projects/payments/settlement.md) timings',
      },
    ],
    backlinks: [],
    content: `# Daily Log — 2026-09-22

Morning standup and backlog priorities.

## Tasks for Today

- [x] Scaffold Flint workspace and UI shell
- [ ] Review [settlement](./projects/payments/settlement.md) timings with banking partner
- [ ] Verify CodeMirror 6 markdown highlighting

## Notes & Ideas

Flint architecture keeps note data in user-owned plain Markdown files with zero database lock-in.`,
    renderedHtml: `
      <h1>Daily Log — 2026-09-22</h1>
      <p>Morning standup and backlog priorities.</p>
      <h2>Tasks for Today</h2>
      <ul>
        <li>☑ Scaffold Flint workspace and UI shell</li>
        <li>☐ Review <a href="#/note/projects/payments/settlement.md">settlement</a> timings with banking partner</li>
        <li>☐ Verify CodeMirror 6 markdown highlighting</li>
      </ul>
      <h2>Notes & Ideas</h2>
      <p>Flint architecture keeps note data in user-owned plain Markdown files with zero database lock-in.</p>
    `,
  },

  'inbox.md': {
    path: 'inbox.md',
    title: 'Inbox & Quick Captures',
    folder: '',
    tags: ['inbox', 'capture'],
    lastModifiedAgo: 'edited 1h ago',
    headings: [
      { level: 1, text: 'Inbox & Quick Captures', anchor: 'inbox-quick-captures' },
    ],
    outgoingLinks: [],
    backlinks: [],
    content: `# Inbox & Quick Captures

- Idea: Add offline KaTeX math rendering support.
- Read article on local-first database models.
- Review link autocomplete relative path calculation rules.`,
    renderedHtml: `
      <h1>Inbox & Quick Captures</h1>
      <ul>
        <li>Idea: Add offline KaTeX math rendering support.</li>
        <li>Read article on local-first database models.</li>
        <li>Review link autocomplete relative path calculation rules.</li>
      </ul>
    `,
  },

  'index.md': {
    path: 'index.md',
    title: 'Workspace Index & Navigation',
    folder: '',
    tags: ['index', 'overview'],
    lastModifiedAgo: 'edited 5h ago',
    headings: [
      { level: 1, text: 'Workspace Index & Navigation', anchor: 'workspace-index-navigation' },
      { level: 2, text: 'Core Areas', anchor: 'core-areas' },
    ],
    outgoingLinks: [
      {
        source: 'index.md',
        rawTarget: 'projects/payments/settlement.md',
        resolved: 'projects/payments/settlement.md',
        line: 6,
        col: 5,
        context: '1. [Settlement Windows](./projects/payments/settlement.md)',
      },
      {
        source: 'index.md',
        rawTarget: 'projects/payments/rails.md',
        resolved: 'projects/payments/rails.md',
        line: 7,
        col: 5,
        context: '2. [Payment Rails](./projects/payments/rails.md)',
      },
    ],
    backlinks: [],
    content: `# Workspace Index & Navigation

Welcome to the Flint project workspace.

## Core Areas

1. [Settlement Windows](./projects/payments/settlement.md)
2. [Payment Rails](./projects/payments/rails.md)
3. [BBPS Flows](./projects/payments/bbps-flows.md)`,
    renderedHtml: `
      <h1>Workspace Index & Navigation</h1>
      <p>Welcome to the Flint project workspace.</p>
      <h2>Core Areas</h2>
      <ol>
        <li><a href="#/note/projects/payments/settlement.md">Settlement Windows</a></li>
        <li><a href="#/note/projects/payments/rails.md">Payment Rails</a></li>
        <li><a href="#/note/projects/payments/bbps-flows.md">BBPS Flows</a></li>
      </ol>
    `,
  },

  'reading/glossary.md': {
    path: 'reading/glossary.md',
    title: 'Net settlement glossary',
    folder: 'reading',
    tags: ['reading', 'glossary'],
    lastModifiedAgo: 'edited 4d ago',
    headings: [
      { level: 1, text: 'Net settlement glossary', anchor: 'net-settlement-glossary' },
      { level: 2, text: 'Definitions', anchor: 'definitions' },
    ],
    outgoingLinks: [],
    backlinks: [],
    content: `# Net settlement glossary

## Definitions

- **Gross Settlement**: Immediate settlement per individual transaction.
- **Net Settlement**: Multilateral netting aggregated into discrete time windows.
- **Deemed Acceptance**: Rule where unconfirmed status transitions to accepted after cut-off.`,
    renderedHtml: `
      <h1>Net settlement glossary</h1>
      <h2>Definitions</h2>
      <ul>
        <li><strong>Gross Settlement</strong>: Immediate settlement per individual transaction.</li>
        <li><strong>Net Settlement</strong>: Multilateral netting aggregated into discrete time windows.</li>
        <li><strong>Deemed Acceptance</strong>: Rule where unconfirmed status transitions to accepted after cut-off.</li>
      </ul>
    `,
  },

  'reading/distributed-systems.md': {
    path: 'reading/distributed-systems.md',
    title: 'Distributed Systems & Local-First Notes',
    folder: 'reading',
    tags: ['reading', 'systems'],
    lastModifiedAgo: 'edited 6d ago',
    headings: [
      { level: 1, text: 'Distributed Systems & Local-First Notes', anchor: 'distributed-systems' },
    ],
    outgoingLinks: [],
    backlinks: [],
    content: `# Distributed Systems & Local-First Notes

Key ideas from local-first software research:
- User owns data on local disk.
- Fast startup, no spinning spinners.
- Multi-device sync happens peer-to-peer or via generic file syncing.`,
    renderedHtml: `
      <h1>Distributed Systems & Local-First Notes</h1>
      <p>Key ideas from local-first software research:</p>
      <ul>
        <li>User owns data on local disk.</li>
        <li>Fast startup, no spinning spinners.</li>
        <li>Multi-device sync happens peer-to-peer or via generic file syncing.</li>
      </ul>
    `,
  },

  'archive/settle-recon.md': {
    path: 'archive/settle-recon.md',
    title: 'Settlement recon checklist',
    folder: 'archive',
    tags: ['archive', 'settlement', 'checklist'],
    lastModifiedAgo: 'edited 2mo ago',
    headings: [
      { level: 1, text: 'Settlement recon checklist', anchor: 'settlement-recon-checklist' },
    ],
    outgoingLinks: [],
    backlinks: [],
    content: `# Settlement recon checklist

1. Verify cut-off timestamps against server NTP.
2. Confirm file batch hash matching NPCI acknowledgment.
3. Flag discrepancies exceeding ₹0.01 tolerance threshold.`,
    renderedHtml: `
      <h1>Settlement recon checklist</h1>
      <ol>
        <li>Verify cut-off timestamps against server NTP.</li>
        <li>Confirm file batch hash matching NPCI acknowledgment.</li>
        <li>Flag discrepancies exceeding ₹0.01 tolerance threshold.</li>
      </ol>
    `,
  },
};

// Generate ~30 additional realistic notes across multiple folders to reach ~40 fixture notes
const MORE_FOLDERS = [
  'projects/ui',
  'projects/flint',
  'guides/getting-started',
  'guides/shortcuts',
  'reading/books',
  'reading/papers',
  'archive/2023',
];

MORE_FOLDERS.forEach((folder, idx) => {
  for (let i = 1; i <= 4; i++) {
    const slug = `topic-${idx * 4 + i}`;
    const fullPath = `${folder}/${slug}.md`;
    const title = `${folder.split('/')[1] || folder} Note ${idx * 4 + i} — ${slug}`;
    FIXTURE_NOTES[fullPath] = {
      path: fullPath,
      title,
      folder,
      tags: [folder.split('/')[0], folder.split('/')[1] || 'general'],
      lastModifiedAgo: `${i * 3}d ago`,
      headings: [
        { level: 1, text: title, anchor: `${slug}-title` },
        { level: 2, text: 'Overview', anchor: `${slug}-overview` },
        { level: 2, text: 'Key Takeaways', anchor: `${slug}-takeaways` },
      ],
      outgoingLinks: [
        {
          source: fullPath,
          rawTarget: '../payments/settlement.md',
          resolved: 'projects/payments/settlement.md',
          line: 5,
          col: 10,
          context: 'Reference [settlement](../payments/settlement.md) for timing details.',
        },
      ],
      backlinks: [],
      content: `# ${title}

This note documents reference architecture and patterns in \`${folder}\`.

## Overview
Flint is a local-first Markdown knowledge workspace. Every note stays a plain, portable Markdown file on disk.

## Key Takeaways
- Flat surfaces, dense Zed-inspired styling.
- Fast full-text content search and fuzzy name search.
- Bidirectional backlink indexing.`,
      renderedHtml: `
        <h1>${title}</h1>
        <p>This note documents reference architecture and patterns in <code>${folder}</code>.</p>
        <h2>Overview</h2>
        <p>Flint is a local-first Markdown knowledge workspace. Every note stays a plain, portable Markdown file on disk.</p>
        <h2>Key Takeaways</h2>
        <ul>
          <li>Flat surfaces, dense Zed-inspired styling.</li>
          <li>Fast full-text content search and fuzzy name search.</li>
          <li>Bidirectional backlink indexing.</li>
        </ul>
      `,
    };
  }
});

// Non-note fixture items
export const FIXTURE_NON_NOTES = [
  'LICENSE',
  'assets/diagram.png',
  'assets/flow.svg',
];

// Tree structure representing the fixture workspace
export const FIXTURE_TREE: TreeNodeItem[] = [
  {
    id: 'archive',
    name: 'archive',
    path: 'archive',
    isFolder: true,
    children: [
      {
        id: 'archive/2023',
        name: '2023',
        path: 'archive/2023',
        isFolder: true,
        children: [
          { id: 'archive/2023/topic-25.md', name: 'topic-25.md', path: 'archive/2023/topic-25.md', isFolder: false, isNote: true },
          { id: 'archive/2023/topic-26.md', name: 'topic-26.md', path: 'archive/2023/topic-26.md', isFolder: false, isNote: true },
          { id: 'archive/2023/topic-27.md', name: 'topic-27.md', path: 'archive/2023/topic-27.md', isFolder: false, isNote: true },
          { id: 'archive/2023/topic-28.md', name: 'topic-28.md', path: 'archive/2023/topic-28.md', isFolder: false, isNote: true },
        ],
      },
      { id: 'archive/2024-review.md', name: '2024-review.md', path: 'archive/2024-review.md', isFolder: false, isNote: true },
      { id: 'archive/settle-recon.md', name: 'settle-recon.md', path: 'archive/settle-recon.md', isFolder: false, isNote: true },
    ],
  },
  {
    id: 'guides',
    name: 'guides',
    path: 'guides',
    isFolder: true,
    children: [
      {
        id: 'guides/getting-started',
        name: 'getting-started',
        path: 'guides/getting-started',
        isFolder: true,
        children: [
          { id: 'guides/getting-started/topic-9.md', name: 'topic-9.md', path: 'guides/getting-started/topic-9.md', isFolder: false, isNote: true },
          { id: 'guides/getting-started/topic-10.md', name: 'topic-10.md', path: 'guides/getting-started/topic-10.md', isFolder: false, isNote: true },
          { id: 'guides/getting-started/topic-11.md', name: 'topic-11.md', path: 'guides/getting-started/topic-11.md', isFolder: false, isNote: true },
          { id: 'guides/getting-started/topic-12.md', name: 'topic-12.md', path: 'guides/getting-started/topic-12.md', isFolder: false, isNote: true },
        ],
      },
      {
        id: 'guides/shortcuts',
        name: 'shortcuts',
        path: 'guides/shortcuts',
        isFolder: true,
        children: [
          { id: 'guides/shortcuts/topic-13.md', name: 'topic-13.md', path: 'guides/shortcuts/topic-13.md', isFolder: false, isNote: true },
          { id: 'guides/shortcuts/topic-14.md', name: 'topic-14.md', path: 'guides/shortcuts/topic-14.md', isFolder: false, isNote: true },
          { id: 'guides/shortcuts/topic-15.md', name: 'topic-15.md', path: 'guides/shortcuts/topic-15.md', isFolder: false, isNote: true },
          { id: 'guides/shortcuts/topic-16.md', name: 'topic-16.md', path: 'guides/shortcuts/topic-16.md', isFolder: false, isNote: true },
        ],
      },
    ],
  },
  {
    id: 'projects',
    name: 'projects',
    path: 'projects',
    isFolder: true,
    children: [
      {
        id: 'projects/payments',
        name: 'payments',
        path: 'projects/payments',
        isFolder: true,
        children: [
          { id: 'projects/payments/settlement.md', name: 'settlement.md', path: 'projects/payments/settlement.md', isFolder: false, isNote: true },
          { id: 'projects/payments/rails.md', name: 'rails.md', path: 'projects/payments/rails.md', isFolder: false, isNote: true },
          { id: 'projects/payments/bbps-flows.md', name: 'bbps-flows.md', path: 'projects/payments/bbps-flows.md', isFolder: false, isNote: true },
        ],
      },
      {
        id: 'projects/ui',
        name: 'ui',
        path: 'projects/ui',
        isFolder: true,
        children: [
          { id: 'projects/ui/topic-1.md', name: 'topic-1.md', path: 'projects/ui/topic-1.md', isFolder: false, isNote: true },
          { id: 'projects/ui/topic-2.md', name: 'topic-2.md', path: 'projects/ui/topic-2.md', isFolder: false, isNote: true },
          { id: 'projects/ui/topic-3.md', name: 'topic-3.md', path: 'projects/ui/topic-3.md', isFolder: false, isNote: true },
          { id: 'projects/ui/topic-4.md', name: 'topic-4.md', path: 'projects/ui/topic-4.md', isFolder: false, isNote: true },
        ],
      },
      {
        id: 'projects/flint',
        name: 'flint',
        path: 'projects/flint',
        isFolder: true,
        children: [
          { id: 'projects/flint/topic-5.md', name: 'topic-5.md', path: 'projects/flint/topic-5.md', isFolder: false, isNote: true },
          { id: 'projects/flint/topic-6.md', name: 'topic-6.md', path: 'projects/flint/topic-6.md', isFolder: false, isNote: true },
          { id: 'projects/flint/topic-7.md', name: 'topic-7.md', path: 'projects/flint/topic-7.md', isFolder: false, isNote: true },
          { id: 'projects/flint/topic-8.md', name: 'topic-8.md', path: 'projects/flint/topic-8.md', isFolder: false, isNote: true },
        ],
      },
    ],
  },
  {
    id: 'reading',
    name: 'reading',
    path: 'reading',
    isFolder: true,
    children: [
      {
        id: 'reading/books',
        name: 'books',
        path: 'reading/books',
        isFolder: true,
        children: [
          { id: 'reading/books/topic-17.md', name: 'topic-17.md', path: 'reading/books/topic-17.md', isFolder: false, isNote: true },
          { id: 'reading/books/topic-18.md', name: 'topic-18.md', path: 'reading/books/topic-18.md', isFolder: false, isNote: true },
          { id: 'reading/books/topic-19.md', name: 'topic-19.md', path: 'reading/books/topic-19.md', isFolder: false, isNote: true },
          { id: 'reading/books/topic-20.md', name: 'topic-20.md', path: 'reading/books/topic-20.md', isFolder: false, isNote: true },
        ],
      },
      {
        id: 'reading/papers',
        name: 'papers',
        path: 'reading/papers',
        isFolder: true,
        children: [
          { id: 'reading/papers/topic-21.md', name: 'topic-21.md', path: 'reading/papers/topic-21.md', isFolder: false, isNote: true },
          { id: 'reading/papers/topic-22.md', name: 'topic-22.md', path: 'reading/papers/topic-22.md', isFolder: false, isNote: true },
          { id: 'reading/papers/topic-23.md', name: 'topic-23.md', path: 'reading/papers/topic-23.md', isFolder: false, isNote: true },
          { id: 'reading/papers/topic-24.md', name: 'topic-24.md', path: 'reading/papers/topic-24.md', isFolder: false, isNote: true },
        ],
      },
      { id: 'reading/glossary.md', name: 'glossary.md', path: 'reading/glossary.md', isFolder: false, isNote: true },
      { id: 'reading/distributed-systems.md', name: 'distributed-systems.md', path: 'reading/distributed-systems.md', isFolder: false, isNote: true },
    ],
  },
  { id: 'daily.md', name: 'daily.md', path: 'daily.md', isFolder: false, isNote: true },
  { id: 'inbox.md', name: 'inbox.md', path: 'inbox.md', isFolder: false, isNote: true },
  { id: 'index.md', name: 'index.md', path: 'index.md', isFolder: false, isNote: true },
  { id: 'LICENSE', name: 'LICENSE', path: 'LICENSE', isFolder: false, isNote: false },
];
