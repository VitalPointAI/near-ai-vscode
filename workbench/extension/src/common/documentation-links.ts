// Bundled documentation is addressed by a published route and its repository source path.
const documentRoot = new URL('https://documents.invalid/');
export const documentationAssetPath = /^sterling-documentation\/[0-9a-f]{16}\.(png|jpe?g|gif|webp|svg)$/;

interface DocumentLocation {
  readonly route: string;
  readonly source: string;
}

type DocumentationLink<Page> =
  | { readonly kind: 'page'; readonly page: Page; readonly hash: string }
  | { readonly kind: 'compliance' }
  | { readonly kind: 'asset' | 'external'; readonly href: string };

function routeName(path: string): string {
  return path.replace(/\/$/, '').replace(/\.mdx?$/, '').replace(/\.synced$/, '').replace(/\/index$/, '');
}

function repositoryPath(url: URL): string | undefined {
  if (url.hash.match(/^#L\d+(?:-L\d+)?$/) || url.username || url.password) return undefined;
  if (url.origin === 'https://github.com') {
    return url.pathname.match(/^\/VitalPointAI\/near-ai-vscode\/(?:blob|raw)\/main\/(.+)$/i)?.[1];
  }
  if (url.origin === 'https://raw.githubusercontent.com') {
    return url.pathname.match(/^\/VitalPointAI\/near-ai-vscode\/main\/(.+)$/i)?.[1];
  }
  return undefined;
}

/** Resolves a link to a page in this build, a packaged image, or its explicitly published external destination. */
export function resolveDocumentationLink<Page extends DocumentLocation>(
  address: string, current: Page, pages: readonly Page[]
): DocumentationLink<Page> | undefined {
  const href = address.trim();
  if (!href) return undefined;
  if (documentationAssetPath.test(href)) return { kind: 'asset', href };

  let route: URL;
  try {
    route = new URL(href, new URL(current.route, documentRoot));
    if (href.startsWith('#')) return { kind: 'page', page: current, hash: route.hash };
    if (route.origin === documentRoot.origin) {
      const documentPath = decodeURIComponent(route.pathname);
      const sourcePath = decodeURIComponent(new URL(href, new URL(current.source, documentRoot)).pathname);
      const name = routeName(documentPath);
      if (name === '/accreditation/gaps') return { kind: 'compliance' };
      const exactPage = pages.find(entry => `/${entry.route}` === documentPath)
        ?? pages.find(entry => `/${entry.source}` === sourcePath);
      if (exactPage) return { kind: 'page', page: exactPage, hash: route.hash };
      const matches = pages.filter(entry => routeName(`/${entry.route}`) === name);
      return matches.length === 1 ? { kind: 'page', page: matches[0], hash: route.hash } : undefined;
    }

    const published = repositoryPath(route);
    if (published) {
      const source = decodeURIComponent(published);
      const page = pages.find(entry => entry.source === source);
      if (page) return { kind: 'page', page, hash: route.hash };
    }
  } catch {
    return undefined;
  }
  if (['https:', 'http:', 'mailto:'].includes(route.protocol)) return { kind: 'external', href: route.href };
  return undefined;
}
