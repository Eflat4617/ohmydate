<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import { useQuery, useQueryClient } from '@tanstack/vue-query';
import { useRouter } from 'vue-router';
import { ActionStore, ApiError, plannerClient, type AvailabilityPut, type AvailabilityRule } from '../api';
import { FIRST_RUN_STEPS, type FirstRun, type FirstRunStep } from '../composables/firstRun';
import { useGoogleIntegration } from '../composables/useGoogleCalendar';
import { todayInZone } from '../domain/time';
import { t } from '../i18n';
import { browserTimeZone } from '../i18n/format';
import { errorMessage } from '../i18n/problem';
import { useLayoutNow } from '../layout/now';
import { runOwnerBound } from '../session/ownerBound';
import { useAuthStore } from '../stores/auth';
import { useLlmConsentStore } from '../stores/llmConsent';
import { useOfflineStore } from '../stores/offline';
import { useUiStore } from '../stores/ui';
import LlmDisclosure from './LlmDisclosure.vue';
import PlanAvailabilityStep from './plan/PlanAvailabilityStep.vue';
import PlanCommitmentStep from './plan/PlanCommitmentStep.vue';
import UiBanner from './ui/UiBanner.vue';
import UiButton from './ui/UiButton.vue';
import UiDialog from './ui/UiDialog.vue';
import UiIcon from './ui/UiIcon.vue';

/**
 * 시작 안내 (HOLO-04, FLOW.md §3): three steps, each one skippable, ending in
 * the first stage of the loop — 담기.
 *
 *   1 언제 일할 수 있나요?   the plan flow's own step (presets, the grid under 직접 칠하기)
 *   2 고정된 일정이 있나요?  약속 추가 (말로 적기 or the fields), or a Google calendar
 *   3 AI가 도와줄까요?       what is sent, on one screen; 허용 or 나중에
 *
 * It asks only for what is still missing: a step the owner's data already
 * answers is ticked and passed over. Closing it midway keeps what was done;
 * 개요 offers the rest ("시작 마무리") and each skipped step is asked again
 * where it is needed. Saving is the same calls the screens make — the hours
 * with the version that was read (If-Match) and an idempotency key, consent
 * through the account's own setting — each in an owner-bound task.
 */
const props = defineProps<{ guide: FirstRun }>();

const ui = useUiStore();
const auth = useAuthStore();
const offline = useOfflineStore();
const llmConsent = useLlmConsentStore();
const queryClient = useQueryClient();
const router = useRouter();
const now = useLayoutNow();
const actions = new ActionStore();

const availabilityQuery = useQuery({
  queryKey: ['availability'],
  queryFn: () => plannerClient.getAvailability(),
});
const availability = computed(() => availabilityQuery.data.value ?? null);
const google = useGoogleIntegration();
const timeZone = computed(() => availability.value?.timeZone ?? browserTimeZone());
const today = computed(() => todayInZone(timeZone.value, now.value));
const offerGoogle = computed(() => {
  const status = google.data.value?.status;
  return status === 'disconnected' || status === 'needs_reauth';
});

/** A step the guide still has to show: to do, or not known yet to be done. */
function open(step: FirstRunStep): boolean {
  const state = props.guide.states.value[step];
  return state === 'todo' || state === 'unknown';
}

/** Where the guide is: one of the steps, or its ending. It opens on the first step still open. */
const at = ref<FirstRunStep | 'ready'>(FIRST_RUN_STEPS.find(open) ?? 'ready');
/** The owner has answered something here: the guide no longer moves by itself. */
let touched = false;
const hoursDraft = ref<AvailabilityRule[]>([]);
const busy = ref(false);
const error = ref<string | null>(null);
const heading = ref<HTMLElement | null>(null);

const index = computed(() => (at.value === 'ready' ? FIRST_RUN_STEPS.length : FIRST_RUN_STEPS.indexOf(at.value)));

