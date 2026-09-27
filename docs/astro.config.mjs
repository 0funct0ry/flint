import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';
import mdx from '@astrojs/mdx';

// GitHub Pages project-site path: https://0funct0ry.github.io/flint/
const site = 'https://0funct0ry.github.io';
const base = '/flint';

export default defineConfig({
  site,
  base,
  integrations: [
    starlight({
      title: 'Flint',
      description: 'The local-first Markdown IDE for AI context.',
      logo: {
        light: './src/assets/flint-icon.png',
        dark: './src/assets/flint-icon-dark.png',
        replacesTitle: false,
      },
      favicon: '/flint-icon.png',
      social: {
        github: 'https://github.com/0funct0ry/flint',
      },
      customCss: ['./src/styles/custom.css'],
      // The docs proper lives under /docs/; the site root (index.astro, outside the
      // `docs` content collection) is the marketing/landing page per M10.2.
      sidebar: [
        {
          label: 'Getting Started',
          items: [{ label: 'Getting Started', slug: 'docs/getting-started' }],
        },
        {
          label: 'Concepts',
          items: [{ label: 'Concepts', slug: 'docs/concepts' }],
        },
        {
          label: 'Reference',
          items: [
            { label: 'CLI Reference', slug: 'docs/cli-reference' },
            { label: 'Keyboard Shortcuts', slug: 'docs/keyboard-shortcuts' },
            { label: 'Configuration', slug: 'docs/configuration' },
          ],
        },
        {
          label: 'Help',
          items: [{ label: 'FAQ', slug: 'docs/faq' }],
        },
      ],
      editLink: {
        baseUrl: 'https://github.com/0funct0ry/flint/edit/main/docs/',
      },
    }),
    mdx(),
  ],
});
