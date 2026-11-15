<script setup lang="ts">
import type { CandidateDifference, CandidateFigures, CandidateLead, CandidateRisk } from '../../domain/planDraft';
import { t, tp } from '../../i18n';
import {
  formatCivilMonthDay,
  formatCivilWeekday,
  formatDuration,
  formatHoursAndMinutes,
  formatPercent,
  formatSignedDuration,
} from '../../i18n/format';
import type { ServerText } from '../../i18n/server';
import LoadStrip from '../charts/LoadStrip.vue';
import UiBadge from '../ui/UiBadge.vue';
import UiIcon from '../ui/UiIcon.vue';
import type { IconName } from '../ui/icons';

/**
 * 일정안 (HOLO-03A): the candidates side by side, one of them picked. Each
 * card says its way of laying the work out in one sentence, the day it ends
 * as its one big number, the shape of its load as a strip of bars (all strips
 * on one scale, so they compare), three figures, and how risky it is in
 * words. A card that is not picked also says how it differs from the one
 * that is.
 *
 * It is a radio group: one native radio per card (arrows move the choice),
 * named by the card's title and described by its summary and figures. A press
 * anywhere on a card picks it.
 */
export interface CandidateCard {
  readonly id: string;
  readonly policy: string;
  readonly label: string;
  readonly summary: string | null;
  readonly figures: CandidateFigures;
  readonly risk: CandidateRisk;
  readonly lead: CandidateLead | null;
  /** Minutes on each day of the strip. */
  readonly load: readonly number[];
  /** How it differs from the picked one; null for the picked one. */
  readonly difference: CandidateDifference | null;
  /** The scheduler's note on how different the candidates are. */
  readonly note: ServerText | null;
}

const props = withDefaults(
  defineProps<{
    cards: readonly CandidateCard[];
    selectedId: string | null;
    /** First and last day of the strip (`YYYY-MM-DD`). */
    stripFrom: string | null;
    stripTo: string | null;
    /** The value that fills a strip's height: the heaviest day of any candidate. */
    loadMax: number;
    disabled?: boolean;
  }>(),
  { disabled: false },
);
const emit = defineEmits<{ select: [id: string] }>();

const RISK_ICONS: Record<CandidateRisk, IconName> = { ok: 'check-circle', tight: 'info', late: 'warn', unplaced: 'error' };

function pick(card: CandidateCard): void {
  if (props.disabled || card.id === props.selectedId) return;
  emit('select', card.id);
}

function riskText(card: CandidateCard): string {
  const figures = card.figures;
  if (card.risk === 'unplaced') {
    return figures.deficitMin > 0
      ? t('planSchedule.risk.unplaced', { duration: formatDuration(figures.deficitMin) })
      : t('planSchedule.risk.unplacedUnknown');
  }
  if (card.risk === 'late') return t('planSchedule.risk.late', { duration: formatDuration(Math.abs(figures.minSlackMin)) });
  if (card.risk === 'tight') return t('planSchedule.risk.tight', { percent: formatPercent(figures.p90Coverage, 0) });
  return t('planSchedule.risk.ok');
}

function loadSummary(card: CandidateCard): string {
  const max = Math.max(0, ...card.load);
  if (max <= 0 || props.stripFrom === null || props.stripTo === null) return t('planSchedule.loadNone');
  return t('planSchedule.loadSummary', {
    from: formatCivilMonthDay(props.stripFrom),
    to: formatCivilMonthDay(props.stripTo),
    max: formatHoursAndMinutes(max),
  });
}

/** `고른 안보다 2일 늦게 끝나요 · 하루 최대 30분 짧아요`. */
function differenceText(difference: CandidateDifference): string {
  const parts: string[] = [];
  if (difference.finishDays !== null) {
    if (difference.finishDays > 0) parts.push(tp('planSchedule.difference.later', difference.finishDays));
    else if (difference.finishDays < 0) parts.push(tp('planSchedule.difference.earlier', Math.abs(difference.finishDays)));
    else parts.push(t('planSchedule.difference.sameDay'));
  }
  if (difference.maxDailyLoadMin > 0) {
    parts.push(t('planSchedule.difference.heavier', { duration: formatDuration(difference.maxDailyLoadMin) }));
  } else if (difference.maxDailyLoadMin < 0) {
    parts.push(t('planSchedule.difference.lighter', { duration: formatDuration(Math.abs(difference.maxDailyLoadMin)) }));
  } else {
    parts.push(t('planSchedule.difference.sameLoad'));
  }
  return `${t('planSchedule.difference.lead')} ${parts.join(' · ')}`;
}
</script>

