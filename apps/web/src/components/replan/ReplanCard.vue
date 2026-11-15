<script setup lang="ts">
import { computed } from 'vue';
import { usePendingReplans } from '../../composables/useOverview';
import { t, tp } from '../../i18n';
import { reasonLabel } from '../../i18n/replan';
import UiIcon from '../ui/UiIcon.vue';

/**
 * 다시 맞추기, as a card other screens drop in (HOLO-03A, FLOW §2 ⑥): when the
 * plan drifted and a new one is proposed, the screen the owner is on (오늘,
 * 플래너, 개요) says so — why, how many blocks would move — and opens the
 * before → after view (`/replan/:id`). It only links: approving happens
 * there, with the whole comparison in view. Nothing is rendered while no
 * proposal waits.
 *
 * At most two proposals a day arrive (05 §11), so this is a calm card, never
 * a modal and never the screen's filled button.
 */
withDefaults(defineProps<{ compact?: boolean }>(), { compact: true });

const pendingQuery = usePendingReplans();
const pending = computed(() => pendingQuery.data.value?.items ?? []);
const first = computed(() => pending.value[0] ?? null);
const target = computed(() =>
  pending.value.length === 1 && first.value !== null ? `/replan/${first.value.id}` : '/replan',
);
</script>

<template>
  <section
    v-if="first"
    class="card replan-card"
    :class="{ 'card--compact': compact }"
    aria-labelledby="replan-card-title"
    data-replan-card
  >
    <div class="replan-card-text">
      <h2 id="replan-card-title" class="card-title"><UiIcon name="reschedule" :size="18" />{{ t('replan.card.title') }}</h2>
      <p class="replan-card-reason" data-replan-card-reason>
        {{ reasonLabel(first.trigger.reason) }} ·
        <span class="tabular">{{ tp('replan.changedCount', first.candidate.changedBlocks) }}</span>
      </p>
      <p class="replan-card-more">
        <template v-if="pending.length > 1">{{ tp('replan.card.more', pending.length) }} · </template>{{ t('replan.card.safe') }}
      </p>
    </div>
    <RouterLink class="btn btn--secondary btn--sm" :to="target" data-replan-card-open>
      {{ pending.length === 1 ? t('replan.card.open') : t('replan.card.openAll') }}
    </RouterLink>
  </section>
</template>
