import { parse } from 'vue/compiler-sfc';
import type { IntakeField, Notification, PlanCandidate, PlanVersion, ScheduleBlock, SessionReviewRequest, Task, Today, Violation } from '../src/api';
import { PROBLEM_CODE_LIST, type ApiErrorCode } from '../src/api/errors';
import {
  DEFAULT_LOCALE,
  INTL_LOCALES,
  availableLocales,
  interpolate,
  isPluralMessage,
  ko,
  locale,
  lookup,
  plural,
  selectPluralForm,
  setLocale,
  t,
  tp,
  type MessageKey,
  type Messages,
} from '../src/i18n';
import { problemMessage } from '../src/i18n/problem';
import { assumptionValueText, detectionReasonText, diversityNoteText, riskReasonText } from '../src/i18n/server';
import {
  CONSERVATIVE_DEFAULTS,
  QUESTION_PROMPTS,
} from '../../../packages/domain/src/index.js';

const HANGUL = /[가-힣]/;
const PLACEHOLDER = /\{(\w+)\}/g;

type Leaf = { path: string; value: string };

function leaves(node: unknown, path: string[] = []): Leaf[] {
  if (typeof node === 'string') return [{ path: path.join('.'), value: node }];
  if (isPluralMessage(node)) {
    return Object.entries(node).map(([form, value]) => ({ path: [...path, form].join('.'), value: String(value) }));
  }
  return Object.entries(node as Record<string, unknown>).flatMap(([key, child]) => leaves(child, [...path, key]));
}

describe('message catalog (ko)', () => {
  it('is the default locale, maps to ko-KR for Intl and needs no runtime fetch', () => {
    expect(DEFAULT_LOCALE).toBe('ko');
    expect(availableLocales()).toEqual(['ko']);
    expect(INTL_LOCALES.ko).toBe('ko-KR');
    expect(locale.value).toBe('ko');
  });

  it('has a non-empty value for every key and only well-formed {placeholders}', () => {
    const all = leaves(ko);
    expect(all.length).toBeGreaterThan(300);
    for (const { path, value } of all) {
      if (path === 'duration.separator') {
        expect(value).toBe(' ');
        continue;
      }
      expect(value.trim().length, path).toBeGreaterThan(0);
      const stripped = value.replace(PLACEHOLDER, '');
      expect(stripped.includes('{') || stripped.includes('}'), `${path}: unbalanced brace in "${value}"`).toBe(false);
    }
  });

  it('writes user-facing copy in Korean (every leaf has Hangul unless it is a name or format)', () => {
    const allowedNonKorean = new Set([
      'app.name',
      'llm.providerName',
      'llm.modelId',
      'duration.separator',
      'review.count',
      'format.dateWithWeekday',
      'format.dateTime',
      'format.timeRange',
      'format.dateRange',
      'calendar.blockLabel',
      'notifications.meta',
      'plan.blockError',
      'availability.riskP50',
      'availability.riskP90',
      'wizard.p50',
      'wizard.p90',
      'metrics.p90CoverageRatio',
      'llm.disclosure.providerValue',
      'commitments.hiddenTitle',
      'sync.keptOnDevice',
      'focus.sessionBlock',
      'wizard.llmCode',
      'wizard.refreshedAfterConflict',
      'toast.dismiss',
    ]);
    const english = leaves(ko).filter(
      ({ path, value }) => !allowedNonKorean.has(path) && !HANGUL.test(value.replace(PLACEHOLDER, '')),
    );
    expect(english).toEqual([]);
  });

  it('marks plural messages and resolves them through Intl.PluralRules', () => {
    expect(isPluralMessage(ko.inbox.openCount)).toBe(true);
    expect(tp('inbox.openCount', 1)).toBe('열린 작업 1개');
    expect(tp('inbox.openCount', 12)).toBe('열린 작업 12개');
    // A future locale with English-style categories picks `one` for 1 and `other` otherwise.
    const english = plural({ one: '{count} task', other: '{count} tasks', zero: 'No tasks' });
    expect(selectPluralForm(english, 1, 'en-US')).toBe('{count} task');
    expect(selectPluralForm(english, 2, 'en-US')).toBe('{count} tasks');
    expect(selectPluralForm(english, 0, 'en-US')).toBe('No tasks');
    // Korean has no plural forms: `one` is never selected.
    expect(selectPluralForm(english, 1, 'ko-KR')).toBe('{count} tasks');
  });

  it('interpolates typed params and leaves unknown keys visible (negative)', () => {
    expect(t('today.slackChip', { duration: '3시간 20분' })).toBe('여유 3시간 20분');
    expect(interpolate('{a} · {b}', { a: 1 })).toBe('1 · {b}');
    // @ts-expect-error — a key that is not in the catalog is a typecheck error…
    expect(t('nav.doesNotExist')).toBe('nav.doesNotExist');
    // @ts-expect-error — …and so is a missing placeholder value.
    expect(t('today.slackChip')).toBe('여유 {duration}');
    expect(lookup('nav')).toBeUndefined();
  });

  it('types any other locale against the Korean key tree', () => {
    // A complete locale type-checks: here the Korean tree itself.
    const complete: Messages = ko;
    expect(complete.nav.today).toBe('오늘');
    // @ts-expect-error — a locale that misses keys is rejected by the typecheck.
    const partial: Messages = { app: { name: 'OhMyDate', loading: '…', skipToContent: 'Skip' } };
    expect(partial.app.name).toBe('OhMyDate');
  });

  it('sets the document language with the locale and ships index.html as lang="ko"', async () => {
    document.documentElement.lang = 'en';
    setLocale('ko');
    expect(document.documentElement.lang).toBe('ko');
    const html = (await import('../index.html?raw')).default;
    expect(html).toMatch(/<html lang="ko">/);
  });
});

