import { mount, type VueWrapper } from '@vue/test-utils';
import MarkdownView from '../src/components/notes/MarkdownView.vue';
import { plainSummary, safeExternalHref } from '../src/components/notes/markdown';

/**
 * M6-03 Markdown preview: markdown-it parses (html/linkify/typographer off),
 * the token stream becomes escaped VNodes. No raw HTML, no script, no
 * javascript:/data: anchors, no loaded image, headings demoted below the page.
 */

const ALLOWED_ATTRIBUTES = new Set([
  'class',
  'href',
  'target',
  'rel',
  'referrerpolicy',
  'aria-label',
  'aria-hidden',
  'role',
  'tabindex',
  'start',
  'data-markdown',
  'data-md-image',
  // UiIcon's inline SVG.
  'viewBox',
  'viewbox',
  'width',
  'height',
  'fill',
  'stroke',
  'stroke-width',
  'stroke-linecap',
  'stroke-linejoin',
  'focusable',
  'd',
  'cx',
  'cy',
  'r',
]);

function render(source: string): VueWrapper {
  return mount(MarkdownView, { props: { source }, attachTo: document.body });
}

function attributesOf(wrapper: VueWrapper): string[] {
  const names: string[] = [];
  for (const element of [wrapper.element, ...wrapper.element.querySelectorAll('*')]) {
    for (const attribute of Array.from(element.attributes)) names.push(attribute.name);
  }
  return names;
}

function expectOnlySafeMarkup(wrapper: VueWrapper): void {
  const root = wrapper.element as HTMLElement;
  expect(root.querySelector('script, img, iframe, object, embed, style, link, form, input, svg image')).toBeNull();
  const unexpected = attributesOf(wrapper).filter((name) => !ALLOWED_ATTRIBUTES.has(name));
  expect(unexpected).toEqual([]);
  for (const anchor of root.querySelectorAll('a')) {
    expect(anchor.getAttribute('href') ?? '').toMatch(/^(https?:\/\/|mailto:)/);
    expect(anchor.getAttribute('target')).toBe('_blank');
    expect(anchor.getAttribute('rel')).toBe('noopener noreferrer nofollow');
  }
}