/** The next step still open after the one on show; the ending when none is. */
function advance(): void {
  const current = at.value;
  const after = FIRST_RUN_STEPS.slice(current === 'ready' ? FIRST_RUN_STEPS.length : FIRST_RUN_STEPS.indexOf(current) + 1);
  at.value = after.find(open) ?? 'ready';
  error.value = null;
  void nextTick(() => heading.value?.focus());
}

// Opened before the owner's data had answered: a step that turns out to be
// done already is passed over — until the owner has answered something here.
watch(
  () => (at.value === 'ready' ? null : props.guide.states.value[at.value]),
  (state) => {
    if (!touched && state === 'done') advance();
  },
);

function skip(): void {
  touched = true;
  if (at.value !== 'ready') props.guide.skip(at.value);
  // "나중에" is an answer for this session: the consent dialog does not come by itself right after.
  if (at.value === 'ai') llmConsent.closed();
  advance();
}

// Leaving for another screen (the Google connection) puts the guide away; 개요
// offers the rest. Only a move the owner makes counts: the address the app
// is still settling on when the guide opens is not one.
let stopWatchingRoute: (() => void) | null = null;
let unmounted = false;
void router.isReady().then(() => {
  if (unmounted) return;
  stopWatchingRoute = router.afterEach((to, from) => {
    if (to.path !== from.path) props.guide.close();
  });
});
onBeforeUnmount(() => {
  unmounted = true;
  stopWatchingRoute?.();
});

// ── 1 언제 일할 수 있나요? ──────────────────────────────────────────────
async function saveHours(): Promise<void> {
  const current = availability.value;
  if (current === null || hoursDraft.value.length === 0 || busy.value || !offline.mutationsEnabled) return;
  touched = true;
  const payload: AvailabilityPut = {
    timeZone: current.timeZone,
    rules: hoursDraft.value.map((rule) => ({ ...rule })),
    exceptions: current.exceptions.map((exception) => ({ ...exception })),
    prefs: { ...current.prefs },
  };
  const scope = 'first-run:availability';
  const action = actions.begin(scope, payload, (left, right) => JSON.stringify(left) === JSON.stringify(right), current.version);
  busy.value = true;
  error.value = null;
  await runOwnerBound(
    function* (owner) {
      try {
        const saved = yield* owner.wait(plannerClient.putAvailability(action.payload, action.key, current.version));
        actions.settle(scope, action);
        queryClient.setQueryData(['availability'], saved);
        advance();
      } catch (cause) {
        if (cause instanceof ApiError) actions.settle(scope, action);
        if (cause instanceof ApiError && cause.status === 412) {
          // Changed elsewhere meanwhile: show what is there now, and let the owner decide again.
          const fresh = yield* owner.wait(plannerClient.getAvailability({ fresh: true }));
          queryClient.setQueryData(['availability'], fresh);
          error.value = t('planScope.availability.conflict');
        } else {
          error.value = errorMessage(cause, t('availability.saveError'));
        }
      }
    },
    {
      onSettled: () => {
        busy.value = false;
      },
    },
  );
}

// ── 3 AI가 도와줄까요? ──────────────────────────────────────────────────
async function allowAi(): Promise<void> {
  if (busy.value || !offline.mutationsEnabled) return;
  touched = true;
  busy.value = true;
  error.value = null;
  await runOwnerBound(
    function* (owner) {
      yield* owner.wait(auth.setLlmConsent(true));
      advance();
    },
    {
      onError: () => {
        error.value = t('llm.settings.updateError');
      },
      onSettled: () => {
        busy.value = false;
      },
    },
  );
}

function next(): void {
  touched = true;
  advance();
}

/** The ending: into the first stage of the loop. */
function startCapturing(): void {
  props.guide.end();
  ui.openCapture('capture');
}

function close(): void {
  // Closed without an answer to the AI question: it is not asked again right behind the guide.
  if (llmConsent.undecided) llmConsent.closed();
  props.guide.close();
}
</script>

