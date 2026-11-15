<script setup lang="ts">
import { computed } from 'vue';
import type { Today } from '../../api';
import TrendChart from '../charts/TrendChart.vue';
import GlassOrb from '../ui/GlassOrb.vue';
import UiIcon from '../ui/UiIcon.vue';
import { useEstimationProfile, usePendingReplans } from '../../composables/useOverview';
import { ESTIMATE_MIN_SAMPLES, estimateTrend, personalEstimate } from '../../domain/overview';
import { t, tp } from '../../i18n';
import { formatNumber } from '../../i18n/format';
import { reasonShort } from '../../i18n/replan';
import { riskReasonText } from '../../i18n/server';
import { useLlmConsentStore } from '../../stores/llmConsent';
import { useOfflineStore } from '../../stores/offline';
import OverviewCard from './OverviewCard.vue';

/**
 * AI 도우미: what the AI layer knows right now, in words and one number at a
 * time — the personal estimate from 내 패턴 (only once there are enough
 * records), replan proposals waiting for an answer, and how risky today's
 * plan is. Without AI consent the card says so and points to AI 설정.
 */
const TREND_POINTS = 8;

const props = defineProps<{
  /** Today's plan (its risk); null while it loads or after it failed. */
  plan: Today | null;
}>();

const consent = useLlmConsentStore();
const offline = useOfflineStore();
const profile = useEstimationProfile();
const replans = usePendingReplans();

const estimate = computed(() => (profile.data.value === undefined ? null : personalEstimate(profile.data.value.items)));
const trend = computed(() => (profile.data.value === undefined ? [] : estimateTrend(profile.data.value.items, TREND_POINTS)));
const ratioValue = computed(() => (estimate.value === null ? '' : formatNumber(estimate.value.ratio, 1)));

const pending = computed(() => replans.data.value?.items ?? []);
const newest = computed(
  () => [...pending.value].sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0] ?? null,
);
const replanTarget = computed(() =>
  pending.value.length === 1 && newest.value !== null ? `/replan/${newest.value.id}` : '/replan',
);

const riskTitles = computed(() => new Map((props.plan?.blocks ?? []).map((block) => [block.taskId, block.title])));
const riskReason = computed(() => {
  const first = props.plan?.risk.reasons[0];
  return first === undefined ? null : riskReasonText(first, (taskId) => riskTitles.value.get(taskId));
});

const state = computed(() => {
  if (consent.needed) return 'ready' as const;
  if (profile.isLoading.value) return 'loading' as const;
  if (profile.isError.value) return 'error' as const;
  return 'ready' as const;
});
</script>

<template>
  <OverviewCard
    widget="ai"
    icon="plan"
    :title="t('overview.ai.title')"
    :to="consent.needed ? null : '/replan'"
    :open-label="t('overview.ai.open')"
    :state="state"
    @retry="profile.refetch()"
  >
    <template #skeleton>
      <span class="skeleton skeleton--circle overview-skeleton-orb"></span>
      <span class="skeleton overview-skeleton-number"></span>
      <span v-for="row in 2" :key="row" class="skeleton skeleton--text overview-skeleton-row"></span>
    </template>

    <div class="ai-visual">
      <GlassOrb :size="168" />
    </div>

    <div v-if="consent.needed" class="ai-panel glass glass--flat ai-consent" data-ai-consent>
      <p class="ai-consent-title">{{ t('overview.ai.consentTitle') }}</p>
      <p class="ai-consent-body">{{ t('overview.ai.consentBody') }}</p>
      <RouterLink class="btn btn--secondary btn--sm" to="/settings/ai">{{ t('overview.ai.consentLink') }}</RouterLink>
    </div>

    <template v-else>
      <div class="ai-panel glass glass--flat ai-estimate" :data-estimate="estimate ? 'ready' : 'cold'">
        <template v-if="estimate">
          <p class="numeral ai-ratio" data-ratio>
            {{ ratioValue }}<span class="numeral-unit">{{ t('overview.ai.ratioUnit') }}</span>
          </p>
          <p class="overview-figure-label">
            {{ t('overview.ai.ratioCaption', { value: ratioValue }) }}
            <span class="overview-figure-range">{{ tp('overview.ai.samples', estimate.samples) }}</span>
          </p>
          <TrendChart
            v-if="trend.length > 1"
            class="ai-trend"
            :values="trend"
            :reference="1"
            :summary="tp('overview.ai.trendSummary', trend.length)"
          />
        </template>
        <template v-else>
          <p class="ai-cold-title">{{ t('overview.ai.notEnough') }}</p>
          <p class="ai-cold-body">{{ tp('overview.ai.notEnoughBody', ESTIMATE_MIN_SAMPLES) }}</p>
        </template>
        <RouterLink class="ai-link" to="/insights">{{ t('overview.ai.insightsLink') }}</RouterLink>
      </div>

      <ul class="ai-facts">
        <li class="ai-fact" data-ai-replan>
          <UiIcon name="reschedule" :size="18" class="ai-fact-icon" />
          <div class="ai-fact-text">
            <template v-if="!offline.online && replans.data.value === undefined">
              <p class="ai-fact-title">{{ t('overview.ai.replanOffline') }}</p>
            </template>
            <template v-else-if="pending.length > 0 && newest">
              <p class="ai-fact-title">{{ tp('overview.ai.replanPending', pending.length) }}</p>
              <p class="ai-fact-note">{{ reasonShort(newest.trigger.reason) }}</p>
            </template>
            <p v-else class="ai-fact-title">{{ t('overview.ai.replanNone') }}</p>
          </div>
          <RouterLink v-if="pending.length > 0" class="btn btn--secondary btn--sm" :to="replanTarget">
            {{ t('overview.ai.replanLink') }}
          </RouterLink>
        </li>
        <li class="ai-fact" :data-ai-risk="plan ? plan.risk.level : 'unknown'">
          <UiIcon name="shield" :size="18" class="ai-fact-icon" />
          <div class="ai-fact-text">
            <template v-if="plan">
              <p class="ai-fact-title">{{ t('overview.ai.risk', { level: t(`risk.level.${plan.risk.level}`) }) }}</p>
              <p v-if="riskReason" class="ai-fact-note" :lang="riskReason.translated ? undefined : 'en'">
                {{ riskReason.text }}
              </p>
            </template>
            <p v-else class="ai-fact-title">{{ t('overview.ai.riskUnknown') }}</p>
          </div>
        </li>
      </ul>
    </template>
  </OverviewCard>
</template>