<template>
  <div class="plan-options" role="radiogroup" :aria-label="t('planSchedule.options')" data-plan-options>
    <div
      v-for="card in cards"
      :key="card.id"
      class="plan-option"
      :class="{
        'plan-option--selected': card.id === selectedId,
        'plan-option--unplaced': card.risk === 'unplaced',
        'plan-option--disabled': disabled,
      }"
      :data-candidate="card.id"
      :data-policy="card.policy"
      :data-risk="card.risk"
      @click="pick(card)"
    >
      <header class="plan-option-head">
        <input
          :id="`plan-option-${card.id}`"
          type="radio"
          name="plan-option"
          class="plan-option-radio"
          :value="card.id"
          :checked="card.id === selectedId"
          :disabled="disabled"
          :aria-describedby="`plan-option-${card.id}-summary plan-option-${card.id}-figures plan-option-${card.id}-risk`"
          @change="emit('select', card.id)"
          @click.stop
        />
        <label class="plan-option-name" :for="`plan-option-${card.id}`" @click.stop>{{ card.label }}</label>
        <UiBadge v-if="card.id === selectedId" tone="accent" class="plan-option-picked" data-option-picked>
          {{ t('planSchedule.optionSelected') }}
        </UiBadge>
        <UiBadge v-else-if="card.lead" tone="outline" data-option-lead>{{ t(`planSchedule.lead.${card.lead}`) }}</UiBadge>
      </header>

      <p v-if="card.summary" :id="`plan-option-${card.id}-summary`" class="plan-option-summary">{{ card.summary }}</p>

      <div :id="`plan-option-${card.id}-figures`" class="plan-option-figures">
        <p class="plan-option-finish" data-option-finish>
          <span class="plan-option-label">{{ t('planSchedule.finish') }}</span>
          <span v-if="card.figures.finishDate" class="plan-option-number">
            <span class="numeral">{{ formatCivilMonthDay(card.figures.finishDate) }}</span>
            <span class="numeral-unit">({{ formatCivilWeekday(card.figures.finishDate) }})</span>
          </span>
          <span v-else class="plan-option-number plan-option-number--none">{{ t('planSchedule.finishNone') }}</span>
        </p>

        <div class="plan-option-load">
          <LoadStrip
            :class="{ 'load-strip--lead': card.id === selectedId }"
            :values="card.load"
            :max="loadMax"
            :summary="`${t('planSchedule.load')}: ${loadSummary(card)}`"
          />
          <p class="plan-option-load-note tabular" aria-hidden="true">{{ tp('planSchedule.daysUsed', card.figures.days) }}</p>
        </div>

        <dl class="plan-option-stats">
          <div class="stat" data-option-stat="slack">
            <dt>{{ t('planSchedule.slack') }}</dt>
            <dd class="tabular">{{ formatSignedDuration(card.figures.minSlackMin) }}</dd>
          </div>
          <div class="stat" data-option-stat="dailyMax">
            <dt>{{ t('planSchedule.dailyMax') }}</dt>
            <dd class="tabular">{{ formatHoursAndMinutes(card.figures.maxDailyLoadMin) }}</dd>
          </div>
          <div class="stat" data-option-stat="switches">
            <dt>{{ t('planSchedule.switches') }}</dt>
            <dd class="tabular">{{ tp('planSchedule.switchesValue', card.figures.contextSwitches) }}</dd>
          </div>
        </dl>
      </div>

      <p :id="`plan-option-${card.id}-risk`" class="plan-option-risk" :class="`plan-option-risk--${card.risk}`" data-option-risk>
        <UiIcon :name="RISK_ICONS[card.risk]" :size="16" />
        <span>{{ riskText(card) }}</span>
      </p>
      <p v-if="card.difference" class="plan-option-diff" data-option-diff>{{ differenceText(card.difference) }}</p>
      <p v-if="card.note" class="plan-option-note" :lang="card.note.translated ? undefined : 'en'" data-option-note>
        {{ card.note.text }}
      </p>
    </div>
  </div>
</template>
