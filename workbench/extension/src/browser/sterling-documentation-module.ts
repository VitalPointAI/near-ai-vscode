import { ContainerModule, injectable, postConstruct } from '@theia/core/shared/inversify';
import DOMPurify from '@theia/core/shared/dompurify';
import { isDocumentationPages, type DocumentationPage } from '../common/sterling-evidence.js';
import { BaseWidget } from '@theia/core/lib/browser/widgets/widget.js';
import { WidgetFactory } from '@theia/core/lib/browser/widget-manager.js';
import { AbstractViewContribution, bindViewContribution } from '@theia/core/lib/browser/shell/view-contribution.js';
import { CommandRegistry } from '@theia/core/lib/common/command.js';
import './sterling-documentation.css';

const widgetId = 'sterling-documentation';
export const sterlingDocumentationCommand = { id: 'sterling.documentation.open', category: 'SovAI', label: 'Documentation' };
const documentRoot = new URL('https://documents.invalid/');
const repository = 'https://github.com/VitalPointAI/near-ai-vscode/blob/main';
// Bundled images live beside sterling-documentation.json (workbench/tools/documentation-render.mjs); nothing else may be loaded.
const assetPath = /^sterling-documentation\/[0-9a-f]{16}\.(png|jpe?g|gif|webp|svg)$/;

/**
 * The pages are HTML made at build time from the repository's own guides. Sanitize it again anyway, with a private DOMPurify instance
 * (its hooks never touch Theia's shared one): no scripts, styles, forms or embedded content, and nothing that would load from anywhere but
 * the bundled images (46-03: the page makes only same-origin, data: or blob: requests).
 */