<template>
  <UiDialog labelledby="first-run-title" size="lg" class="first-run" :dismissible="!busy" data-first-run :data-first-run-step="at" @close="close">
    <header class="dialog-header">
      <div class="dialog-heading">
        <p class="first-run-eyebrow">{{ t('firstRun.eyebrow') }}</p>
        <!-- The question takes the focus when the guide opens (not 닫기, the first control); the ending's button keeps it. -->
        <h2 id="first-run-title" ref="heading" class="dialog-title" tabindex="-1" :data-autofocus="at === 'ready' ? undefined : ''">
          {{ t(`firstRun.${at}.title`) }}
        </h2>
        <p class="muted">{{ t(`firstRun.${at}.lede`) }}</p>
      </div>
      <button type="button" class="btn btn--ghost btn--icon" :aria-label="t('firstRun.close')" :disabled="busy" data-first-run-close @click="close">
        <UiIcon name="close" />
      </button>
    </header>

    <ol class="first-run-steps" :aria-label="t('firstRun.steps')">
      <li
        v-for="(step, position) in FIRST_RUN_STEPS"
        :key="step"
        class="first-run-step"
        :class="{
          'first-run-step--current': step === at,
          'first-run-step--done': guide.states.value[step] === 'done',
          'first-run-step--skipped': guide.states.value[step] === 'skipped',
        }"
        :aria-current="step === at ? 'step' : undefined"
        :data-first-run-state="guide.states.value[step]"
      >
        <span class="first-run-step-mark" aria-hidden="true">
          <UiIcon v-if="guide.states.value[step] === 'done'" name="check" :size="14" />
          <template v-else>{{ position + 1 }}</template>
        </span>
        <span class="first-run-step-name">{{ t(`firstRun.${step}.short`) }}</span>
        <span class="visually-hidden">{{ t(`firstRun.state.${guide.states.value[step]}`) }}</span>
      </li>
    </ol>

    <UiBanner v-if="!offline.mutationsEnabled" tone="offline" inline role="status">{{ t('firstRun.offline') }}</UiBanner>
    <UiBanner v-if="error" tone="error" role="alert" data-first-run-error>{{ error }}</UiBanner>

    <div class="first-run-body">
      <PlanAvailabilityStep
        v-if="at === 'hours'"
        v-model:rules="hoursDraft"
        :disabled="!offline.mutationsEnabled || busy || availability === null"
      />
      <PlanCommitmentStep v-else-if="at === 'commitments'" :time-zone="timeZone" :date="today" :offer-google="offerGoogle" />
      <div v-else-if="at === 'ai'" class="card first-run-ai" data-first-run-ai>
        <LlmDisclosure />
      </div>
      <p v-else class="first-run-ready" data-first-run-ready>{{ t('firstRun.ready.body') }}</p>
    </div>

    <div class="dialog-actions">
      <button v-if="at !== 'ready'" type="button" class="first-run-skip" :disabled="busy" data-first-run-skip @click="skip">
        {{ at === 'ai' ? t('firstRun.later') : t('firstRun.skip') }}
      </button>
      <UiButton
        v-if="at === 'hours'"
        variant="primary"
        :busy="busy"
        :disabled="busy || hoursDraft.length === 0 || !offline.mutationsEnabled || availability === null"
        data-first-run-next
        @click="saveHours"
      >
        {{ busy ? t('common.saving') : t('firstRun.hours.next') }}
      </UiButton>
      <UiButton v-else-if="at === 'commitments'" variant="primary" data-first-run-next @click="next">
        {{ t('firstRun.next') }}
      </UiButton>
      <UiButton
        v-else-if="at === 'ai'"
        variant="primary"
        :busy="busy"
        :disabled="busy || !offline.mutationsEnabled"
        data-first-run-next
        @click="allowAi"
      >
        {{ t('firstRun.ai.allow') }}
      </UiButton>
      <UiButton v-else variant="primary" icon="plus" data-autofocus data-first-run-next @click="startCapturing">
        {{ t('firstRun.ready.start') }}
      </UiButton>
    </div>
  </UiDialog>
</template>
