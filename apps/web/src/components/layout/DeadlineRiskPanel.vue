<script setup lang="ts">
import { computed, useId } from 'vue';
import UiButton from '../ui/UiButton.vue';
import UiIcon from '../ui/UiIcon.vue';
import { t } from '../../i18n';
import { riskReasonText } from '../../i18n/server';
import { useLayoutContext } from '../../layout/context';
import { acknowledgeRisk } from '../../layout/localSignals';
import { riskTaskCount } from '../../layout/useTodaySnapshot';
import { captureOwnerBinding } from '../../session/ownerEpoch';
import { useLayoutStore } from '../../stores/layout';

const context = useLayoutContext();
const layout = useLayoutStore();
// The owner this panel was rendered for (ADR-023): its answer is stored for
// that owner only, and dropped if the signed-in user changed meanwhile.
const binding = captureOwnerBinding();
const headingId = `layout-risk-${useId()}`;

const atRisk = computed(() => riskTaskCount(context.today.value) > 0);
const acknowledged = computed(() => context.signals.value.riskAcknowledged);
const reasons = computed(() => {
  const current = context.today.value;
  if (current === null) return [];
  const titles = new Map(current.blocks.map((block) => [block.taskId, block.title]));
  return current.risk.reasons
    .filter((reason) => reason.startsWith('task_overdue:') || reason.startsWith('negative_slack:'))
    .map((reason) => ({ key: reason, ...riskReasonText(reason, (taskId) => titles.get(taskId)) }));
});

function acknowledge(): void {
  if (!acknowledgeRisk(binding, context.day.value)) return;
  // An explicit answer from the user: apply at once, without the hold.
  layout.intent({ announce: true });
}
</script>

<template>
  <section class="layout-panel layout-panel--warn" :aria-labelledby="headingId" data-panel="deadline-risk">
    <h2 :id="headingId" class="layout-panel-title">
      <UiIcon name="warn" :size="18" />
      <span>{{ atRisk ? t('layout.risk.title') : t('layout.risk.none') }}</span>
    </h2>
    <template v-if="atRisk">
      <p class="layout-panel-lede">{{ t('layout.risk.lede') }}</p>
      <ul class="chip-row" :aria-label="t('layout.risk.reasons')">
        <li v-for="reason in reasons" :key="reason.key" class="chip badge--wrap" :lang="reason.translated ? undefined : 'en'">
          {{ reason.text }}
        </li>
      </ul>
      <p v-if="acknowledged" class="muted">{{ t('layout.risk.acknowledged') }}</p>
      <div class="layout-panel-actions">
        <RouterLink to="/replan" class="btn btn--secondary btn--sm">{{ t('layout.risk.openReplan') }}</RouterLink>
        <UiButton v-if="!acknowledged" size="sm" variant="ghost" icon="check" @click="acknowledge">
          {{ t('layout.risk.acknowledge') }}
        </UiButton>
      </div>
    </template>
  </section>
</template>