function createSanitizer(): (html: string) => DocumentFragment {
  const purify = DOMPurify(window);
  purify.addHook('uponSanitizeAttribute', (node, data) => {
    const name = data.attrName;
    const value = data.attrValue.trim();
    if (name === 'src') data.keepAttr = node.nodeName === 'IMG' && assetPath.test(value);
    else if (name === 'href' || name === 'xlink:href') data.keepAttr = node.nodeName === 'A' || value.startsWith('#');
    else if (name === 'srcset' || name === 'poster' || name === 'background' || /url\(\s*(?!['"]?#)/i.test(value)) data.keepAttr = false;
  });
  purify.addHook('afterSanitizeAttributes', node => {
    if (node.nodeName === 'IMG' && !node.hasAttribute('src')) node.remove();
  });
  return html => purify.sanitize(html, {
    RETURN_DOM_FRAGMENT: true,
    USE_PROFILES: { html: true, svg: true },
    FORBID_TAGS: ['style', 'form', 'input', 'button', 'textarea', 'select', 'foreignObject', 'image', 'use', 'video', 'audio', 'iframe', 'object', 'embed'],
    ALLOW_DATA_ATTR: false,
  });
}


@injectable()
class SterlingDocumentationWidget extends BaseWidget {
  private readonly sanitize = createSanitizer();
  private readonly search = document.createElement('input');
  private readonly navigation = document.createElement('nav');
  private readonly content = document.createElement('article');
  private pages: DocumentationPage[] = [];
  private active?: DocumentationPage;
  private readonly loadRequest = new AbortController();

  @postConstruct()
  protected initialize(): void {
    this.id = widgetId;
    this.title.label = 'Documentation';
    this.title.closable = true;
    this.addClass('sterling-documentation');
    const sidebar = document.createElement('aside');
    this.search.type = 'search';
    this.search.setAttribute('aria-label', 'Search documentation');
    this.search.placeholder = 'Search documentation';
    this.search.addEventListener('input', () => this.updateNavigation());
    this.navigation.setAttribute('aria-label', 'Documentation topics');
    sidebar.append(this.search, this.navigation);

    this.content.tabIndex = -1;
    const status = document.createElement('p');
    status.setAttribute('role', 'status');
    status.textContent = 'Loading documentation…';
    this.content.append(status);
    this.node.append(sidebar, this.content);
    this.toDispose.push({ dispose: () => this.loadRequest.abort() });
    void this.load(status);
  }

  protected override onActivateRequest(): void {
    this.search.focus();
  }

  private async load(status: HTMLElement): Promise<void> {
    try {
      const response = await fetch(new URL('sterling-documentation.json', document.baseURI), {
        signal: this.loadRequest.signal, mode: 'same-origin', redirect: 'error'
      });
      if (!response.ok) throw new Error(`Documentation fetch returned ${response.status}`);
      const pages: unknown = await response.json();
      if (!isDocumentationPages(pages)) throw new Error('Documentation collection has an unexpected shape');
      this.pages = pages;
      if (this.isDisposed) return;
      const welcome = this.pages.find(page => page.route === 'index.md') ?? this.pages[0];
      if (!welcome) throw new Error('Documentation collection is empty');
      this.openPage(welcome);
    } catch {
      if (!this.loadRequest.signal.aborted) status.textContent = 'Documentation could not be loaded. Close and reopen this tab to try again.';
    }
  }

  private updateNavigation(): void {
    const query = this.search.value.trim().toLowerCase();
    const categories = new Map<string, HTMLElement>();
    this.navigation.replaceChildren();
    for (const page of this.pages) {
      if (query && ![page.title, page.category, page.text].some(value => value.toLowerCase().includes(query))) continue;
      let group = categories.get(page.category);
      if (!group) {
        group = document.createElement('section');
        const label = document.createElement('h2');
        label.textContent = page.category;
        group.append(label);
        categories.set(page.category, group);
        this.navigation.append(group);
      }
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = page.title;
      if (page === this.active) button.setAttribute('aria-current', 'page');
      button.addEventListener('click', () => {
        this.openPage(page);
        this.content.focus();
      });
      group.append(button);
    }
    if (!categories.size) this.navigation.textContent = 'No matching topics.';
  }

  private openPage(page: DocumentationPage, hash = ''): void {
    this.active = page;
    const body = document.createElement('div');
    body.append(this.sanitize(page.html));
    const headingIds = new Map<string, number>();
    body.querySelectorAll<HTMLElement>('h1,h2,h3,h4,h5,h6').forEach(heading => {
      const base = (heading.textContent ?? '').toLowerCase().trim().replace(/[^\p{L}\p{N}\s_-]/gu, '').replace(/\s+/g, '-');
      const count = headingIds.get(base) ?? 0;
      heading.id = count ? `${base}-${count}` : base;
      headingIds.set(base, count + 1);
    });
    body.querySelectorAll<HTMLAnchorElement>('a[href]').forEach(link => this.configureLink(link, page));
    this.content.replaceChildren(body);
    this.content.scrollTop = 0;
    this.updateNavigation();
    if (hash) {
      let anchor = hash.slice(1);
      try { anchor = decodeURIComponent(anchor); } catch { /* Use the original anchor. */ }
      body.querySelector<HTMLElement>(`#${CSS.escape(anchor)}`)?.scrollIntoView({ block: 'start' });
    }
  }

  private configureLink(link: HTMLAnchorElement, current: DocumentationPage): void {
    const href = link.getAttribute('href')!;
    let route: URL;
    let source: URL;
    try {
      route = new URL(href, new URL(current.route, documentRoot));
      source = new URL(href, new URL(current.source, documentRoot));
    } catch {
      link.removeAttribute('href');
      return;
    }
    if (route.origin === documentRoot.origin) {
      const target = href.startsWith('#') ? current : this.pages.find(page =>
        [`/${page.route}`, `/${page.route.replace(/\.md$/, '')}`].includes(route.pathname) ||
        `/${page.source}` === source.pathname
      );
      if (target) {
        link.href = route.hash || '#';
        link.addEventListener('click', event => {
          event.preventDefault();
          this.openPage(target, route.hash);
          this.content.focus({ preventScroll: true });
        });
        return;
      }
      route = new URL(`${repository}${source.pathname}${source.hash}`);
    }
    if (route.protocol === 'https:' || route.protocol === 'http:' || route.protocol === 'mailto:') {
      link.href = route.href;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
    } else {
      link.removeAttribute('href');
    }
  }
}

@injectable()
class SterlingDocumentationContribution extends AbstractViewContribution<SterlingDocumentationWidget> {
  constructor() {
    super({ widgetId, widgetName: 'Documentation', defaultWidgetOptions: { area: 'main' } });
  }

  override registerCommands(commands: CommandRegistry): void {
    commands.registerCommand(sterlingDocumentationCommand, {
      execute: () => this.openView({ activate: true })
    });
  }
}

export default new ContainerModule(bind => {
  bind(SterlingDocumentationWidget).toSelf();
  bind(WidgetFactory).toDynamicValue(context => ({
    id: widgetId,
    createWidget: () => context.container.get(SterlingDocumentationWidget)
  })).inSingletonScope();
  bindViewContribution(bind, SterlingDocumentationContribution);
});
