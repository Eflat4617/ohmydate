import type { DecompositionDraftDto, IntakeInput } from '@ohmydate/contracts';
import { primaryLanguage, type OutputLanguage } from './output-language.js';

/**
 * The manual fallback draft (no LLM consent, LLM unavailable, cancelled or
 * failed run): a fixed prep -> work -> review outline.
 *
 * FU-89: its fixed strings follow the owner's output language: Korean for any
 * `ko*` tag, English otherwise. The only user content is the user's own title
 * (and deliverable) for the work step, copied as typed, never spliced into a
 * template sentence.
 */

export type ManualDraftLanguage = 'ko' | 'en';

export interface ManualDraftText {
  readonly prepTitle: string;
  readonly prepDeliverable: string;
  readonly prepDoneCriteria: string;
  readonly workDoneCriteria: string;
  readonly reviewTitle: string;
  readonly reviewDeliverable: string;
  readonly reviewDoneCriteria: string;
}

/** Korean copy uses the web UI glossary (단계, 결과물, 완료 기준, 검토). */
export const MANUAL_DRAFT_TEXT: Readonly<Record<ManualDraftLanguage, ManualDraftText>> = Object.freeze({
  ko: Object.freeze({
    prepTitle: '작업 환경과 자료 준비하기',
    prepDeliverable: '필요한 자료를 모으고 작업 환경을 갖춤',
    prepDoneCriteria: '필요한 준비물을 모두 갖춤',
    workDoneCriteria: '결과물이 요구 사항에 맞는지 확인함',
    reviewTitle: '완료 기준에 맞춰 검토하기',
    reviewDeliverable: '검토를 마친 결과물',
    reviewDoneCriteria: '검토 의견을 반영하거나 기록함',
  }),
  en: Object.freeze({
    prepTitle: 'Prepare the workspace and inputs',
    prepDeliverable: 'Inputs collected and the workspace is ready',
    prepDoneCriteria: 'Every prerequisite is available',
    workDoneCriteria: 'Deliverable reviewed against the stated requirements',
    reviewTitle: 'Review against done criteria',
    reviewDeliverable: 'Reviewed deliverable',
    reviewDoneCriteria: 'Review notes resolved or recorded',
  }),
});

export function manualDraftLanguage(language: OutputLanguage): ManualDraftLanguage {
  return primaryLanguage(language) === 'ko' ? 'ko' : 'en';
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : value.slice(0, max);
}

function estimateForScope(scope: IntakeInput['estimatedScope']): {
  p50Minutes: number;
  p90Minutes: number;
} {
  switch (scope) {
    case 'small':
      return { p50Minutes: 90, p90Minutes: 150 };
    case 'large':
      return { p50Minutes: 240, p90Minutes: 480 };
    case 'medium':
    default:
      return { p50Minutes: 180, p90Minutes: 300 };
  }
}

export function manualDraft(
  input: IntakeInput,
  assumptions: readonly string[],
  language: OutputLanguage,
): DecompositionDraftDto {
  const text = MANUAL_DRAFT_TEXT[manualDraftLanguage(language)];
  const work = estimateForScope(input.estimatedScope);
  return {
    steps: [
      {
        key: 's1',
        title: text.prepTitle,
        deliverable: text.prepDeliverable,
        doneCriteria: text.prepDoneCriteria,
        kind: 'prep',
        estimate: { p50Minutes: 30, p90Minutes: 60 },
        dependsOn: [],
        splittable: false,
      },
      {
        key: 's2',
        title: truncate(input.title, 120),
        deliverable: truncate(input.deliverable ?? input.title, 300),
        doneCriteria: text.workDoneCriteria,
        kind: 'work',
        estimate: work,
        dependsOn: ['s1'],
        splittable: (input.estimatedScope ?? 'medium') !== 'small',
      },
      {
        key: 's3',
        title: text.reviewTitle,
        deliverable: text.reviewDeliverable,
        doneCriteria: text.reviewDoneCriteria,
        kind: 'review',
        estimate: { p50Minutes: 30, p90Minutes: 60 },
        dependsOn: ['s2'],
        splittable: false,
      },
    ],
    assumptions: [...assumptions],
    questionsRemaining: [],
  };
}
