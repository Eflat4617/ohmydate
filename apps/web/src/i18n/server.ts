import type { IntakeField } from '../api';
import { formatDuration, formatPercent } from './format';
import { intlLocale, t, type PlainKey } from './index';

/**
 * Korean text for codes and fixed strings that the server sends inside
 * otherwise free-form fields (Today risk reasons, type-detection reasons,
 * conservative intake assumptions, plan block errors, plan diversity notes).
 * Unknown values are returned unchanged with `translated: false`, so callers
 * can mark them `lang="en"` instead of hiding information. Type-detection
 * reasons also carry the AI's own wording in the owner's language (FU-89), so
 * they take their `lang` from `detectionReasonLang` instead (FU-91).
 */

export interface ServerText {
  readonly text: string;
  readonly translated: boolean;
}

const raw = (text: string): ServerText => ({ text, translated: false });
const ko = (text: string): ServerText => ({ text, translated: true });

export function riskReasonText(
  reason: string,
  taskTitle: (taskId: string) => string | undefined = () => undefined,
): ServerText {
  const [code, value = ''] = reason.split(':', 2);
  switch (code) {
    case 'task_overdue': {
      const title = taskTitle(value);
      return ko(title === undefined ? t('risk.reason.taskOverdue') : t('risk.reason.taskOverdueNamed', { title }));
    }
    case 'negative_slack': {
      const minutes = Number(value);
      if (!Number.isFinite(minutes)) break;
      return ko(t('risk.reason.negativeSlack', { duration: formatDuration(Math.abs(minutes)) }));
    }
    case 'daily_focus_cap_exceeded': {
      const minutes = Number(value);
      if (!Number.isFinite(minutes)) break;
      return ko(t('risk.reason.dailyCapExceeded', { duration: formatDuration(minutes) }));
    }
    default:
      break;
  }
  return raw(reason);
}

/** `null` hides internal bookkeeping such as `config:v1`. */
export function detectionReasonText(reason: string): ServerText | null {
  if (reason.startsWith('config:')) return null;
  const numeric = /^(tag_jaccard|text_similarity|false_positive_penalty)=(-?\d+(?:\.\d+)?)$/.exec(reason);
  if (numeric !== null) {
    const percent = formatPercent(Number(numeric[2]), 0);
    if (numeric[1] === 'tag_jaccard') return ko(t('wizard.detection.tagJaccard', { percent }));
    if (numeric[1] === 'text_similarity') return ko(t('wizard.detection.textSimilarity', { percent }));
    return ko(t('wizard.detection.falsePositive', { percent }));
  }
  if (reason.startsWith('template=')) return ko(t('wizard.detection.template', { name: reason.slice(9) }));
  if (reason === 'weak_similarity') return ko(t('wizard.detection.weak'));
  if (reason === 'user_rejected_similarity') return ko(t('wizard.detection.userRejected'));
  if (reason === 'manual_mode') return ko(t('wizard.detection.manualMode'));
  return raw(reason);
}

/** A server code (`no_similar_template`, `some_score=0.5`): snake_case, never prose. */
const LEGACY_CODE = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)+(?:[=:].*)?$/;
const NOT_A_LANGUAGE: ReadonlySet<string> = new Set(['und', 'zxx', 'mul', 'mis']);
/** What the API's resolved tag can look like (`OUTPUT_LANGUAGE_PATTERN`): `ko`, `zh-Hant-TW`, `es-419`. */
const OUTPUT_LANGUAGE = /^[a-z]{2,3}(?:-[A-Z][a-z]{3})?(?:-(?:[A-Z]{2}|[0-9]{3}))?$/;
const LANGUAGE_NAMES = new Intl.DisplayNames(['en'], { type: 'language', fallback: 'none' });

/**
 * The language the AI writes in for this owner, mirroring the API's
 * `resolveOutputLanguage` (services/api/src/application/intake/output-language.ts,
 * FU-89): `language[-Script][-REGION]` of a well-formed locale whose language
 * is known, else Korean (`ko-KR`). `undefined` when that is the UI's own
 * language, so the text simply inherits the page's `lang`.
 */
