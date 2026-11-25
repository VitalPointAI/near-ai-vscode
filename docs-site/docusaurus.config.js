// The Sterling Sovereign AI documentation site (Docusaurus 3).
//
// It is built for reading on this computer: no analytics, no external search service, no web
// fonts or CDNs. Search is a local index built with the site. Pages under content/ named
// *.synced.md are copies of the repository's own documents, made by scripts/sync-docs.mjs at every
// build; edit the originals, never the copies.

import { themes as prismThemes } from 'prism-react-renderer';

const repoUrl = 'https://github.com/VitalPointAI/near-ai-vscode';

/** @type {import('@docusaurus/types').Config} */
const config = {
  title: 'Sterling Sovereign AI',
  tagline: 'How to use it, and how it is built',
  url: 'http://127.0.0.1:3210',
  baseUrl: '/',
  trailingSlash: false,
  noIndex: true,

  onBrokenLinks: 'throw',
  onBrokenAnchors: 'throw',
  onDuplicateRoutes: 'throw',

  markdown: {
    // .md files are plain CommonMark (the repository's documents are written for GitHub, not MDX).
    format: 'detect',
    mermaid: true,
    hooks: {
      onBrokenMarkdownLinks: 'throw',
      onBrokenMarkdownImages: 'throw'
    }
  },

  i18n: { defaultLocale: 'en', locales: ['en'] },

  themes: [
    ['@docusaurus/theme-classic', { customCss: './src/css/custom.css' }],
    '@docusaurus/theme-mermaid',
    [
      '@easyops-cn/docusaurus-search-local',
      /** Offline search: the index is built with the site and searched in the browser. */
      ({
        indexDocs: true,
        indexBlog: false,
        indexPages: false,
        docsRouteBasePath: '/',
        docsDir: 'content',
        language: ['en'],
        hashed: true,
        highlightSearchTermsOnTargetPage: true,
        searchResultLimits: 10,
        searchBarShortcutHint: true,
        // The site is marked noindex for web crawlers; its own search still indexes every page.
        forceIgnoreNoIndex: true
      })
    ]
  ],

  plugins: [
    [
      '@docusaurus/plugin-content-docs',
      /** @type {import('@docusaurus/plugin-content-docs').Options} */
      ({
        path: 'content',
        routeBasePath: '/',
        sidebarPath: './sidebars.js',
        showLastUpdateTime: false,
        breadcrumbs: true
      })
    ],
    // The Mermaid theme imports the optional ELK layout package behind a flag that is false when the
    // package is not installed, but the bundler still tries to resolve it. It is not installed (it is
    // heavy and no page needs it), so resolve it to an empty module.
    () => ({
      name: 'mermaid-without-elk',
      configureWebpack: () => ({ resolve: { alias: { '@mermaid-js/layout-elk': false } } })
    })
  ],

  themeConfig:
    /** @type {import('@docusaurus/theme-classic').ThemeConfig} */
    ({
      colorMode: { respectPrefersColorScheme: true },
      docs: { sidebar: { hideable: true } },
      navbar: {
        title: 'Sterling Sovereign AI',
        items: [
          { type: 'docSidebar', sidebarId: 'docs', label: 'Docs', position: 'left' },
          { type: 'docsVersionDropdown', position: 'right' },
          { href: repoUrl, label: 'Repository', position: 'right' }
        ]
      },
      footer: {
        style: 'dark',
        copyright: 'Sterling Sovereign AI. MIT licence. Built from the repository at every change.'
      },
      prism: {
        theme: prismThemes.github,
        darkTheme: prismThemes.dracula,
        additionalLanguages: ['bash', 'json', 'yaml', 'toml']
      },
      mermaid: { theme: { light: 'neutral', dark: 'dark' } }
    })
};

export default config;
