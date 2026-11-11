import MarkdownIt, { type Token } from 'markdown-it';
import { h, type VNode, type VNodeChild } from 'vue';
import UiIcon from '../ui/UiIcon.vue';
import { t } from '../../i18n';

/**
 * Safe Markdown preview for notes (07 §3.5, 09 §8 XSS).
 *
 * markdown-it only PARSES (`html: false`, `linkify: false`, `typographer:
 * false`); its HTML renderer is never used. The token stream is turned into
 * Vue VNodes through an allowlist of element types, so text always goes
 * through Vue's escaping and there is no `v-html` / `innerHTML` anywhere:
 *
 * - raw HTML in a note (`<script>`, `<img onerror>`, …) stays visible text;
 * - a link becomes its text, the address shown as text, and — only for
 *   `http:`, `https:` and `mailto:` — a separate "open" link with
 *   `rel="noopener noreferrer nofollow"` and `target="_blank"`; any other
 *   scheme (`javascript:`, `data:`, relative paths, …) is never an anchor;
 * - images are never loaded (no `<img>`): the alt text and the address are
 *   shown as text, so a tracking pixel cannot report that a note was opened;
 * - headings move two levels down (`#` → `<h3>`) so a note never competes
 *   with the page outline; tables scroll inside a focusable region.
 */

const parser = new MarkdownIt('default', { html: false, linkify: false, typographer: false, breaks: false });

/** Display cap for addresses shown as text (data: URLs can be huge). */
const MAX_URL_DISPLAY = 200;
const SAFE_PROTOCOLS: ReadonlySet<string> = new Set(['http:', 'https:', 'mailto:']);

export function safeExternalHref(href: string | null | undefined): string | null {
  if (typeof href !== 'string' || href.length === 0) return null;
  const trimmed = href.trim();
  if (!/^(?:https?:\/\/|mailto:)/i.test(trimmed)) return null;
  try {
    const parsed = new URL(trimmed);
    return SAFE_PROTOCOLS.has(parsed.protocol) ? parsed.href : null;
  } catch {
    return null;
  }
}

function displayUrl(href: string): string {
  let text: string;
  try {
    text = parser.normalizeLinkText(href);
  } catch {
    text = href;
  }
  const chars = Array.from(text);
  return chars.length > MAX_URL_DISPLAY ? `${chars.slice(0, MAX_URL_DISPLAY).join('')}…` : text;
}

interface Frame {
  /** `null`: a transparent frame (hidden paragraph, unknown token) — children go to the parent. */
  readonly tag: string | null;
  readonly props: Record<string, unknown>;
  readonly children: VNodeChild[];
  readonly kind?: 'table' | 'link';
  readonly href?: string | null;
}

function plainText(tokens: readonly Token[] | null): string {
  if (tokens === null) return '';
  let text = '';
  for (const token of tokens) {
    if (token.type === 'text' || token.type === 'text_special' || token.type === 'code_inline') text += token.content;
    else if (token.type === 'softbreak' || token.type === 'hardbreak') text += ' ';
    else if (token.children !== null) text += plainText(token.children);
  }
  return text;
}

function alignClass(token: Token): string | undefined {
  const style = token.attrGet('style');
  if (typeof style !== 'string') return undefined;
  const match = /text-align:\s*(left|center|right)/.exec(style);
  return match === null ? undefined : `md-align-${match[1]}`;
}

function blockFrame(token: Token): Frame {
  switch (token.type) {
    case 'paragraph_open':
      return token.hidden ? { tag: null, props: {}, children: [] } : { tag: 'p', props: {}, children: [] };
    case 'heading_open': {
      const level = Number(token.tag.slice(1));
      const shifted = Math.min(Number.isFinite(level) ? level + 2 : 6, 6);
      return { tag: `h${shifted}`, props: { class: `md-heading md-heading--${level}` }, children: [] };
    }
    case 'blockquote_open':
      return { tag: 'blockquote', props: {}, children: [] };
    case 'bullet_list_open':
      return { tag: 'ul', props: {}, children: [] };
    case 'ordered_list_open': {
      const start = Number(token.attrGet('start'));
      return { tag: 'ol', props: Number.isInteger(start) && start !== 1 ? { start } : {}, children: [] };
    }
    case 'list_item_open':
      return { tag: 'li', props: {}, children: [] };
    case 'table_open':
      return { tag: 'table', props: {}, children: [], kind: 'table' };
    case 'thead_open':
      return { tag: 'thead', props: {}, children: [] };
    case 'tbody_open':
      return { tag: 'tbody', props: {}, children: [] };
    case 'tr_open':
      return { tag: 'tr', props: {}, children: [] };
    case 'th_open':
    case 'td_open': {
      const className = alignClass(token);
      return {
        tag: token.type === 'th_open' ? 'th' : 'td',
        props: className === undefined ? {} : { class: className },
        children: [],
      };
    }
    default:
      return { tag: null, props: {}, children: [] };
  }
}

function inlineFrame(token: Token): Frame {
  switch (token.type) {
    case 'strong_open':
      return { tag: 'strong', props: {}, children: [] };
    case 'em_open':
      return { tag: 'em', props: {}, children: [] };
    case 's_open':
      return { tag: 's', props: {}, children: [] };
    case 'link_open':
      return { tag: 'span', props: { class: 'md-link' }, children: [], kind: 'link', href: token.attrGet('href') as string | null };
    default:
      return { tag: null, props: {}, children: [] };
  }
}

