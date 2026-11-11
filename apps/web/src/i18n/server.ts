import type { IntakeField } from '../api';
import { formatDuration, formatPercent } from './format';
import { t, type PlainKey } from './index';

/**
 * Korean text for codes and fixed strings that the server sends inside
 * otherwise free-form fields (Today risk reasons, type-detection reasons,
 * conservative intake assumptions, plan block errors, plan diversity notes).
 * Unknown values are returned unchanged with `translated: false`, so callers
 * can mark them `lang="en"` instead of hiding information.
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
  [/outside the (?:persisted )?plan horizon/i, 'plan.blockMessage.outsideHorizon'],
  [/ends before it starts/i, 'plan.blockMessage.endsBeforeStart'],
  [/invalid block instant/i, 'plan.blockMessage.invalidInstant'],
  [/minute precision/i, 'plan.blockMessage.minutePrecision'],
  [/outside the persisted plan/i, 'plan.blockMessage.outsidePlan'],
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
    return ko(t('plan.diversity.dropped', { kept: dropped[1] ?? '', total: dropped[2] ?? '', dropped: dropped[3] ?? '' }));
  }
  const distinct = /^(\d+) distinct plans from (\d+) policy candidates \(pairwise distance >= [\d.]+\)\.$/.exec(trimmed);
  if (distinct !== null) return ko(t('plan.diversity.distinct', { total: distinct[2] ?? '' }));
  // Unknown wording, or a note with appended replan-bound details: keep the original.
  return raw(note);
}
