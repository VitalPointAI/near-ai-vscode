import { BRANDED_TITLE } from '../../services/webview/protocol';
import { FakeDocument, type FakeNode } from './fakeDom';

export const A11Y_RULES = [
  'radio-fieldset', 'disabled-reason', 'one-live-region', 'focus-heading', 'reduced-motion',
  'raw-colour', 'no-inner-html', 'branded-title', 'ruled-out-words'
] as const;

type A11yRule = typeof A11Y_RULES[number];

export interface A11yInput {
  html: string;
  script: string;
  css: string;
  baseCss: string;
  title: string;
}

export interface A11yFinding {
  rule: A11yRule;
  detail: string;
}

const VOID_TAGS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
const RAW_HEX = /#[0-9a-f]{3,8}\b(?![^{]*var\()/i;
const RULED_OUT_WORDS = /\bNot\s+for\s+this\s+work\b/i;

/** Read the kit's static HTML fragment into the same tree used by the page behavior tests. */
function parseFragment(html: string): FakeDocument {
  const document = new FakeDocument();
  let parent = document.body;
  // Match start/end tags and text, keeping a quoted attribute value together even when it contains '>'.
  for (const [token, closing, tagName, attributes] of html.matchAll(/<!--[\s\S]*?-->|<![^>]*>|<(\/?)([a-z][\w:-]*)(?=[\s/>])((?:"[^"]*"|'[^']*'|[^"'<>])*)>|[^<]+/gi)) {
    if (token.startsWith('<!')) continue;
    if (tagName === undefined) {
      const text = document.createElement('#text');
      text.textContent = token;
      parent.append(text);
      continue;
    }
    const name = tagName.toLowerCase();
    if (closing) {
      const node = ancestor(parent, item => item.tagName === name);
      if (node?.parent) parent = node.parent;
      continue;
    }
    const node = document.createElement(name);
    for (const [, key, double, single, bare] of attributes.matchAll(/([^\s=/"'<>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)) {
      node.setAttribute(key.toLowerCase(), double ?? single ?? bare ?? '');
    }
    node.id = node.getAttribute('id') ?? '';
    parent.append(node);
    if (!VOID_TAGS.has(name) && !token.endsWith('/>')) parent = node;
  }
  return document;
}

function ancestor(node: FakeNode | undefined, matches: (node: FakeNode) => boolean): FakeNode | undefined {
  for (let item = node; item; item = item.parent) {
    if (matches(item)) return item;
  }
  return undefined;
}

function textOf(node: FakeNode): string {
  return [node.textContent, ...node.children.map(textOf)].join('');
}

function reasonsFor(document: FakeDocument, option: FakeNode): FakeNode[] {
  const ids = option.getAttribute('aria-describedby')?.trim() ?? '';
  return ids.split(/\s+/).filter(Boolean).flatMap(id => {
    const target = document.getElementById(id);
    return target ? [target] : [];
  });
}

/** Checks static markup and the kit's literal script conventions. Rendered behavior belongs in the page's FakeDocument tests. */
export function scanPage(input: A11yInput): readonly A11yFinding[] {
  const document = parseFragment(input.html);
  const { script, title } = input;
  const css = input.css.replace(/\/\*[\s\S]*?\*\//g, '');
  const combinedCss = input.baseCss.replace(/\/\*[\s\S]*?\*\//g, '') + '\n' + css;
  const ruledOut = document.body.all(node => node.getAttribute('aria-disabled') === 'true');
  const scriptRuledOut = /\.setAttribute\s*\(\s*['"]aria-disabled['"]\s*,\s*['"]true['"]/.test(script);
  const findings: A11yFinding[] = [];
  const flag = (rule: A11yRule, detail: string): void => { findings.push({ rule, detail }); };

  // GUIDE 13 keyboard: native radios must be grouped under a fieldset's legend.
  if (document.body.all(node => node.getAttribute('type')?.toLowerCase() === 'radio').some(radio => {
    const fieldset = ancestor(radio.parent, node => node.tagName === 'fieldset');
    return !fieldset?.children.some(child => child.tagName === 'legend');
  })) flag('radio-fieldset', 'Put every radio in a fieldset with a legend.');

  // GUIDE 13 screen readers: keep ruled-out choices focusable and link to the reason text.
  const nativeDisabled = (node: FakeNode) => node.getAttribute('disabled') !== null;
  if (ruledOut.some(node => nativeDisabled(node) || node.find(nativeDisabled)
      || !reasonsFor(document, node).some(reason => textOf(reason).trim().length > 0))
    || (scriptRuledOut && !/\.setAttribute\s*\(\s*['"]aria-describedby['"]\s*,/.test(script))) {
    flag('disabled-reason', 'Use aria-disabled and link to the reason with aria-describedby.');
  }

  // GUIDE 13 screen readers: one polite region announces progress.
  const htmlRegions = document.body.all(node => node.getAttribute('aria-live') === 'polite').length;
  const scriptRegions = [...script.matchAll(/(?:\.setAttribute\s*\(\s*['"]aria-live['"]\s*,\s*['"]polite['"]\s*\)|\.ariaLive\s*=\s*['"]polite['"])/g)].length;
  if (htmlRegions + scriptRegions !== 1) flag('one-live-region', 'Provide exactly one polite live region.');

  // GUIDE 13 screen readers: the script moves focus to a programmatically focusable heading.
  const htmlHeading = document.body.find(node => /^h[1-6]$/.test(node.tagName) && node.getAttribute('tabindex') === '-1');
  const scriptHeading = /\.createElement\s*\(\s*['"]h[1-6]['"]\s*\)/i.test(script)
    && /(?:\.tabIndex\s*=\s*-1\b|\.setAttribute\s*\(\s*['"]tabindex['"]\s*,\s*['"]-1['"])/i.test(script);
  if ((!htmlHeading && !scriptHeading) || !/\.focus\s*\(/.test(script)) {
    flag('focus-heading', 'Give the step heading tabindex="-1" and focus it when the step changes.');
  }

  // GUIDE 13 reduced motion: any animated styles need a matching motion preference.
  if (/[{;]\s*(?:animation|transition)(?:-[\w-]+)?\s*:/i.test(combinedCss)
    && !/@media[^{]*\(\s*prefers-reduced-motion\s*:\s*(?:reduce|no-preference)\s*\)[^{]*\{/i.test(combinedCss)) {
    flag('reduced-motion', 'Add a prefers-reduced-motion rule for animated styles.');
  }

  // GUIDE 13 themes: the page's colours come from theme variables.
  if (RAW_HEX.test(css)) flag('raw-colour', 'Use theme variables for colours.');

  // GUIDE 13 page checks and D-26: render text without passing values to HTML setters.
  const htmlAssignment = /(?:\.\s*(?:innerHTML|outerHTML)\b|\[\s*['"](?:innerHTML|outerHTML)['"]\s*\])\s*(?:[+\-*/%&^|]|&&|\|\||\?\?|\*\*|<<|>>>?)?=(?!=|>)/;
  if (htmlAssignment.test(script) || /\binsertAdjacentHTML\b/.test(script)) {
    flag('no-inner-html', 'Build DOM nodes and assign textContent.');
  }

  // GUIDE 13 titles name the current step or page, using the kit's title rule.
  if (BRANDED_TITLE.test(title)) flag('branded-title', 'Use a title without the brand prefix.');

  // GUIDE 13 themes: each ruled-out choice also says what that state means.
  if (ruledOut.some(node => {
    const label = ancestor(node.parent, item => item.tagName === 'label')
      ?? document.body.find(item => item.tagName === 'label' && node.id !== '' && item.getAttribute('for') === node.id);
    return ![node, ...(label ? [label] : []), ...reasonsFor(document, node)].some(item => RULED_OUT_WORDS.test(textOf(item)));
  }) || (scriptRuledOut && !RULED_OUT_WORDS.test(script))) {
    flag('ruled-out-words', 'Use the words "Not for this work" on ruled-out choices.');
  }
  return findings;
}