function linkNodes(frame: Frame): VNodeChild[] {
  const raw = typeof frame.href === 'string' ? frame.href : '';
  const safe = safeExternalHref(raw);
  const shown = displayUrl(raw);
  const label = frame.children;
  const labelText = label.every((child) => typeof child === 'string') ? (label as string[]).join('') : null;
  const parts: VNodeChild[] = [h('span', { class: 'md-link-text' }, label)];
  // An autolink's text already is the address; never show it twice.
  if (shown.length > 0 && labelText !== shown && labelText !== raw) {
    parts.push(' ', h('span', { class: 'md-link-url' }, `(${shown})`));
  }
  if (safe !== null) {
    parts.push(
      ' ',
      h(
        'a',
        {
          class: 'md-link-open',
          href: safe,
          target: '_blank',
          rel: 'noopener noreferrer nofollow',
          referrerpolicy: 'no-referrer',
          'aria-label': t('notes.markdown.openLinkAria', { url: shown }),
        },
        [h(UiIcon, { name: 'external', size: 14 }), h('span', { class: 'md-link-open-label' }, t('notes.markdown.openLink'))],
      ),
    );
  } else {
    parts.push(' ', h('span', { class: 'md-link-blocked' }, t('notes.markdown.blockedLink')));
  }
  return [h('span', frame.props, parts)];
}

function imageNode(token: Token): VNode {
  const alt = plainText(token.children).trim() || token.content.trim();
  const src = token.attrGet('src');
  const shown = typeof src === 'string' ? displayUrl(src) : '';
  return h('span', { class: 'md-image', 'data-md-image': '' }, [
    h(UiIcon, { name: 'note', size: 14 }),
    h('span', { class: 'md-image-alt' }, alt.length > 0 ? t('notes.markdown.image', { alt }) : t('notes.markdown.imageNoAlt')),
    ...(shown.length > 0 ? [' ', h('span', { class: 'md-link-url' }, `(${shown})`)] : []),
    ' ',
    h('span', { class: 'md-image-note' }, t('notes.markdown.imageNotLoaded')),
  ]);
}

function renderInline(tokens: readonly Token[]): VNodeChild[] {
  const root: VNodeChild[] = [];
  const stack: Frame[] = [];
  const target = (): VNodeChild[] => (stack.length === 0 ? root : (stack[stack.length - 1] as Frame).children);
  const close = (): void => {
    const frame = stack.pop();
    if (frame === undefined) return;
    if (frame.kind === 'link') target().push(...linkNodes(frame));
    else if (frame.tag === null) target().push(...frame.children);
    else target().push(h(frame.tag, frame.props, frame.children));
  };

  for (const token of tokens) {
    if (token.nesting === 1) {
      stack.push(inlineFrame(token));
      continue;
    }
    if (token.nesting === -1) {
      close();
      continue;
    }
    switch (token.type) {
      case 'text':
      case 'text_special':
      case 'html_inline':
        target().push(token.content);
        break;
      case 'softbreak':
        target().push('\n');
        break;
      case 'hardbreak':
        target().push(h('br'));
        break;
      case 'code_inline':
        target().push(h('code', { class: 'md-code-inline' }, token.content));
        break;
      case 'image':
        target().push(imageNode(token));
        break;
      default:
        if (token.content.length > 0) target().push(token.content);
    }
  }
  while (stack.length > 0) close();
  return root;
}

/** markdown-it stops (and drops the rest) at this depth; never lose a note's text. */
const MAX_NESTING = parser.options.maxNesting ?? 100;

function tooDeep(tokens: readonly Token[]): boolean {
  for (const token of tokens) {
    if (token.level >= MAX_NESTING - 1) return true;
    if (token.children !== null && tooDeep(token.children)) return true;
  }
  return false;
}

/** Markdown source → VNodes (allowlisted elements, escaped text). */
export function renderMarkdown(source: string): VNodeChild[] {
  const tokens = parser.parse(source, {});
  if (tooDeep(tokens)) {
    // Pathologically nested input: show it verbatim (still escaped text) instead.
    return [
      h('p', { class: 'md-fallback-note muted' }, t('notes.markdown.tooDeep')),
      h('pre', { class: 'md-plain', tabindex: 0, 'aria-label': t('notes.markdown.code') }, source),
    ];
  }
  const root: VNodeChild[] = [];
  const stack: Frame[] = [];
  const target = (): VNodeChild[] => (stack.length === 0 ? root : (stack[stack.length - 1] as Frame).children);
  const close = (): void => {
    const frame = stack.pop();
    if (frame === undefined) return;
    if (frame.tag === null) {
      target().push(...frame.children);
    } else if (frame.kind === 'table') {
      target().push(
        h('div', { class: 'md-table', role: 'region', tabindex: 0, 'aria-label': t('notes.markdown.table') }, [
          h('table', frame.props, frame.children),
        ]),
      );
    } else {
      target().push(h(frame.tag, frame.props, frame.children));
    }
  };

  for (const token of tokens) {
    if (token.nesting === 1) {
      stack.push(blockFrame(token));
      continue;
    }
    if (token.nesting === -1) {
      close();
      continue;
    }
    switch (token.type) {
      case 'inline':
        target().push(...renderInline(token.children ?? []));
        break;
      case 'fence':
      case 'code_block':
        target().push(
          h('pre', { class: 'md-code', tabindex: 0, 'aria-label': t('notes.markdown.code') }, [h('code', null, token.content)]),
        );
        break;
      case 'hr':
        target().push(h('hr'));
        break;
      default:
        // html_block never appears with `html: false`; anything else is text.
        if (token.content.length > 0) target().push(h('p', null, token.content));
    }
  }
  while (stack.length > 0) close();
  return root;
}