describe('catalog coverage of contract enums', () => {
  function expectKorean(key: MessageKey): void {
    const value = lookup(key);
    expect(typeof value, key).toBe('string');
    expect(value, key).not.toBe(key);
    expect(HANGUL.test(String(value)), `${key} → ${String(value)}`).toBe(true);
  }

  it('has a Korean message for every problem code in the exhaustive map, plus unknown', () => {
    const codes: ApiErrorCode[] = [...PROBLEM_CODE_LIST, 'unknown'];
    expect(PROBLEM_CODE_LIST.length).toBe(19);
    for (const code of codes) {
      expect(HANGUL.test(problemMessage(code)), code).toBe(true);
      expectKorean(`problem.${code}`);
    }
    expect(Object.keys(ko.problem).sort()).toEqual([...codes].sort());
  });

  it('covers notification kinds, states and channels', () => {
    const kinds = {
      due_soon: true,
      deadline_risk: true,
      schedule_conflict: true,
      session_reminder: true,
      daily_summary: true,
      replan_proposal: true,
    } satisfies Record<Notification['kind'], true>;
    const states = { scheduled: true, sent: true, dismissed: true, failed: true, expired: true } satisfies Record<
      Notification['state'],
      true
    >;
    const channels = { in_app: true, push: true } satisfies Record<Notification['channel'], true>;
    for (const kind of Object.keys(kinds) as Notification['kind'][]) expectKorean(`notifications.kind.${kind}`);
    for (const state of Object.keys(states) as Notification['state'][]) expectKorean(`notifications.state.${state}`);
    for (const channel of Object.keys(channels) as Notification['channel'][]) {
      expectKorean(`notifications.channel.${channel}`);
    }
  });

  it('covers violations, policies, block statuses, plan authors and risk levels', () => {
    const violations = { H1: true, H2: true, H3: true, H4: true, H5: true, H6: true, H7: true, H8: true } satisfies Record<
      Violation['code'],
      true
    >;
    const policies = { front_loaded: true, balanced: true, focus_blocked: true } satisfies Record<
      PlanCandidate['policy'],
      true
    >;
    const statuses = { planned: true, done: true, skipped: true, moved: true, superseded: true } satisfies Record<
      ScheduleBlock['status'],
      true
    >;
    const authors = { user: true, replan: true } satisfies Record<PlanVersion['createdBy'], true>;
    const levels = { low: true, medium: true, high: true } satisfies Record<Today['risk']['level'], true>;
    for (const code of Object.keys(violations) as Violation['code'][]) expectKorean(`violation.${code}`);
    for (const policy of Object.keys(policies) as PlanCandidate['policy'][]) {
      expectKorean(`policy.${policy}.label`);
      expectKorean(`policy.${policy}.summary`);
    }
    for (const status of Object.keys(statuses) as ScheduleBlock['status'][]) expectKorean(`plan.blockStatus.${status}`);
    for (const author of Object.keys(authors) as PlanVersion['createdBy'][]) expectKorean(`plan.createdBy.${author}`);
    for (const level of Object.keys(levels) as Today['risk']['level'][]) expectKorean(`risk.level.${level}`);
  });

  it('covers task statuses and session review chips, outcomes and feedback quality', () => {
    const taskStatuses = { todo: true, in_progress: true, done: true } satisfies Record<Task['status'], true>;
    const reasons = {
      focus_lost: true,
      interrupted: true,
      task_larger: true,
      task_smaller: true,
      blocked_dependency: true,
      low_energy: true,
      other: true,
    } satisfies Record<SessionReviewRequest['reasonChips'][number], true>;
    const outcomes = { done: true, partial: true, blocked: true } satisfies Record<SessionReviewRequest['outcome'], true>;
    for (const status of Object.keys(taskStatuses) as Task['status'][]) expectKorean(`task.status.${status}`);
    for (const reason of Object.keys(reasons) as SessionReviewRequest['reasonChips'][number][]) {
      expectKorean(`review.reasons.${reason}`);
    }
    for (const outcome of Object.keys(outcomes) as SessionReviewRequest['outcome'][]) {
      expectKorean(`review.outcomes.${outcome}`);
    }
    for (const quality of ['ok', 'outlier', 'excluded'] as const) expectKorean(`review.quality.${quality}`);
  });

  it('asks every intake question in Korean and labels every intake field', () => {
    const fields = Object.keys(QUESTION_PROMPTS) as IntakeField[];
    expect(Object.keys(ko.wizard.questions).sort()).toEqual([...fields].sort());
    expect(Object.keys(ko.wizard.fields).sort()).toEqual([...fields].sort());
    for (const field of fields) {
      expectKorean(`wizard.questions.${field}`);
      expectKorean(`wizard.fields.${field}`);
    }
  });
});

