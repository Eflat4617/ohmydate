import {
  MAX_NOTE_BODY_BYTES,
  MAX_NOTE_BODY_LENGTH,
  MAX_NOTE_TITLE_LENGTH,
  isLinkTargetKind,
  taskDescriptionToMarkdown,
  truncateCodePoints,
  validateNoteContent,
} from '../src/index.js';

describe('validateNoteContent', () => {
  test('accepts a normal Korean/English note', () => {
    expect(validateNoteContent({ title: '논문 메모', bodyMd: '# Heading\n\n본문 text' })).toEqual([]);
  });

  test('skips undefined fields (PATCH semantics)', () => {
    expect(validateNoteContent({})).toEqual([]);
  });

  test('rejects a blank title', () => {
    expect(validateNoteContent({ title: '   ' })).toEqual([
      { path: '/title', message: 'title must not be blank' },
    ]);
  });

  test('rejects an over-long title measured in code points', () => {
    const emoji = '😀'.repeat(MAX_NOTE_TITLE_LENGTH + 1);
    expect(validateNoteContent({ title: emoji }).map((issue) => issue.path)).toEqual(['/title']);
    // Exactly the limit (each emoji is 2 UTF-16 units) is accepted.
    expect(validateNoteContent({ title: '😀'.repeat(MAX_NOTE_TITLE_LENGTH) })).toEqual([]);
  });

  test('rejects an over-long body and NUL characters', () => {
    expect(
      validateNoteContent({ bodyMd: 'a'.repeat(MAX_NOTE_BODY_LENGTH + 1) }).map((issue) => issue.path),
    ).toEqual(['/bodyMd']);
    expect(validateNoteContent({ bodyMd: 'a\u0000b' })).toEqual([
      { path: '/bodyMd', message: 'bodyMd must not contain NUL characters' },
    ]);
    expect(validateNoteContent({ title: 'a\u0000' }).map((issue) => issue.message)).toEqual([
      'title must not contain NUL characters',
    ]);
  });

  test('the code-point limit can never exceed the byte limit', () => {
    // 4-byte code points at the code-point limit are exactly the byte limit.
    expect(MAX_NOTE_BODY_LENGTH * 4).toBe(MAX_NOTE_BODY_BYTES);
    expect(validateNoteContent({ bodyMd: '😀'.repeat(MAX_NOTE_BODY_LENGTH) })).toEqual([]);
  });
});

describe('isLinkTargetKind', () => {
  test('accepts the three planner target kinds only', () => {
    expect(['goal', 'project', 'task'].every((kind) => isLinkTargetKind(kind))).toBe(true);
    expect(isLinkTargetKind('document')).toBe(false);
    expect(isLinkTargetKind(undefined)).toBe(false);
  });
});

describe('truncateCodePoints', () => {
  test('never splits a surrogate pair', () => {
    expect(truncateCodePoints('ab😀cd', 3)).toBe('ab😀');
    expect(truncateCodePoints('abc', 10)).toBe('abc');
    expect(truncateCodePoints('abc', 0)).toBe('');
  });
});

describe('taskDescriptionToMarkdown', () => {
  test('keeps plain text descriptions', () => {
    expect(taskDescriptionToMarkdown('  plain text\nsecond line  ')).toBe('plain text\nsecond line');
  });

  test('converts editor HTML blocks and lists to Markdown text', () => {
    const html = '<h2>목표</h2><p>논문 <strong>5편</strong> 요약</p><ul><li>하나</li><li>둘</li></ul>';
    expect(taskDescriptionToMarkdown(html)).toBe('## 목표\n\n논문 5편 요약\n\n- 하나\n- 둘');
  });

  test('drops script/style content and comments', () => {
    const html = '<p>keep</p><script>alert(1)</script><style>p{}</style><!-- hidden -->after';
    expect(taskDescriptionToMarkdown(html)).toBe('keep\nafter');
  });

  test('never emits a tag, even from nested or entity-encoded input', () => {
    for (const hostile of [
      '<<script>script>alert(1)<</script>/script>',
      '&lt;img src=x onerror=alert(1)&gt;',
      '<img src="x" alt=">"><b>bold',
      '<a href="javascript:alert(1)">link</a>',
      'x < y and <unterminated',
      '&#60;script&#62;',
    ]) {
      const output = taskDescriptionToMarkdown(hostile);
      expect({ hostile, hasTag: output.includes('<') }).toEqual({ hostile, hasTag: false });
    }
    expect(taskDescriptionToMarkdown('a &amp; b')).toBe('a & b');
    expect(taskDescriptionToMarkdown('x < y')).toBe('x &lt; y');
  });
});
