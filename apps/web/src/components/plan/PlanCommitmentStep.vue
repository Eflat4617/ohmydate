<script setup lang="ts">
import { ref } from 'vue';
import { t } from '../../i18n';
import { useOfflineStore } from '../../stores/offline';
import CommitmentAddDialog from '../planner/CommitmentAddDialog.vue';
import UiButton from '../ui/UiButton.vue';
import UiCard from '../ui/UiCard.vue';
import UiIcon from '../ui/UiIcon.vue';

/**
 * "고정된 일정이 있나요?" (HOLO-03A, FLOW §2): offered inside 계획 세우기
 * when the owner has no 약속 at all, and always optional. 약속 추가 is the
 * planner's own dialog (말로 적기 on top, the fields under 직접 입력); the
 * Google link is shown only while no calendar is connected.
 */
defineProps<{
  timeZone: string;
  /** The day a new 약속 starts on (`YYYY-MM-DD`). */
  date: string;
  /** A Google Calendar is not connected yet: offer the way to connect one. */
  offerGoogle: boolean;
}>();
const emit = defineEmits<{ saved: [] }>();

const offline = useOfflineStore();
const adding = ref(false);
const added = ref(false);

function onSaved(): void {
  added.value = true;
  emit('saved');
}
</script>

<template>
  <UiCard class="plan-prep plan-prep--commitments" aria-labelledby="plan-commitments-title" data-plan-commitments>
    <h2 id="plan-commitments-title" class="card-title"><UiIcon name="commitment" :size="18" />{{ t('planScope.commitments.title') }}</h2>
    <p class="plan-prep-lede">{{ t('planScope.commitments.lede') }}</p>
    <p v-if="added" class="plan-prep-note" role="status" data-plan-commitments-added>
      <UiIcon name="check" :size="16" />{{ t('planScope.commitments.added') }}
    </p>
    <div class="plan-prep-actions">
      <UiButton icon="plus" :disabled="!offline.mutationsEnabled" data-plan-commitment-add @click="adding = true">
        {{ t('planScope.commitments.add') }}
      </UiButton>
      <RouterLink v-if="offerGoogle" class="btn btn--ghost" to="/settings/calendar" data-plan-google>
        <UiIcon name="link" :size="18" class="btn-icon" />{{ t('planScope.commitments.google') }}
      </RouterLink>
    </div>
    <CommitmentAddDialog v-if="adding" :time-zone="timeZone" :date="date" @close="adding = false" @saved="onSaved" />
  </UiCard>
</template>
