<script setup lang="ts">
import { computed } from 'vue';
import { useQuery } from '@tanstack/vue-query';
import { plannerClient } from '../api';
import { t, tp } from '../i18n';
import { reasonLabel } from '../i18n/replan';
import { captureOwnerBinding } from '../session/ownerEpoch';
import { useOfflineStore } from '../stores/offline';
import { useSessionStore } from '../stores/session';
import UiBanner from './ui/UiBanner.vue';

/**
 * Today entry point for pending replan proposals (05 §11: at most two a day,
 * so this is a calm notice, never a modal). It only links to the proposal;
 * approving happens on the detail screen with the full before/after diff.
 */
const offline = useOfflineStore();
const sessionStore = useSessionStore();

const pendingQuery = useQuery({
  queryKey: computed(() => ['replan-proposals', 'pending', sessionStore.ownerId ?? 'anonymous']),
  queryFn: () => {
    const binding = captureOwnerBinding();
    return plannerClient.listReplanProposals({ state: 'pending', limit: 10, signal: binding.signal });
  },
  enabled: computed(() => offline.online),
});

const pending = computed(() => pendingQuery.data.value?.items ?? []);
const first = computed(() => pending.value[0] ?? null);
const target = computed(() => (pending.value.length === 1 && first.value !== null ? `/replan/${first.value.id}` : '/replan'));
</script>

<template>
  <UiBanner
    v-if="first"
    as="section"
    tone="info"
    icon="reschedule"
    class="replan-banner"
    :title="tp('replan.bannerTitle', pending.length)"
    data-replan-banner
  >
    <p>{{ t('replan.bannerBody', { reason: reasonLabel(first.trigger.reason) }) }}</p>
    <template #actions>
      <RouterLink class="btn btn--secondary btn--sm" :to="target">
        {{ pending.length === 1 ? t('replan.bannerOpen') : t('replan.bannerOpenAll') }}
      </RouterLink>
    </template>
  </UiBanner>
</template>
