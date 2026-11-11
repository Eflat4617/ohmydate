<script setup lang="ts">
import { ref, watch } from 'vue';
import { useAuthStore } from '../stores/auth';
import UiBanner from './ui/UiBanner.vue';
import UiButton from './ui/UiButton.vue';
import UiDialog from './ui/UiDialog.vue';
import UiIcon from './ui/UiIcon.vue';

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

async function grant(): Promise<void> {
  busy.value = true;
  error.value = null;
  try {
    await auth.setLlmConsent(true);
    emit('close');
  } catch {
    error.value = 'Could not save consent. Please try again.';
  } finally {
    busy.value = false;
  }
}

async function manualMode(): Promise<void> {
  busy.value = true;
  error.value = null;
  try {
    await auth.setLlmConsent(false);
  } catch {
    // Falling through to manual mode is still safe if the record cannot save.
  } finally {
    busy.value = false;
    emit('close');
  }
}
</script>

<template>
  <UiDialog
    v-if="open"
    labelledby="llm-consent-title"
    describedby="llm-consent-body"
    :dismissible="!busy"
    @close="manualMode"
  >
    <header class="dialog-header dialog-header--start">
      <span class="dialog-icon"><UiIcon name="shield" :size="22" /></span>
      <div class="dialog-heading">
        <h2 id="llm-consent-title" class="dialog-title">Use AI planning assistance?</h2>
        <p class="muted">You can change this any time in AI settings.</p>
      </div>
    </header>
    <div id="llm-consent-body" class="dialog-body consent-body">
      <p>
        AI planning sends your intake input and task step information to the
        <strong>OpenCode Go gateway</strong>, which runs the
        <strong>DeepSeek model</strong> (deepseek-v4.1-flash).
      </p>
      <UiBanner tone="warn" title="Masking is best effort">
        Email, phone and account-number patterns are masked, but names, addresses and
        account numbers are <strong>not guaranteed</strong> to be removed.
      </UiBanner>
      <p class="muted">
        You can revoke consent at any time in AI settings. Without consent, OhMyDate stays
        in manual planning mode and makes no AI calls.
      </p>
    </div>
    <UiBanner v-if="error" tone="error" role="alert">{{ error }}</UiBanner>
    <div class="dialog-actions">
      <UiButton variant="ghost" :disabled="busy" @click="manualMode">Use manual mode</UiButton>
      <UiButton variant="primary" :disabled="busy" :busy="busy" data-autofocus @click="grant">
        {{ busy ? 'Saving…' : 'Allow AI planning' }}
      </UiButton>
    </div>
  </UiDialog>
</template>
