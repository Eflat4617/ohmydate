<script setup lang="ts">
import { nextTick, ref, watch } from 'vue';
import { useAuthStore } from '../stores/auth';

const props = defineProps<{ open: boolean }>();
const emit = defineEmits<{ close: [] }>();

const auth = useAuthStore();
const busy = ref(false);
const error = ref<string | null>(null);
const acceptButton = ref<HTMLButtonElement | null>(null);

watch(
  () => props.open,
  async (open) => {
    if (!open) return;
    error.value = null;
    await nextTick();
    acceptButton.value?.focus();
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
  <div v-if="open" class="dialog-backdrop">
    <div
      class="dialog"
      role="dialog"
      aria-modal="true"
      aria-labelledby="llm-consent-title"
      aria-describedby="llm-consent-body"
      @keydown.esc.stop="manualMode"
    >
      <h2 id="llm-consent-title">Use AI planning assistance?</h2>
      <div id="llm-consent-body" class="consent-body">
        <p>
          AI planning sends your intake input and task step information to the
          <strong>OpenCode Go gateway</strong>, which runs the
          <strong>DeepSeek model</strong> (deepseek-v4.1-flash).
        </p>
        <p>
          Masking is best effort. Email, phone and account-number patterns are masked, but
          names, addresses and account numbers are <strong>not guaranteed</strong> to be removed.
        </p>
        <p>
          You can revoke consent at any time in AI settings. Without consent, OhMyDate stays
          in manual planning mode and makes no AI calls.
        </p>
      </div>
      <p v-if="error" class="error-text" role="alert">{{ error }}</p>
      <div class="dialog-actions">
        <button ref="acceptButton" type="button" class="primary-action" :disabled="busy" @click="grant">
          {{ busy ? 'Saving…' : 'Allow AI planning' }}
        </button>
        <button type="button" class="link-button" :disabled="busy" @click="manualMode">
          Use manual mode
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.consent-body p {
  margin-block: 0 0.75rem;
}

.dialog-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
  align-items: center;
}
</style>
