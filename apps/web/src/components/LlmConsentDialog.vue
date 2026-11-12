<script setup lang="ts">
import { ref, watch } from 'vue';
import { runOwnerBound } from '../session/ownerBound';
import { useAuthStore } from '../stores/auth';
import UiBanner from './ui/UiBanner.vue';
import UiButton from './ui/UiButton.vue';
import UiDialog from './ui/UiDialog.vue';
import UiIcon from './ui/UiIcon.vue';
import LlmDisclosure from './LlmDisclosure.vue';
import { t } from '../i18n';

const props = defineProps<{ open: boolean }>();
const emit = defineEmits<{ close: [] }>();

const auth = useAuthStore();
const busy = ref(false);
const error = ref<string | null>(null);

watch(
  () => props.open,
  (open) => {
    if (open) error.value = null;
  },
  { immediate: true },
);

// Owner isolation (ADR-023): owner-bound tasks, so a request the owner change
// aborted neither shows an error nor closes the next user's dialog.
async function grant(): Promise<void> {
  busy.value = true;
  error.value = null;
  await runOwnerBound(
    function* (owner) {
      yield* owner.wait(auth.setLlmConsent(true));
      emit('close');
    },
    {
      onError: () => {
        error.value = t('llm.consent.error');
      },
      onSettled: () => {
        busy.value = false;
      },
    },
  );
}

// FU-91: Escape (or any other dismissal) closes the dialog without recording an
// answer. Consent stays undecided, so AI is still not called; the dialog does
// not come back on a reload this session, but it does when the user starts an
// AI action (stores/llmConsent.ts).
function dismiss(): void {
  if (busy.value) return;
  emit('close');
}

async function manualMode(): Promise<void> {
  busy.value = true;
  error.value = null;
  await runOwnerBound(function* (owner) {
    try {
      yield* owner.wait(auth.setLlmConsent(false));
    } catch {
      // Falling through to manual mode is still safe if the record cannot save.
    }
    busy.value = false;
    emit('close');
  });
}
</script>

<template>
  <UiDialog
    v-if="open"
    labelledby="llm-consent-title"
    describedby="llm-consent-body"
    :dismissible="!busy"
    @close="dismiss"
  >
    <header class="dialog-header dialog-header--start">
      <span class="dialog-icon"><UiIcon name="shield" :size="22" /></span>
      <div class="dialog-heading">
        <h2 id="llm-consent-title" class="dialog-title">{{ t('llm.consent.title') }}</h2>
        <p class="muted">{{ t('llm.consent.lede') }}</p>
      </div>
    </header>
    <div id="llm-consent-body" class="dialog-body consent-body">
      <LlmDisclosure />
    </div>
    <UiBanner v-if="error" tone="error" role="alert">{{ error }}</UiBanner>
    <div class="dialog-actions">
      <UiButton variant="ghost" :disabled="busy" @click="manualMode">{{ t('llm.consent.manual') }}</UiButton>
      <UiButton variant="primary" :disabled="busy" :busy="busy" data-autofocus @click="grant">
        {{ busy ? t('common.saving') : t('llm.consent.allow') }}
      </UiButton>
    </div>
  </UiDialog>
</template>
