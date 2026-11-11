<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useAuthStore } from '../stores/auth';
import UiBadge from '../components/ui/UiBadge.vue';
import UiBanner from '../components/ui/UiBanner.vue';
import UiButton from '../components/ui/UiButton.vue';
import UiEmptyState from '../components/ui/UiEmptyState.vue';
import UiField from '../components/ui/UiField.vue';
import UiSkeleton from '../components/ui/UiSkeleton.vue';

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
      <header class="page-header">
        <div class="page-heading">
          <h1>AI settings</h1>
          <p class="page-lede">
            AI planning uses the OpenCode Go gateway with the DeepSeek model
            (deepseek-v4.1-flash). Requests include only your intake input and the task step
            information needed for the current step.
          </p>
        </div>
      </header>

      <UiEmptyState v-if="!deepseek" icon="shield" title="No AI consent needed">
        <p>This build uses the deterministic offline planner, so no AI consent is required.</p>
      </UiEmptyState>

      <template v-else>
        <fieldset class="settings-group">
          <legend>Consent</legend>
          <div class="settings-status">
            <UiBadge :tone="consent?.granted ? 'success' : 'neutral'" dot size="lg">
              {{ consent?.granted ? 'AI planning on' : 'Manual mode' }}
            </UiBadge>
          </div>
          <p v-if="consent?.granted">
            AI planning is <strong>on</strong>. Consent was recorded
            {{ new Date(consent.at).toLocaleString() }} for {{ consent.provider }}.
          </p>
          <p v-else>
            AI planning is <strong>off</strong>. OhMyDate is in manual planning mode and makes no
            AI calls.
          </p>
          <UiBanner tone="warn" title="Masking is best effort">
            Email, phone and account-number patterns are masked, but names, addresses and
            account numbers are not guaranteed to be removed.
          </UiBanner>
          <div class="settings-actions">
            <UiButton
              v-if="!consent?.granted"
              variant="primary"
              :disabled="busy"
              :busy="busy"
              @click="setConsent(true)"
            >
              Enable AI planning
            </UiButton>
            <UiButton v-else variant="danger-ghost" :disabled="busy" :busy="busy" @click="setConsent(false)">
              Revoke consent (manual mode)
            </UiButton>
          </div>
          <UiBanner v-if="error" tone="error" role="alert">{{ error }}</UiBanner>
        </fieldset>

        <fieldset class="settings-group">
          <legend>Budget</legend>
          <p class="muted">
            Conservative defaults are <strong>$0.20 per day</strong> and
            <strong>$5.00 per month</strong>. When the budget is reached, planning falls back to
            manual mode instead of making more paid calls.
          </p>
          <p v-if="budget" class="settings-current">
            Current limits: ${{ budget.dailyUsd.toFixed(2) }} per day, ${{
              budget.monthlyUsd.toFixed(2)
            }}
            per month.
          </p>
          <form class="settings-form" @submit.prevent="saveBudget">
            <div class="field-grid">
              <UiField id="llm-daily-budget" label="Daily limit (USD)">
                <input
                  id="llm-daily-budget"
                  v-model.number="dailyUsd"
                  type="number"
                  min="0"
                  step="0.01"
                  required
                />
              </UiField>
              <UiField id="llm-monthly-budget" label="Monthly limit (USD)">
                <input
                  id="llm-monthly-budget"
                  v-model.number="monthlyUsd"
                  type="number"
                  min="0"
                  step="0.01"
                  required
                />
              </UiField>
            </div>
            <div class="form-actions">
              <UiButton type="submit" :disabled="busy" :busy="busy">Save budget</UiButton>
            </div>
          </form>
        </fieldset>
      </template>
    </template>
    <div v-else>
      <p class="visually-hidden" role="status">Loading AI settings…</p>
      <UiSkeleton variant="card" :count="2" :lines="3" />
    </div>
  </section>
</template>
