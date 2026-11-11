<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useAuthStore } from '../stores/auth';

const auth = useAuthStore();
const busy = ref(false);
const error = ref<string | null>(null);
const dailyUsd = ref(0.2);
const monthlyUsd = ref(5);

const consent = computed(() => auth.user?.llm?.consent);
const budget = computed(() => auth.user?.llm?.budget);
const deepseek = computed(() => auth.user?.llmProvider === 'deepseek');
const ready = computed(() => auth.confirmed && auth.user !== null);

function syncBudget(): void {
  dailyUsd.value = budget.value?.dailyUsd ?? 0.2;
  monthlyUsd.value = budget.value?.monthlyUsd ?? 5;
}

onMounted(async () => {
  if (!auth.confirmed) await auth.ensureOwnerConfirmed();
  syncBudget();
});

async function setConsent(granted: boolean): Promise<void> {
  busy.value = true;
  error.value = null;
  try {
    await auth.setLlmConsent(granted);
  } catch {
    error.value = 'Could not update AI consent. Please try again.';
  } finally {
    busy.value = false;
  }
}

async function saveBudget(): Promise<void> {
  busy.value = true;
  error.value = null;
  try {
    await auth.setLlmBudget(dailyUsd.value, monthlyUsd.value);
  } catch {
    error.value = 'Could not save the AI budget. Please try again.';
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <section class="page">
    <template v-if="ready">
      <h1>AI settings</h1>
    <p class="muted">
      AI planning uses the OpenCode Go gateway with the DeepSeek model
      (deepseek-v4.1-flash). Requests include only your intake input and the task step
      information needed for the current step.
    </p>

    <div v-if="!deepseek" class="empty-state">
      <p>This build uses the deterministic offline planner, so no AI consent is required.</p>
    </div>

    <template v-else>
      <fieldset class="settings-group">
        <legend>Consent</legend>
        <p v-if="consent?.granted">
          AI planning is <strong>on</strong>. Consent was recorded
          {{ new Date(consent.at).toLocaleString() }} for {{ consent.provider }}.
        </p>
        <p v-else>
          AI planning is <strong>off</strong>. OhMyDate is in manual planning mode and makes no
          AI calls.
        </p>
        <p>
          Masking is best effort: email, phone and account-number patterns are masked, but
          names, addresses and account numbers are not guaranteed to be removed.
        </p>
        <div class="settings-actions">
          <button
            v-if="!consent?.granted"
            type="button"
            class="primary-action"
            :disabled="busy"
            @click="setConsent(true)"
          >
            Enable AI planning
          </button>
          <button
            v-else
            type="button"
            class="link-button"
            :disabled="busy"
            @click="setConsent(false)"
          >
            Revoke consent (manual mode)
          </button>
        </div>
        <p v-if="error" class="error-text" role="alert">{{ error }}</p>
      </fieldset>

      <fieldset class="settings-group">
        <legend>Budget</legend>
        <p>
          Conservative defaults are <strong>$0.20 per day</strong> and
          <strong>$5.00 per month</strong>. When the budget is reached, planning falls back to
          manual mode instead of making more paid calls.
        </p>
        <p v-if="budget">
          Current limits: ${{ budget.dailyUsd.toFixed(2) }} per day, ${{
            budget.monthlyUsd.toFixed(2)
          }}
          per month.
        </p>
        <form class="settings-form" @submit.prevent="saveBudget">
          <label for="llm-daily-budget">Daily limit (USD)</label>
          <input
            id="llm-daily-budget"
            v-model.number="dailyUsd"
            type="number"
            min="0"
            step="0.01"
            required
          />
          <label for="llm-monthly-budget">Monthly limit (USD)</label>
          <input
            id="llm-monthly-budget"
            v-model.number="monthlyUsd"
            type="number"
            min="0"
            step="0.01"
            required
          />
          <button type="submit" class="link-button" :disabled="busy">Save budget</button>
        </form>
      </fieldset>
    </template>
    </template>
    <p v-else class="muted" role="status">Loading AI settings…</p>
  </section>
</template>
