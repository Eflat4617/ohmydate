<script setup lang="ts">
import { inject } from 'vue';
import { routerKey } from 'vue-router';
import { useQueryClient } from '@tanstack/vue-query';
import type { ReplanProposal } from '../api';
import { useReplanRequest } from '../composables/useReplanRequest';
import { runOwnerBound } from '../session/ownerBound';
import { t } from '../i18n';
import { useOfflineStore } from '../stores/offline';
import { useToastStore } from '../stores/toast';
import UiBanner from './ui/UiBanner.vue';
import UiButton from './ui/UiButton.vue';

/**
 * "다시 맞추기 요청" (trigger kind user_request). On success it opens the new
 * proposal; a suppressed request explains when the next one is allowed.
 */
const props = withDefaults(
  defineProps<{
    planId: string;
    variant?: 'primary' | 'secondary' | 'ghost';
    size?: 'sm' | 'md';
    block?: boolean;
    showHelp?: boolean;
  }>(),
  { variant: 'secondary', size: 'md', block: false, showHelp: false },
);
const emit = defineEmits<{ created: [proposal: ReplanProposal] }>();

const router = inject(routerKey, null);
const queryClient = useQueryClient();
const offline = useOfflineStore();
const toast = useToastStore();
const { busy, error, hint, request } = useReplanRequest();

// Owner isolation (ADR-023): the toast and the navigation belong to the
// owner who asked; after a user switch the new proposal opens for nobody.
async function submit(): Promise<void> {
  await runOwnerBound(function* (owner) {
    const created = yield* owner.wait(request(props.planId));
    if (created === null) return;
    toast.show(t('replan.requested'));
    yield* owner.wait(queryClient.invalidateQueries({ queryKey: ['replan-proposals'] }));
    emit('created', created);
    if (router !== null) yield* owner.wait(router.push(`/replan/${created.id}`));
  });
}
</script>

<template>
  <div class="replan-request">
    <UiButton
      :variant="variant"
      :size="size"
      :block="block"
      icon="reschedule"
      :disabled="busy || !offline.mutationsEnabled"
      :busy="busy"
      data-replan-request
      @click="submit"
    >
      {{ busy ? t('replan.requesting') : t('replan.request') }}
    </UiButton>
    <p v-if="showHelp" class="field-help">{{ t('replan.requestHelp') }}</p>
    <div class="replan-request-status" role="status" aria-live="polite">
      <UiBanner v-if="error" tone="warn" icon="clock" class="replan-suppressed">
        <p>{{ error }}</p>
        <p v-if="hint" class="muted">{{ hint }}</p>
      </UiBanner>
    </div>
  </div>
</template>