describe('note Markdown preview (escaped VNodes, no v-html)', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('renders headings (demoted), lists, emphasis, quotes, code and tables', () => {
    const wrapper = render(
      [
        '# 제목 하나',
        '## 제목 둘',
        '',
        '- 첫째',
        '- **둘째**',
        '',
        '3. 셋',
        '4. 넷',
        '',
        '> 인용',
        '',
        '```',
        'const x = 1 < 2;',
        '```',
        '',
        '| 열 | 값 |',
        '| :-- | --: |',
        '| a | 1 |',
      ].join('\n'),
    );
    const root = wrapper.element as HTMLElement;
    // Never competes with the page's own h1/h2.
    expect(root.querySelector('h1, h2')).toBeNull();
    expect(root.querySelector('h3')?.textContent).toBe('제목 하나');
    expect(root.querySelector('h4')?.textContent).toBe('제목 둘');
    expect(root.querySelectorAll('ul > li')).toHaveLength(2);
    expect(root.querySelector('ul strong')?.textContent).toBe('둘째');
    expect(root.querySelector('ol')?.getAttribute('start')).toBe('3');
    expect(root.querySelector('blockquote')?.textContent).toContain('인용');
    expect(root.querySelector('pre code')?.textContent).toBe('const x = 1 < 2;\n');
    const table = root.querySelector('.md-table');
    expect(table?.getAttribute('role')).toBe('region');
    expect(table?.getAttribute('tabindex')).toBe('0');
    expect(root.querySelector('td.md-align-right')?.textContent).toBe('1');
    expectOnlySafeMarkup(wrapper);
  });

  it('keeps <script> and raw HTML as visible text (negative)', () => {
    const wrapper = render(
      [
        '<script>window.__pwned = 1</script>',
        '',
        'inline <img src=x onerror="window.__pwned = 2"> and <b onclick="x()">bold</b>',
        '',
        '<div style="position:fixed">overlay</div>',
        '',
        '&lt;i&gt;entity&lt;/i&gt;',
      ].join('\n'),
    );
    const root = wrapper.element as HTMLElement;
    expect(root.querySelector('script, img, b, div div')).toBeNull();
    expect(root.textContent).toContain('<script>window.__pwned = 1</script>');
    expect(root.textContent).toContain('<img src=x onerror="window.__pwned = 2">');
    expect(root.textContent).toContain('<div style="position:fixed">overlay</div>');
    expect(root.textContent).toContain('<i>entity</i>');
    expect((window as { __pwned?: number }).__pwned).toBeUndefined();
    expectOnlySafeMarkup(wrapper);
  });

  it('never makes javascript:, data: or other schemes into links (negative)', () => {
    const wrapper = render(
      [
        '[클릭](javascript:alert(1))',
        '[대소문자](JaVaScRiPt:alert(1))',
        '[공백](  javascript:alert(1))',
        '<javascript:alert(1)>',
        '[데이터](data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==)',
        '[파일](file:///etc/passwd)',
        '[상대 경로](/settings/ai)',
        '[ftp](ftp://files.example.org/a)',
        '[vb](vbscript:msgbox(1))',
      ].join('\n\n'),
    );
    const root = wrapper.element as HTMLElement;
    expect(root.querySelectorAll('a')).toHaveLength(0);
    expect(root.innerHTML).not.toMatch(/href="(?:javascript|data|file|vbscript)/i);
    // A parsed but unsafe link keeps its text and shows the address, marked as not openable.
    expect(root.querySelectorAll('.md-link-blocked').length).toBeGreaterThanOrEqual(2);
    expect(root.textContent).toContain('/settings/ai');
    expect(root.textContent).toContain('javascript:alert(1)');
    expectOnlySafeMarkup(wrapper);
  });

  it('shows http(s)/mailto links as text + address + a separate open link with noopener', () => {
    const wrapper = render('[학술 DB](https://library.example.org/guide?x=1&y=2) · [메일](mailto:me@example.org) · <https://auto.example.org/p>');
    const anchors = [...(wrapper.element as HTMLElement).querySelectorAll('a')];
    expect(anchors.map((anchor) => anchor.getAttribute('href'))).toEqual([
      'https://library.example.org/guide?x=1&y=2',
      'mailto:me@example.org',
      'https://auto.example.org/p',
    ]);
    for (const anchor of anchors) {
      expect(anchor.getAttribute('rel')).toBe('noopener noreferrer nofollow');
      expect(anchor.getAttribute('target')).toBe('_blank');
      expect(anchor.getAttribute('referrerpolicy')).toBe('no-referrer');
      expect(anchor.getAttribute('aria-label')).toMatch(/^새 창에서 링크 열기: /);
      expect(anchor.textContent).toContain('열기');
    }
    const text = wrapper.text();
    // The label is plain text, and the address is always visible.
    expect(text).toContain('학술 DB');
    expect(text).toContain('(https://library.example.org/guide?x=1&y=2)');
    // An autolink shows its address once.
    expect(text.match(/https:\/\/auto\.example\.org\/p/g)).toHaveLength(1);
    expect(wrapper.get('.md-link-text').element.tagName).toBe('SPAN');
    expectOnlySafeMarkup(wrapper);
  });

  it('never loads images: a tracking pixel becomes alt text + its address (negative)', () => {
    const wrapper = render('![픽셀](https://tracker.example/p.gif?u=me) ![](data:image/png;base64,iVBORw0KGgo=)');
    const root = wrapper.element as HTMLElement;
    expect(root.querySelector('img, picture, source, [src], [srcset]')).toBeNull();
    const images = root.querySelectorAll('[data-md-image]');
    expect(images).toHaveLength(2);
    expect(images[0]?.textContent).toContain('이미지: 픽셀');
    expect(images[0]?.textContent).toContain('(https://tracker.example/p.gif?u=me)');
    expect(images[0]?.textContent).toContain('불러오지 않음');
    expect(images[1]?.textContent).toContain('이미지');
    expect(images[1]?.textContent).toContain('data:image/png');
    expectOnlySafeMarkup(wrapper);
  });

  it('renders nested emphasis as nested elements', () => {
    const wrapper = render('***굵고 기울임*** 그리고 **바깥 _안쪽 `코드`_ 끝** ~~취소~~');
    const root = wrapper.element as HTMLElement;
    expect(root.querySelector('em strong, strong em')?.textContent).toBe('굵고 기울임');
    expect(root.querySelector('strong em code')?.textContent).toBe('코드');
    expect(root.querySelector('s')?.textContent).toBe('취소');
    expectOnlySafeMarkup(wrapper);
  });

  it('renders a 65,536-character note without loss or unsafe markup', () => {
    const line = '- 항목 **굵게** [링크](https://example.org/x) <b>태그</b> ![p](https://t.example/p.gif)\n';
    let source = '# 긴 노트\n\n';
    while (Array.from(source).length + Array.from(line).length <= 65_536) source += line;
    source += 'x'.repeat(65_536 - Array.from(source).length);
    expect(Array.from(source)).toHaveLength(65_536);
    const started = performance.now();
    const wrapper = render(source);
    expect(performance.now() - started).toBeLessThan(10_000);
    const root = wrapper.element as HTMLElement;
    expect(root.querySelectorAll('li').length).toBeGreaterThan(500);
    expect(root.querySelector('img, b')).toBeNull();
    expect(root.textContent).toContain('<b>태그</b>');
    expectOnlySafeMarkup(wrapper);
  });

  it('survives pathological nesting without losing text, and shows an empty state for blank input', () => {
    // markdown-it drops whatever lies past its nesting limit; the preview falls back to the raw text.
    const deep = render(`${'>'.repeat(200)} 깊은 인용 <script>x</script>\n\n${'*'.repeat(500)}`);
    expect(deep.text()).toContain('깊은 인용 <script>x</script>');
    expect(deep.text()).toContain('서식 없이 원문 그대로');
    expect(deep.find('pre.md-plain').exists()).toBe(true);
    expectOnlySafeMarkup(deep);
    const fine = render(`${'>'.repeat(40)} 덜 깊은 인용`);
    expect(fine.find('pre.md-plain').exists()).toBe(false);
    expect(fine.findAll('blockquote')).toHaveLength(40);
    const blank = render('   \n  ');
    expect(blank.text()).toBe('아직 내용이 없어요.');
  });
});

describe('markdown helpers', () => {
  it('accepts only absolute http(s) and mailto addresses (negative cases included)', () => {
    expect(safeExternalHref('https://a.example/x')).toBe('https://a.example/x');
    expect(safeExternalHref('mailto:a@b.example')).toBe('mailto:a@b.example');
    for (const bad of ['javascript:alert(1)', ' JAVASCRIPT:x', 'data:text/html,x', '/relative', '//evil.example', 'ftp://x', '', null, undefined]) {
      expect(safeExternalHref(bad)).toBeNull();
    }
  });

  it('summarises Markdown as plain text for list rows', () => {
    expect(plainSummary('# 제목\n\n- **굵게** [링크](https://x.example) ![p](https://p.example/p.gif)\n<b>태그</b>')).toBe(
      '제목 굵게 링크 p 태그',
    );
    expect(plainSummary('가'.repeat(200), 10)).toBe(`${'가'.repeat(10)}…`);
  });
});