describe('server codes shown on Korean screens', () => {
  it('translates every conservative intake default the agent records as an assumption', () => {
    for (const [field, value] of Object.entries(CONSERVATIVE_DEFAULTS) as [IntakeField, string][]) {
      const text = assumptionValueText(field, value);
      expect(text.translated, `${field}=${value}`).toBe(true);
      expect(/[A-Za-z]{3,}/.test(text.text.replace(/P90/g, '')), `${field}=${value} → ${text.text}`).toBe(false);
    }
    expect(assumptionValueText('maxFocusMinutes', '60').text).toBe('1시간');
    expect(assumptionValueText('reviewNeeded', 'true').text).toBe('필요함');
    // A value the user typed is shown as-is.
    expect(assumptionValueText('deliverable', '최종 보고서').text).toBe('최종 보고서');
  });

  it('turns Today risk reason codes into sentences and keeps unknown ones raw', () => {
    expect(riskReasonText('negative_slack:-35').text).toBe('마감까지 시간이 35분 모자라요');
    expect(riskReasonText('daily_focus_cap_exceeded:310').text).toBe('남은 계획이 하루 집중 한도를 넘어요 (5시간 10분)');
    expect(riskReasonText('task_overdue:t1', (id) => (id === 't1' ? '보고서' : undefined)).text).toBe(
      '“보고서”의 마감이 지났어요',
    );
    expect(riskReasonText('task_overdue:t2').text).toBe('마감이 지난 작업이 있어요');
    expect(riskReasonText('negative_slack:abc')).toEqual({ text: 'negative_slack:abc', translated: false });
    expect(riskReasonText('Something new')).toEqual({ text: 'Something new', translated: false });
  });

  it('turns type-detection reasons into Korean and hides internal config tags', () => {
    expect(detectionReasonText('config:v1')).toBeNull();
    expect(detectionReasonText('tag_jaccard=0.500')?.text).toBe('이름 일치도 50%');
    expect(detectionReasonText('text_similarity=0.333')?.text).toBe('내용 유사도 33%');
    expect(detectionReasonText('template=보고서 작성')?.text).toBe('비교한 유형: 보고서 작성');
    expect(detectionReasonText('weak_similarity')?.text).toBe('비슷한 정도가 약해요');
    expect(detectionReasonText('user_rejected_similarity')?.text).toBe('다른 유형으로 고르셨어요');
    expect(detectionReasonText('태그: 보고서')).toEqual({ text: '태그: 보고서', translated: false });
  });

  it('translates the scheduler diversity notes it knows and keeps others raw', () => {
    expect(
      diversityNoteText('2 distinct plan(s) from 3 policy candidate(s); 1 candidate(s) dropped as too similar (distance < 0.15).')
        .text,
    ).toBe('서로 다른 일정안 2개를 남겼어요. 후보 3개 중 1개는 너무 비슷해서 뺐어요.');
    expect(diversityNoteText('3 distinct plans from 3 policy candidates (pairwise distance >= 0.15).').text).toBe(
      '후보 3개가 모두 서로 충분히 달라요.',
    );
    expect(diversityNoteText('Only two distinct plans are possible.')).toEqual({
      text: 'Only two distinct plans are possible.',
      translated: false,
    });
  });
});

/**
 * Guard against untranslated copy creeping back in: static template text and
 * copy-carrying attributes of every .vue file must not contain English words,
 * and views/components must not render the server's English problem `detail`.
 */
