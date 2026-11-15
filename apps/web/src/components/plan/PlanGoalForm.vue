<script setup lang="ts">
import { nextTick, ref, watch } from 'vue';
import { t } from '../../i18n';
import LlmDisclosure from '../LlmDisclosure.vue';
import UiBanner from '../ui/UiBanner.vue';
import UiButton from '../ui/UiButton.vue';
import UiCard from '../ui/UiCard.vue';
import UiField from '../ui/UiField.vue';
import UiIcon from '../ui/UiIcon.vue';

/**
 * 계획 세우기 · 목표 (HOLO-03A): what has to be done, and by when. A title
 * is enough to start; the due time and a few more words help the AI ask less.
 *
 * AI consent is asked right here when it is missing (FLOW §2), with the same
 * disclosure the consent dialog and AI 설정 show: when the owner presses
 * start while undecided (`asking`), the disclosure opens in the card and the
 * one start button becomes two — with the AI, or without it.
 *
 * The screen owns the request; this only holds the form and says what was
 * chosen (`submit`, `answer`).
 */
export interface GoalForm {
  title: string;
  dueAt: string;
  description: string;
}

/** `on`: consent given · `ask`: never answered · `off`: declined · `none`: this build has no AI to consent to. */
export type GoalAiState = 'on' | 'ask' | 'off' | 'none';

const props = withDefaults(
  defineProps<{
    form: GoalForm;
    ai: GoalAiState;
    /** The consent question is open (start was pressed while undecided, or AI 도움 켜기). */
    asking: boolean;
    /** A consent answer is being saved. */
    answering?: boolean;
    consentError?: string | null;
    busy?: boolean;
    disabled?: boolean;
  }>(),
  { answering: false, consentError: null, busy: false, disabled: false },
);
const emit = defineEmits<{
  'update:form': [form: GoalForm];
  /** Start with what is filled in. */
  submit: [];
  /** The consent question was answered: with the AI, or without. */
  answer: [granted: boolean];
  /** Open the consent question (AI 도움 켜기). */
  ask: [];
}>();

const consent = ref<HTMLElement | null>(null);

function set<K extends keyof GoalForm>(key: K, value: GoalForm[K]): void {
  emit('update:form', { ...props.form, [key]: value });
}

function textOf(event: Event): string {
  const target = event.target;
  return target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement ? target.value : '';
}

// The question opens where the eyes already are, and takes the focus.
watch(
  () => props.asking,
  async (asking) => {
    if (!asking) return;
    await nextTick();
    consent.value?.focus();
  },
);
</script>

<template>
  <UiCard as="form" class="plan-goal" aria-labelledby="plan-goal-label" data-plan-goal @submit.prevent="emit('submit')">
    <div class="plan-goal-field">
      <label id="plan-goal-label" for="plan-goal-title" class="plan-goal-label">{{ t('planStart.goalLabel') }}</label>
      <input
        id="plan-goal-title"
        class="plan-goal-title"
        type="text"
        maxlength="200"
        required
        autocomplete="off"
        :value="form.title"
        :placeholder="t('planStart.goalPlaceholder')"
        :disabled="busy || disabled"
        @input="set('title', textOf($event))"
      />
    </div>

    <div class="plan-goal-more">
      <UiField id="plan-goal-due" :label="t('planStart.due')">
        <input
          id="plan-goal-due"
          type="datetime-local"
          :value="form.dueAt"
          :disabled="busy || disabled"
          @input="set('dueAt', textOf($event))"
        />
      </UiField>
      <UiField id="plan-goal-description" :label="t('planStart.description')" :help="t('planStart.descriptionHelp')">
        <template #default="{ describedby }">
          <textarea
            id="plan-goal-description"
            rows="3"
            maxlength="4000"
            :value="form.description"
            :aria-describedby="describedby"
            :disabled="busy || disabled"
            @input="set('description', textOf($event))"
          ></textarea>
        </template>
      </UiField>
    </div>

    <section
      v-if="asking"
      ref="consent"
      class="plan-consent"
      aria-labelledby="plan-consent-title"
      tabindex="-1"
      data-plan-consent
    >
      <h2 id="plan-consent-title" class="plan-consent-title">
        <UiIcon name="shield" :size="18" />{{ t('planStart.consent.title') }}
      </h2>
      <p class="plan-consent-lede">{{ t('planStart.consent.lede') }}</p>
      <LlmDisclosure />
      <UiBanner v-if="consentError" tone="error" role="alert">{{ consentError }}</UiBanner>
    </section>

    <footer class="plan-goal-foot">
      <p v-if="ai !== 'none' && !asking" class="plan-goal-ai" :data-ai="ai">
        <UiIcon name="ai" :size="16" />
        <span>{{ t(`planStart.ai.${ai}`) }}</span>
        <button v-if="ai === 'off'" type="button" class="plan-goal-ai-link" :disabled="busy || disabled" data-plan-ai-on @click="emit('ask')">
          {{ t('planStart.ai.turnOn') }}
        </button>
      </p>
      <div class="plan-goal-actions">
        <template v-if="asking">
          <UiButton :disabled="answering || busy || disabled" data-plan-consent-manual @click="emit('answer', false)">
            {{ form.title.trim().length > 0 ? t('planStart.consent.manualAndStart') : t('planStart.consent.later') }}
          </UiButton>
          <UiButton
            variant="primary"
            size="lg"
            icon="ai"
            :busy="answering || busy"
            :disabled="answering || busy || disabled"
            data-plan-consent-allow
            @click="emit('answer', true)"
          >
            {{
              answering
                ? t('planStart.consent.saving')
                : form.title.trim().length > 0
                  ? t('planStart.consent.allowAndStart')
                  : t('planStart.consent.allow')
            }}
          </UiButton>
        </template>
        <UiButton
          v-else
          type="submit"
          variant="primary"
          size="lg"
          icon="arrow-right"
          :busy="busy"
          :disabled="busy || disabled || form.title.trim().length === 0"
          data-plan-start
        >
          {{ busy ? t('planStart.starting') : t('planStart.start') }}
        </UiButton>
      </div>
    </footer>
  </UiCard>
</template>
