<script setup lang="ts">
import { computed } from 'vue';
import { useQuery } from '@tanstack/vue-query';
import { plannerClient, type ReplanProposal } from '../api';
import ReplanRequestButton from '../components/ReplanRequestButton.vue';
import UiBadge from '../components/ui/UiBadge.vue';
import UiBanner from '../components/ui/UiBanner.vue';
import UiButton from '../components/ui/UiButton.vue';
import UiEmptyState from '../components/ui/UiEmptyState.vue';
import UiIcon from '../components/ui/UiIcon.vue';
import UiSkeleton from '../components/ui/UiSkeleton.vue';
import { t, tp } from '../i18n';
import { browserTimeZone, formatDateTime } from '../i18n/format';
import { proposalStateLabel, reasonLabel, triggerLabel } from '../i18n/replan';
import { captureOwnerBinding } from '../session/ownerEpoch';
import { useAuthStore } from '../stores/auth';
import { useOfflineStore } from '../stores/offline';
import { useSessionStore } from '../stores/session';

/** Pending replan proposals first, then the read-only history (M5-03). */
const auth = useAuthStore();
const offline = useOfflineStore();
const sessionStore = useSessionStore();
const timeZone = computed(() => auth.user?.timeZone ?? browserTimeZone());

const listQuery = useQuery({
  queryKey: computed(() => ['replan-proposals', 'all', sessionStore.ownerId ?? 'anonymous']),
  queryFn: () => {
    const binding = captureOwnerBinding();
    return plannerClient.listReplanProposals({ limit: 50, signal: binding.signal });
  },
});

const items = computed(() => listQuery.data.value?.items ?? []);
const pending = computed(() => items.value.filter((item) => item.state === 'pending'));
const history = computed(() => items.value.filter((item) => item.state !== 'pending'));

/** "재계획 요청" targets the plan of the newest proposal (server planId, FU-70). */
const latestPlanId = computed(() => {
  const newest = [...items.value].sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0];
  return newest?.planId ?? null;
});

const STATE_TONES = {
  pending: 'accent',
  approved: 'success',
  rejected: 'neutral',
  expired: 'offline',
  superseded: 'offline',
} as const;

function tone(item: ReplanProposal) {
  return STATE_TONES[item.state];
}
</script>

<template>
  <section class="page replan-list-page">
    <header class="page-header">
      <div class="page-heading">
        <h1>{{ t('replan.title') }}</h1>
        <p class="page-lede">{{ t('replan.lede') }}</p>
      </div>
      <div class="page-actions">
        <UiBadge v-if="!offline.mutationsEnabled" tone="offline" dot class="chip--offline" role="status">
          {{ t('common.readOnlyOffline') }}
        </UiBadge>
      </div>
    </header>

    <p class="muted replan-policy"><UiIcon name="info" :size="16" /> {{ t('replan.policy') }}</p>
    <ReplanRequestButton v-if="latestPlanId" :plan-id="latestPlanId" show-help />

    <div v-if="listQuery.isLoading.value">
      <p class="visually-hidden" role="status">{{ t('replan.loading') }}</p>
      <UiSkeleton variant="card" :count="2" :lines="2" />
    </div>
    <UiBanner v-else-if="listQuery.isError.value" tone="error" class="error-panel">
      <p class="error-text" role="alert">{{ t('replan.loadError') }}</p>
      <template #actions>
        <UiButton size="sm" icon="sync" @click="listQuery.refetch()">{{ t('common.retry') }}</UiButton>
      </template>
    </UiBanner>
    <template v-else>
      <section class="replan-group" aria-labelledby="replan-pending-title">
        <h2 id="replan-pending-title" class="h2">{{ t('replan.pendingTitle') }}</h2>
        <ul v-if="pending.length > 0" class="replan-items">
          <li v-for="item in pending" :key="item.id" class="replan-item" :data-proposal-id="item.id">
            <RouterLink
              class="replan-item-link"
              :to="`/replan/${item.id}`"
            >
              <span class="replan-item-head">
                <span class="replan-item-title">{{ triggerLabel(item.trigger.kind) }}</span>
                <UiBadge :tone="tone(item)" dot>{{ proposalStateLabel(item.state) }}</UiBadge>
              </span>
              <span class="replan-item-body">{{ reasonLabel(item.trigger.reason) }}</span>
              <span class="replan-item-meta muted">
                {{ tp('replan.changedCount', item.candidate.changedBlocks) }} ·
                {{ t('replan.expiresAt', { time: formatDateTime(item.expiresAt, timeZone) }) }}
              </span>
              <UiIcon name="chevron-right" class="replan-item-chevron" />
            </RouterLink>
          </li>
        </ul>
        <UiEmptyState v-else icon="reschedule" :title="t('replan.pendingEmpty')" compact />
      </section>

      <section class="replan-group" aria-labelledby="replan-history-title">
        <h2 id="replan-history-title" class="h2">{{ t('replan.historyTitle') }}</h2>
        <ul v-if="history.length > 0" class="replan-items">
          <li v-for="item in history" :key="item.id" class="replan-item replan-item--past" :data-proposal-id="item.id">
            <RouterLink
              class="replan-item-link"
              :to="`/replan/${item.id}`"
            >
              <span class="replan-item-head">
                <span class="replan-item-title">{{ triggerLabel(item.trigger.kind) }}</span>
                <UiBadge :tone="tone(item)" dot>{{ proposalStateLabel(item.state) }}</UiBadge>
              </span>
              <span class="replan-item-meta muted">
                {{ t('replan.createdAt', { time: formatDateTime(item.createdAt, timeZone) }) }}
              </span>
              <UiIcon name="chevron-right" class="replan-item-chevron" />
            </RouterLink>
          </li>
        </ul>
        <UiEmptyState v-else icon="leaf" :title="t('replan.historyEmpty')" compact />
      </section>
    </template>
  </section>
</template>