const vueSources = import.meta.glob('../src/**/*.vue', { query: '?raw', import: 'default', eager: true }) as Record<
  string,
  string
>;
const scriptSources = import.meta.glob(
  [
    '../src/components/**/*.ts',
    '../src/composables/**/*.ts',
    '../src/domain/**/*.ts',
    '../src/notifications/**/*.ts',
    '../src/session/**/*.ts',
    '../src/stores/**/*.ts',
    '../src/i18n/**/*.ts',
    '!../src/i18n/messages/**',
  ],
  { query: '?raw', import: 'default', eager: true },
) as Record<string, string>;

const COPY_ATTRIBUTES = new Set(['aria-label', 'placeholder', 'title', 'label', 'help', 'empty-text', 'alt', 'error']);
// Product names, units and key caps that are not translated.
const ALLOWED_TOKENS = /\b(OhMyDate|RRULE|IANA|USD|P50|P90|GMT|space|enter|Esc|FREQ|WEEKLY|BYDAY|MO|WE)\b/g;
const ENGLISH_WORD = /[A-Za-z]{2,}/;

interface TemplateNode {
  type: number;
  tag?: string;
  content?: string;
  children?: TemplateNode[];
  props?: { type: number; name: string; value?: { content: string } }[];
}

function untranslatedTemplateCopy(file: string, source: string): string[] {
  const template = parse(source, { filename: file }).descriptor.template;
  if (template === null || template.ast === undefined || template.ast === null) return [];
  const found: string[] = [];
  const visit = (node: TemplateNode): void => {
    if (node.type === 1) {
      if (node.tag === 'kbd') return;
      for (const prop of node.props ?? []) {
        if (prop.type === 6 && COPY_ATTRIBUTES.has(prop.name) && prop.value !== undefined) {
          if (ENGLISH_WORD.test(prop.value.content.replace(ALLOWED_TOKENS, ''))) {
            found.push(`${file}: ${prop.name}="${prop.value.content}"`);
          }
        }
      }
    }
    if (node.type === 2 && node.content !== undefined) {
      const text = node.content.trim();
      if (ENGLISH_WORD.test(text.replace(ALLOWED_TOKENS, ''))) found.push(`${file}: "${text}"`);
    }
    for (const child of node.children ?? []) visit(child);
  };
  visit(template.ast as unknown as TemplateNode);
  return found;
}

function scriptPart(file: string, source: string): string {
  if (!file.endsWith('.vue')) return source;
  const { descriptor } = parse(source, { filename: file });
  return [descriptor.script?.content ?? '', descriptor.scriptSetup?.content ?? ''].join('\n');
}

describe('no hard-coded English UI copy', () => {
  it('finds the sources to scan', () => {
    expect(Object.keys(vueSources).length).toBeGreaterThan(30);
    expect(Object.keys(scriptSources).length).toBeGreaterThan(15);
  });

  it('keeps every template text and copy attribute in the catalog', () => {
    const offenders = Object.entries(vueSources).flatMap(([file, source]) => untranslatedTemplateCopy(file, source));
    expect(offenders).toEqual([]);
  });

  it('flags English template copy when it is present (negative)', () => {
    const offenders = untranslatedTemplateCopy(
      'Probe.vue',
      '<template><button aria-label="Close menu">Save <kbd>n</kbd></button><p>OhMyDate · P50</p></template>',
    );
    expect(offenders).toEqual(['Probe.vue: aria-label="Close menu"', 'Probe.vue: "Save"']);
  });

  it('has no English sentences assigned to user-facing state in scripts', () => {
    const sentence = /['"`]([A-Z][a-z]+(?:[ -][A-Za-z’']+)+[.!?…]?)['"`]/g;
    const offenders: string[] = [];
    for (const [file, source] of Object.entries({ ...vueSources, ...scriptSources })) {
      const lines = scriptPart(file, source).split('\n');
      lines.forEach((line, index) => {
        if (/\b(?:Error|RangeError|TypeError|DOMException)\(/.test(line) || /^\s*(?:\/\/|\*)/.test(line)) return;
        for (const match of line.matchAll(sentence)) offenders.push(`${file}:${index + 1}: ${match[1]}`);
      });
    }
    expect(offenders).toEqual([]);
  });

  it('never renders a server problem detail on screen', () => {
    // Negative probe: the pattern does catch the old `cause.detail` usage.
    expect(/\b(?:cause|error|err|problem|failure)\??\.detail\b/.test('error.value = cause.detail;')).toBe(true);
    const offenders = Object.entries(vueSources)
      .filter(([, source]) => /\b(?:cause|error|err|problem|failure)\??\.detail\b/.test(source))
      .map(([file]) => file);
    expect(offenders).toEqual([]);
  });
});
