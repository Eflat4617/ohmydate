<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useAuthStore } from '../stores/auth';
import UiBadge from '../components/ui/UiBadge.vue';
import UiBanner from '../components/ui/UiBanner.vue';
import UiButton from '../components/ui/UiButton.vue';
import UiEmptyState from '../components/ui/UiEmptyState.vue';
import UiField from '../components/ui/UiField.vue';
import UiSkeleton from '../components/ui/UiSkeleton.vue';
import LlmDisclosure from '../components/LlmDisclosure.vue';
import { t } from '../i18n';
import { browserTimeZone, formatDateTime, formatUsd } from '../i18n/format';

const auth = useAuthStore();
const busy = ref(false);
const error = ref<string | null>(null);
const DEFAULT_DAILY_USD = 0.2;
const DEFAULT_MONTHLY_USD = 5;
const dailyUsd = ref(DEFAULT_DAILY_USD);
const monthlyUsd = ref(DEFAULT_MONTHLY_USD);

const consent = computed(() => auth.user?.llm?.consent);
const budget = computed(() => auth.user?.llm?.budget);
const deepseek = computed(() => auth.user?.llmProvider === 'deepseek');
const ready = computed(() => auth.confirmed && auth.user !== null);
const consentAt = computed(() => {
  const at = consent.value?.at;
  if (at === undefined) return '';
  return formatDateTime(at, auth.user?.timeZone ?? browserTimeZone(), { year: true });
});

function syncBudget(): void {
  dailyUsd.value = budget.value?.dailyUsd ?? DEFAULT_DAILY_USD;
  monthlyUsd.value = budget.value?.monthlyUsd ?? DEFAULT_MONTHLY_USD;
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
    error.value = t('llm.settings.updateError');
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
    error.value = t('llm.settings.budgetError');
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
          <h1>{{ t('llm.settings.title') }}</h1>
          <p class="page-lede">
            {{
              t('llm.settings.lede', {
                provider: t('llm.providerName'),
                model: t('llm.modelName'),
                modelId: t('llm.modelId'),
              })
            }}
          </p>
        </div>
      </header>

      <UiEmptyState v-if="!deepseek" icon="shield" :title="t('llm.settings.noConsentTitle')">
        <p>{{ t('llm.settings.noConsentBody') }}</p>
      </UiEmptyState>

      <template v-else>
        <fieldset class="settings-group">
          <legend>{{ t('llm.settings.consentLegend') }}</legend>
          <div class="settings-status">
            <UiBadge :tone="consent?.granted ? 'success' : 'neutral'" dot size="lg">
              {{ consent?.granted ? t('llm.settings.on') : t('llm.settings.off') }}
            </UiBadge>
          </div>
          <p v-if="consent?.granted">
            {{ t('llm.settings.onBody', { at: consentAt, provider: consent.provider }) }}
          </p>
          <p v-else>{{ t('llm.settings.offBody') }}</p>
          <LlmDisclosure />
          <div class="settings-actions">
            <UiButton
              v-if="!consent?.granted"
              variant="primary"
              :disabled="busy"
              :busy="busy"
              @click="setConsent(true)"
            >
              {{ t('llm.settings.enable') }}
            </UiButton>
            <UiButton v-else variant="danger-ghost" :disabled="busy" :busy="busy" @click="setConsent(false)">
              {{ t('llm.settings.revoke') }}
            </UiButton>
          </div>
          <UiBanner v-if="error" tone="error" role="alert">{{ error }}</UiBanner>
        </fieldset>

        <fieldset class="settings-group">
          <legend>{{ t('llm.settings.budgetLegend') }}</legend>
          <p class="muted">
            {{ t('llm.settings.budgetLede', { daily: formatUsd(DEFAULT_DAILY_USD), monthly: formatUsd(DEFAULT_MONTHLY_USD) }) }}
          </p>
          <p v-if="budget" class="settings-current">
            {{ t('llm.settings.budgetCurrent', { daily: formatUsd(budget.dailyUsd), monthly: formatUsd(budget.monthlyUsd) }) }}
          </p>
          <form class="settings-form" @submit.prevent="saveBudget">
            <div class="field-grid">
              <UiField id="llm-daily-budget" :label="t('llm.settings.daily')">
                <input
                  id="llm-daily-budget"
                  v-model.number="dailyUsd"
                  type="number"
                  min="0"
                  step="0.01"
                  required
                />
              </UiField>
              <UiField id="llm-monthly-budget" :label="t('llm.settings.monthly')">
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
              <UiButton type="submit" :disabled="busy" :busy="busy">{{ t('llm.settings.saveBudget') }}</UiButton>
            </div>
          </form>
        </fieldset>
      </template>
    </template>
    <div v-else>
      <p class="visually-hidden" role="status">{{ t('llm.settings.loading') }}</p>
      <UiSkeleton variant="card" :count="2" :lines="3" />
    </div>
  </section>
</template>