export function ownerTextLang(locale: string | null | undefined): string | undefined {
  if (typeof locale !== 'string') return undefined;
  const trimmed = locale.trim();
  if (trimmed.length < 2 || trimmed.length > 35) return undefined;
  try {
    const [canonical] = Intl.getCanonicalLocales(trimmed.replaceAll('_', '-'));
    if (canonical === undefined) return undefined;
    const parsed = new Intl.Locale(canonical);
    const language: string | undefined = parsed.language;
    if (language === undefined || language.length === 0 || NOT_A_LANGUAGE.has(language)) return undefined;
    if (LANGUAGE_NAMES.of(language) === undefined) return undefined;
    const tag = [language, parsed.script, parsed.region].filter((part) => part !== undefined).join('-');
    if (!OUTPUT_LANGUAGE.test(tag)) return undefined;
    if (language === new Intl.Locale(intlLocale()).language) return undefined;
    return tag;
  } catch {
    return undefined;
  }
}

/**
 * The `lang` attribute of a type-detection reason (FU-91). Codes this client
 * translates inherit the page language. An untranslated server code is the
 * legacy English fallback and is marked `en`. Anything else is the AI's own
 * wording, which follows the owner's locale (FU-89), so it carries that
 * locale (or nothing when it is the UI language).
 */
export function detectionReasonLang(
  reason: string,
  text: ServerText,
  ownerLocale: string | null | undefined,
): string | undefined {
  if (text.translated) return undefined;
  if (LEGACY_CODE.test(reason)) return 'en';
  return ownerTextLang(ownerLocale);
}

/**
 * Conservative defaults the intake agent records as assumptions
 * (`CONSERVATIVE_DEFAULTS` in packages/domain). Other values are what the
 * user typed and are shown as-is.
 */
const ASSUMPTION_VALUES: Readonly<Record<string, PlainKey>> = {
  'unspecified deliverable (confirm before scheduling)': 'wizard.assumptionValues.unspecifiedDeliverable',
  'no deadline assumed': 'wizard.assumptionValues.noDeadline',
  'use the P90 estimate': 'wizard.assumptionValues.useP90',
  'not confirmed (manual check before approval)': 'wizard.assumptionValues.notConfirmed',
  'none assumed': 'wizard.assumptionValues.noneAssumed',
};

export function assumptionValueText(field: IntakeField, value: string): ServerText {
  const key = ASSUMPTION_VALUES[value];
  if (key !== undefined) return ko(t(key));
  if (field === 'maxFocusMinutes' && /^\d+$/.test(value)) return ko(formatDuration(Number(value)));
  if (field === 'reviewNeeded' && (value === 'true' || value === 'false')) {
    return ko(t(value === 'true' ? 'wizard.assumptionValues.reviewYes' : 'wizard.assumptionValues.reviewNo'));
  }
  return { text: value, translated: true };
}

const BLOCK_MESSAGES: ReadonlyArray<readonly [RegExp, PlainKey]> = [
  [/outside the (?:persisted )?plan horizon/i, 'planSchedule.blockMessage.outsideHorizon'],
  [/ends before it starts/i, 'planSchedule.blockMessage.endsBeforeStart'],
  [/invalid block instant/i, 'planSchedule.blockMessage.invalidInstant'],
  [/minute precision/i, 'planSchedule.blockMessage.minutePrecision'],
  [/outside the persisted plan/i, 'planSchedule.blockMessage.outsidePlan'],
];

export function blockErrorText(message: string): ServerText {
  for (const [pattern, key] of BLOCK_MESSAGES) {
    if (pattern.test(message)) return ko(t(key));
  }
  return raw(message);
}

export function diversityNoteText(note: string): ServerText {
  const trimmed = note.trim();
  const dropped =
    /^(\d+) distinct plan\(s\) from (\d+) policy candidate\(s\); (\d+) candidate\(s\) dropped as too similar \(distance < [\d.]+\)\.$/.exec(
      trimmed,
    );
  if (dropped !== null) {
    return ko(t('planSchedule.diversity.dropped', { kept: dropped[1] ?? '', total: dropped[2] ?? '', dropped: dropped[3] ?? '' }));
  }
  const distinct = /^(\d+) distinct plans from (\d+) policy candidates \(pairwise distance >= [\d.]+\)\.$/.exec(trimmed);
  if (distinct !== null) return ko(t('planSchedule.diversity.distinct', { total: distinct[2] ?? '' }));
  // Unknown wording, or a note with appended replan-bound details: keep the original.
  return raw(note);
}
