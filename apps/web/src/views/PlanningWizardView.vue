<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, reactive, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useQuery, useQueryClient } from '@tanstack/vue-query';
import {
  AI_REQUEST_CLIENT_BOUND_MS,
  ActionStore,
  AiRequestTimeoutError,
  ApiError,
  plannerClient,
  type DecompositionDraft,
  type DecompositionStep,
  type IntakeAnswerInput,
  type IntakeField,
  type IntakeInput,
  type IdempotentAction,
  type IntakeSession,
  type PlannedQuestion,
} from '../api';
import {
  generalIssues,
  issuesForStep,
  validateDraft,
  type DraftIssue,
} from '../domain/draftValidation';
import { useOfflineStore } from '../stores/offline';
import UiBadge from '../components/ui/UiBadge.vue';
import UiBanner from '../components/ui/UiBanner.vue';
import UiButton from '../components/ui/UiButton.vue';
import UiCard from '../components/ui/UiCard.vue';
import UiField from '../components/ui/UiField.vue';
import UiIcon from '../components/ui/UiIcon.vue';
import UiSpinner from '../components/ui/UiSpinner.vue';
import AiWaitPanel from '../components/AiWaitPanel.vue';
import {
  AI_WAIT_POLL_MS,
  readStoredAiWait,
  sessionAwaitsAi,
  useAiWait,
  type AiWaitKind,
  type PendingAiWait,
} from '../composables/useAiWait';
import { t } from '../i18n';
import I18nT from '../i18n/I18nT';
import { formatPercent } from '../i18n/format';
import { apiErrorMessage, errorMessage, problemMessage } from '../i18n/problem';
import { assumptionValueText, detectionReasonText, type ServerText } from '../i18n/server';
import { isProblemCode } from '../api/errors';

const props = defineProps<{ sessionId?: string }>();

const route = useRoute();
const router = useRouter();
const queryClient = useQueryClient();
const offline = useOfflineStore();
const actions = new ActionStore();

const STEPS = [1, 2, 3, 4, 5] as const;
const SCOPE_OPTIONS = ['small', 'medium', 'large'] as const;
const STEP_KINDS = ['prep', 'work', 'review', 'buffer'] as const;
const ASSUMPTION_REASONS = ['skip', 'idk', 'unanswered'] as const;
type AssumptionReason = (typeof ASSUMPTION_REASONS)[number];

function stepLabel(step: number): string {
  return (STEPS as readonly number[]).includes(step) ? t(`wizard.steps.${step as (typeof STEPS)[number]}`) : '';
}

const heading = ref<HTMLElement | null>(null);
const liveMessage = ref('');
const busyCount = ref(0);
const busy = computed(() => busyCount.value > 0);
const mutationError = ref<string | null>(null);
const draftConflict = ref(false);
const llmIssue = ref<string | null>(null);

const form = reactive({ title: '', dueAt: '', description: '', fileName: '' });
const creating = ref(false);

const sessionId = computed(() => {
  if (props.sessionId !== undefined && props.sessionId.length > 0) return props.sessionId;
  const param = route.params['sessionId'];
  return typeof param === 'string' ? param : '';
});
const isNew = computed(() => sessionId.value.length === 0);

const sessionQuery = useQuery({
  queryKey: computed(() => ['intake', sessionId.value]),
  queryFn: () => plannerClient.getIntakeSession(sessionId.value, { fresh: true }),
  enabled: computed(() => sessionId.value.length > 0),
});

const session = computed<IntakeSession | null>(() => sessionQuery.data.value ?? null);

const templateId = computed(() => session.value?.detectedType?.templateId);
const templateQuery = useQuery({
  queryKey: computed(() => ['template', templateId.value ?? 'none']),
  queryFn: () => plannerClient.getTaskTemplate(templateId.value ?? ''),
  enabled: computed(() => templateId.value !== undefined),
});
const templateName = computed(
  () => templateQuery.data.value?.name ?? session.value?.detectedType?.templateId ?? t('wizard.templateFallback'),
);

const currentStep = computed<number>(() => {
  if (session.value === null) return 1;
  const state = session.value.state;
  if (state === 'cancelled' || state === 'failed') return 0;
  if (state === 'created') return 1;
  if (state === 'type_detection') return 2;
  if (state === 'clarification') {
    return session.value.detectedType?.classification === 'similar' ? 2 : 3;
  }
  if (state === 'needs_input') {
    if (session.value.draft !== undefined) return 4;
    return session.value.detectedType?.classification === 'similar' ? 2 : 3;
  }
  if (state === 'decomposition') return 4;
  return 5;
});

const terminal = computed(() => currentStep.value === 0);
const paused = computed(() => session.value?.state === 'needs_input');
const canPause = computed(() => session.value?.state === 'clarification');
const canResume = computed(() => session.value?.state === 'needs_input');
function hasLocalValue(field: IntakeField): boolean {
  const value = session.value?.input[field];
  if (value === undefined || value === null) return false;
  if (typeof value === 'string') return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  return true;
}

const questions = computed<PlannedQuestion[]>(() =>
  (session.value?.questions ?? []).filter((question) => !hasLocalValue(question.field)),
);
const assumptions = computed(() => session.value?.assumptions ?? []);
// FU-76: one in-flight AI wait at a time; other mutations wait for it.
const aiWait = useAiWait();
const aiPanel = ref<InstanceType<typeof AiWaitPanel> | null>(null);
const aiWaiting = computed(() => aiWait.pending.value !== null);
const canMutate = computed(() => offline.mutationsEnabled && !busy.value && !aiWaiting.value);
const questionsLocked = computed(() => !canMutate.value || paused.value);
const draftLocked = computed(() => !canMutate.value || paused.value);

const answerText = reactive<Record<string, string>>({});
const answerNumber = reactive<Record<string, number>>({});
const answerBoolean = reactive<Record<string, boolean>>({});

const draft = ref<DecompositionDraft | null>(null);
let disposed = false;
onUnmounted(() => {
  disposed = true;
});

const draftValidation = computed(() =>
  draft.value === null ? { valid: true, issues: [] } : validateDraft(draft.value),
);
const draftIssues = computed<readonly DraftIssue[]>(() => draftValidation.value.issues);
const generalDraftIssues = computed(() => generalIssues(draftValidation.value));

function cloneDraft(value: DecompositionDraft): DecompositionDraft {
  return {
    steps: value.steps.map((step) => ({
      ...step,
      estimate: { ...step.estimate },
      dependsOn: [...step.dependsOn],
    })),
    assumptions: [...value.assumptions],
    questionsRemaining: [...value.questionsRemaining],
  };
}

watch(
  () => session.value?.draft,
  (value) => {
    if (value !== undefined && draft.value === null) draft.value = cloneDraft(value);
  },
  { immediate: true },
);

function llmIssueText(code: string): string {
  const reason = isProblemCode(code) ? problemMessage(code) : t('aiWait.errors.unknown');
  return `${reason} ${t('wizard.llmCode', { code })}`;
}

/** FU-76 session error codes with their own (calmer) notices instead of the LLM banner. */
const AI_RUN_CODES: ReadonlySet<string> = new Set(['ai_interrupted', 'ai_cancelled']);

watch(
  () => session.value?.error,
  (error) => {
    if (error !== undefined && !AI_RUN_CODES.has(error.code)) llmIssue.value = llmIssueText(error.code);
    if (error !== undefined && AI_RUN_CODES.has(error.code)) llmIssue.value = null;
  },
  { immediate: true },
);

const sessionErrorCode = computed(() => session.value?.error?.code);
/** Interrupted decomposition with nothing running: offer 다시 시도 (POST :resume). */
const interruptedDecomposition = computed(
  () =>
    sessionErrorCode.value === 'ai_interrupted' &&
    session.value?.state === 'decomposition' &&
    session.value.manual === false &&
    session.value.draft === undefined,
);
const interruptedFallback = computed(
  () => sessionErrorCode.value === 'ai_interrupted' && !interruptedDecomposition.value,
);
const cancelledNotice = computed(() => sessionErrorCode.value === 'ai_cancelled');

watch(currentStep, async (next, previous) => {
  if (next === previous) return;
  if (next === 0) {
    liveMessage.value = t('wizard.endedLive');
    return;
  }
  liveMessage.value = t('wizard.stepLive', { step: next, label: stepLabel(next) });
  await nextTick();
  heading.value?.focus();
});

function applySession(updated: IntakeSession): void {
  queryClient.setQueryData(['intake', updated.id], updated);
  if (updated.draft !== undefined && draft.value === null) draft.value = cloneDraft(updated.draft);
  if (updated.manual && updated.error === undefined) llmIssue.value = null;
}

async function refreshSession(): Promise<IntakeSession | null> {
  if (sessionId.value.length === 0) return null;
  try {
    const fresh = await plannerClient.getIntakeSession(sessionId.value, { fresh: true });
    queryClient.setQueryData(['intake', fresh.id], fresh);
    return fresh;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// FU-76: waiting for long AI calls.
// ---------------------------------------------------------------------------

let aiController: AbortController | null = null;
let aiCancelRequested = false;
let pollToken = 0;

function freshAiSignal(): AbortSignal {
  aiController = new AbortController();
  aiCancelRequested = false;
  return aiController.signal;
}

/**
 * The response did not arrive but the request may have run: a network error,
 * the client bound, or a proxy error without a problem body. The session (or
 * the idempotent create replay) is polled instead of re-submitting.
 */
function isConnectionLoss(cause: unknown): boolean {
  if (cause instanceof TypeError || cause instanceof AiRequestTimeoutError) return true;
  if (cause instanceof DOMException && cause.name === 'AbortError') return true;
  return (
    cause instanceof ApiError &&
    cause.code === 'unknown' &&
    (cause.status === 0 || cause.status === 502 || cause.status === 503 || cause.status === 504)
  );
}

function isInProgress(cause: unknown): cause is ApiError {
  return cause instanceof ApiError && cause.status === 409 && cause.code === 'idempotency_in_progress';
}

async function focusAfterWait(wasShown: boolean): Promise<void> {
  if (!wasShown) return;
  await nextTick();
  heading.value?.focus();
}

function finishWithSession(updated: IntakeSession, outcome: 'done' | 'cancelled'): void {
  const wasShown = aiWait.revealed.value;
  aiController = null;
  applySession(updated);
  aiWait.finish(outcome);
  void focusAfterWait(wasShown);
}

watch(
  () => aiWait.revealed.value,
  async (shown) => {
    if (!shown) return;
    await nextTick();
    aiPanel.value?.focus();
  },
);

/** Reloaded or reconnected: follow the session state, never re-submit. */
async function pollSession(id: string): Promise<void> {
  const token = ++pollToken;
  for (;;) {
    if (disposed || token !== pollToken || aiWait.pending.value === null) return;
    if (!offline.online) {
      aiWait.connectionLost.value = true;
    } else {
      try {
        const fresh = await plannerClient.getIntakeSession(id, { fresh: true });
        if (disposed || token !== pollToken) return;
        aiWait.connectionLost.value = false;
        if (sessionAwaitsAi(fresh) === null) {
          finishWithSession(fresh, 'done');
          return;
        }
        queryClient.setQueryData(['intake', fresh.id], fresh);
      } catch (cause) {
        if (token !== pollToken) return;
        if (isConnectionLoss(cause)) {
          aiWait.connectionLost.value = true;
        } else {
          aiWait.finish('silent');
          handleError(cause);
          return;
        }
      }
    }
    await delay(AI_WAIT_POLL_MS);
  }
}

/** A create replay (same Idempotency-Key) until the stored outcome exists. */
async function replayCreate(input: IntakeInput, key: string): Promise<IntakeSession | null> {
  const token = ++pollToken;
  for (;;) {
    if (disposed || token !== pollToken) return null;
    const started = aiWait.pending.value?.startedAt ?? Date.now();
    if (aiWait.cancelling.value && Date.now() - started > AI_REQUEST_CLIENT_BOUND_MS) return null;
    if (!offline.online) {
      aiWait.connectionLost.value = true;
      await delay(AI_WAIT_POLL_MS);
      continue;
    }
    try {
      const created = await plannerClient.createIntakeSession(input, key);
      aiWait.connectionLost.value = false;
      return token === pollToken ? created : null;
    } catch (cause) {
      if (token !== pollToken) return null;
      if (isInProgress(cause)) {
        await delay(Math.max(1, cause.retryAfterSeconds ?? 1) * 1_000);
        continue;
      }
      if (isConnectionLoss(cause)) {
        aiWait.connectionLost.value = true;
        await delay(AI_WAIT_POLL_MS);
        continue;
      }
      throw cause;
    }
  }
}

function finishCreateWithError(cause: unknown): void {
  aiController = null;
  aiWait.finish('silent');
  creating.value = false;
  handleError(cause);
}

async function onCreated(created: IntakeSession, outcome: 'done' | 'cancelled' = 'done'): Promise<void> {
  const action = actions.peek<IntakeInput>('intake:create');
  if (action !== undefined) actions.settle('intake:create', action);
  queryClient.setQueryData(['intake', created.id], created);
  aiController = null;
  aiWait.finish(outcome);
  creating.value = false;
  await router.push({ name: 'plan-session', params: { sessionId: created.id } });
}

async function sendCreate(input: IntakeInput, key: string): Promise<void> {
  const signal = freshAiSignal();
  try {
    const created = await plannerClient.createIntakeSession(input, key, { signal });
    await onCreated(created);
  } catch (cause) {
    if (aiCancelRequested || disposed) return;
    if (!isConnectionLoss(cause) && !isInProgress(cause)) {
      finishCreateWithError(cause);
      return;
    }
    try {
      const created = await replayCreate(input, key);
      if (created !== null) await onCreated(created);
    } catch (replayCause) {
      finishCreateWithError(replayCause);
    }
  }
}

/**
 * Answers / type confirmation / 다시 시도 may run the decomposition. The wait
 * is recorded at once (so a reload resumes it) but only shown once the request
 * is actually slow; a quick answer never flashes the panel.
 */
async function sendAiMutation(
  current: IntakeSession,
  scope: string,
  token: IdempotentAction<unknown>,
  send: (signal: AbortSignal) => Promise<IntakeSession>,
  reveal: 'now' | 'delayed' = 'delayed',
  kind: AiWaitKind = 'decomposition',
): Promise<IntakeSession | undefined> {
  if (!offline.mutationsEnabled) {
    mutationError.value = t('wizard.offlineMutation');
    return undefined;
  }
  mutationError.value = null;
  aiWait.start({ kind, startedAt: Date.now(), sessionId: current.id }, { reveal });
  const signal = freshAiSignal();
  try {
    const updated = await send(signal);
    actions.settle(scope, token);
    finishWithSession(updated, 'done');
    return updated;
  } catch (cause) {
    if (aiCancelRequested || disposed) return undefined;
    if (isConnectionLoss(cause)) {
      aiWait.connectionLost.value = !offline.online;
      void pollSession(current.id);
      return undefined;
    }
    aiController = null;
    aiWait.finish('silent');
    handleError(cause);
    return undefined;
  }
}

/** 취소 or 직접 작성으로 계속 during a wait: POST :manual stops the run server-side. */
async function stopAiWait(): Promise<void> {
  const pending = aiWait.pending.value;
  if (pending === null || aiWait.cancelling.value) return;
  aiWait.cancelling.value = true;
  aiCancelRequested = true;
  aiController?.abort();
  pollToken += 1;
  let id = pending.sessionId;
  if (id === undefined && pending.create !== undefined) {
    // The create has not returned its id yet: the same key replays it once the
    // (short) type detection is stored, then the session goes manual.
    let created: IntakeSession | null = null;
    try {
      created = await replayCreate(pending.create.input, pending.create.key);
    } catch {
      created = null;
    }
    if (created === null) {
      // Could not reach it within the bound: keep the inputs on step 1.
      aiWait.finish('silent');
      actions.clear();
      creating.value = false;
      mutationError.value = t('aiWait.overdue');
      return;
    }
    id = created.id;
    queryClient.setQueryData(['intake', created.id], created);
  }
  if (id === undefined) {
    aiWait.finish('silent');
    return;
  }
  try {
    const fresh = await plannerClient.getIntakeSession(id, { fresh: true });
    const scope = `intake:${id}:manual`;
    const token = actions.begin(scope, { manual: true }, samePayload, fresh.version);
    const manual = await plannerClient.enterManualIntakeMode(id, token.key, fresh.version);
    actions.settle(scope, token);
    if (pending.create !== undefined) await onCreated(manual, 'cancelled');
    else finishWithSession(manual, 'cancelled');
  } catch (cause) {
    aiController = null;
    aiWait.finish('silent');
    creating.value = false;
    handleError(cause);
    if (pending.create !== undefined && id !== undefined) {
      await router.push({ name: 'plan-session', params: { sessionId: id } });
    }
  }
}

/** Overdue / reconnect: look at the state now instead of waiting for the next poll. */
async function checkAiNow(): Promise<void> {
  const pending = aiWait.pending.value;
  if (pending === null) return;
  if (pending.sessionId !== undefined) {
    void pollSession(pending.sessionId);
    return;
  }
  if (pending.create !== undefined) {
    try {
      const created = await replayCreate(pending.create.input, pending.create.key);
      if (created !== null) await onCreated(created);
    } catch (cause) {
      finishCreateWithError(cause);
    }
  }
}

async function continueManually(): Promise<void> {
  if (aiWaiting.value) await stopAiWait();
  else await enterManual();
}

async function retryAi(): Promise<void> {
  const current = session.value;
  if (current === null) return;
  const scope = `intake:${current.id}:retry`;
  const token = actions.begin(scope, { retry: true }, samePayload, current.version);
  await sendAiMutation(
    current,
    scope,
    token,
    (signal) => plannerClient.resumeIntakeSession(current.id, token.key, current.version, { signal }),
    'now',
  );
}

// A reload (or another device) finds the session still waiting for the AI.
watch(
  session,
  (value) => {
    if (value === null || aiWait.pending.value !== null) return;
    const kind = sessionAwaitsAi(value);
    if (kind === null) return;
    const stored = readStoredAiWait();
    const updatedAt = Date.parse(value.updatedAt);
    const startedAt =
      stored?.sessionId === value.id
        ? stored.startedAt
        : Number.isFinite(updatedAt)
          ? Math.min(Date.now(), updatedAt)
          : Date.now();
    aiWait.start({ kind, startedAt, sessionId: value.id }, { reveal: 'now' });
    void pollSession(value.id);
  },
  { immediate: true },
);

// A reload during the create (type detection) replays the same request key.
onMounted(() => {
  if (!isNew.value) return;
  const stored: PendingAiWait | null = readStoredAiWait();
  if (stored?.create === undefined || stored.sessionId !== undefined) return;
  form.title = stored.create.form.title;
  form.dueAt = stored.create.form.dueAt;
  form.description = stored.create.form.description;
  form.fileName = stored.create.form.fileName;
  creating.value = true;
  aiWait.start(stored, { reveal: 'now' });
  const { input, key } = stored.create;
  void (async () => {
    try {
      const created = await replayCreate(input, key);
      if (created !== null) await onCreated(created);
    } catch (cause) {
      finishCreateWithError(cause);
    }
  })();
});

function handleError(cause: unknown): void {
  if (cause instanceof ApiError) {
    if (cause.code === 'llm_unavailable' || cause.code === 'budget_exceeded') {
      llmIssue.value = llmIssueText(cause.code);
      mutationError.value = null;
      return;
    }
    if (cause.status === 412) {
      draftConflict.value = true;
      mutationError.value = null;
      void refreshSession();
      return;
    }
    if (cause.status === 409) {
      mutationError.value = t('wizard.refreshedAfterConflict', { message: apiErrorMessage(cause) });
      void refreshSession();
      return;
    }
    mutationError.value = apiErrorMessage(cause);
    return;
  }
  mutationError.value = errorMessage(cause, t('wizard.requestFailed'));
}

async function run<T>(operation: () => Promise<T>): Promise<T | undefined> {
  if (!offline.mutationsEnabled) {
    mutationError.value = t('wizard.offlineMutation');
    return undefined;
  }
  busyCount.value += 1;
  mutationError.value = null;
  try {
    return await operation();
  } catch (cause) {
    handleError(cause);
    return undefined;
  } finally {
    busyCount.value -= 1;
  }
}

function toInstant(value: string): string | undefined {
  if (value.length === 0) return undefined;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

function buildInput(): IntakeInput {
  const input: IntakeInput = { title: form.title.trim() };
  const dueAt = toInstant(form.dueAt);
  if (dueAt !== undefined) input.dueAt = dueAt;
  const context = [
    form.description.trim(),
    form.fileName.trim().length > 0 ? `file: ${form.fileName.trim()}` : '',
  ].filter((part) => part.length > 0);
  if (context.length > 0) input.description = context.join('\n').slice(0, 4_000);
  return input;
}

const samePayload = (left: unknown, right: unknown): boolean =>
  JSON.stringify(left) === JSON.stringify(right);

async function createSession(): Promise<void> {
  if (form.title.trim().length === 0) {
    mutationError.value = t('wizard.titleRequired');
    return;
  }
  if (!offline.mutationsEnabled) {
    mutationError.value = t('wizard.offlineMutation');
    return;
  }
  if (creating.value) return;
  mutationError.value = null;
  creating.value = true;
  const input = buildInput();
  const action = actions.begin('intake:create', input, samePayload);
  // FU-76: type detection waits for the AI; the record lets a reload replay
  // the same key (and restore these inputs) instead of creating twice.
  aiWait.start(
    {
      kind: 'type_detection',
      startedAt: Date.now(),
      create: { key: action.key, input, form: { ...form } },
    },
    { reveal: 'delayed' },
  );
  await sendCreate(input, action.key);
}

async function confirmType(similar: boolean): Promise<void> {
  const current = session.value;
  const detected = current?.detectedType;
  if (current === null || detected === undefined) return;
  const confirmation =
    similar && detected.templateId !== undefined
      ? { similar: true as const, templateId: detected.templateId }
      : { similar: false as const };
  const scope = `intake:${current.id}:type`;
  const action = actions.begin(scope, confirmation, samePayload, current.version);
  await sendAiMutation(current, scope, action, (signal) =>
    plannerClient.confirmIntakeType(current.id, confirmation, action.key, current.version, {
      signal,
    }),
  );
}

function isBooleanField(field: IntakeField): boolean {
  return field === 'availabilityConfirmed' || field === 'reviewNeeded';
}

function isNumberField(field: IntakeField): boolean {
  return field === 'priority' || field === 'maxFocusMinutes';
}

function isSelectField(field: IntakeField): boolean {
  return field === 'estimatedScope';
}

function answerValue(question: PlannedQuestion): string | number | boolean | undefined {
  const field = question.field;
  if (isBooleanField(field)) return answerBoolean[field] ?? false;
  if (isNumberField(field)) return answerNumber[field];
  if (isSelectField(field)) return answerText[field];
  return answerText[field];
}

async function answer(question: PlannedQuestion, action: 'answer' | 'skip' | 'idk'): Promise<void> {
  const current = session.value;
  if (current === null) return;
  let value: string | number | boolean | undefined;
  if (action === 'answer') {
    value = answerValue(question);
    if (value === undefined || (typeof value === 'string' && value.trim().length === 0)) {
      mutationError.value = t('wizard.answerRequired');
      return;
    }
    if (typeof value === 'number' && !Number.isFinite(value)) {
      mutationError.value = t('wizard.numberRequired');
      return;
    }
    if (typeof value === 'string') value = value.trim();
  }
  const payload: IntakeAnswerInput =
    action === 'answer'
      ? { questionKey: question.field, action: 'answer', value: value as string | number | boolean }
      : { questionKey: question.field, action };
  const scope = `intake:${current.id}:answers:${question.field}`;
  const actionToken = actions.begin(scope, payload, samePayload, current.version);
  const updated = await sendAiMutation(current, scope, actionToken, (signal) =>
    plannerClient.answerIntakeQuestions(current.id, [payload], actionToken.key, current.version, {
      signal,
    }),
  );
  if (updated !== undefined) answerText[question.field] = '';
}

async function enterManual(): Promise<void> {
  const current = session.value;
  if (current === null) return;
  const scope = `intake:${current.id}:manual`;
  const action = actions.begin(scope, { manual: true }, samePayload, current.version);
  const updated = await run(() =>
    plannerClient.enterManualIntakeMode(current.id, action.key, current.version),
  );
  if (updated === undefined) return;
  actions.settle(scope, action);
  applySession(updated);
}

async function sessionAction(action: 'pause' | 'resume' | 'cancel'): Promise<void> {
  const current = session.value;
  if (current === null) return;
  const scope = `intake:${current.id}:${action}`;
  const token = actions.begin(scope, { action }, samePayload, current.version);
  const updated = await run(() => {
    if (action === 'pause') {
      return plannerClient.pauseIntakeSession(current.id, token.key, current.version);
    }
    if (action === 'resume') {
      return plannerClient.resumeIntakeSession(current.id, token.key, current.version);
    }
    return plannerClient.cancelIntakeSession(current.id, token.key, current.version);
  });
  if (updated === undefined) return;
  actions.settle(scope, token);
  applySession(updated);
}

function issuesFor(step: DecompositionStep): readonly DraftIssue[] {
  return issuesForStep(draftValidation.value, step.key);
}

function toggleDependency(step: DecompositionStep, key: string): void {
  if (step.dependsOn.includes(key)) {
    step.dependsOn = step.dependsOn.filter((ref) => ref !== key);
  } else {
    step.dependsOn = [...step.dependsOn, key];
  }
}

function nextKey(): string {
  const used = new Set((draft.value?.steps ?? []).map((step) => step.key));
  for (let index = 1; index <= 12; index += 1) {
    const key = `s${index}`;
    if (!used.has(key)) return key;
  }
  return 's12';
}

function addStep(): void {
  if (draft.value === null || draft.value.steps.length >= 12) return;
  const key = nextKey();
  draft.value.steps = [
    ...draft.value.steps,
    {
      key,
      title: t('wizard.newStep'),
      deliverable: '',
      doneCriteria: '',
      kind: 'work',
      estimate: { p50Minutes: 30, p90Minutes: 45 },
      dependsOn: [],
      splittable: true,
    },
  ];
}

function removeStep(index: number): void {
  if (draft.value === null || draft.value.steps.length <= 3) return;
  const removed = draft.value.steps[index];
  if (removed === undefined) return;
  draft.value.steps = draft.value.steps
    .filter((_step, position) => position !== index)
    .map((step) => ({
      ...step,
      dependsOn: step.dependsOn.filter((ref) => ref !== removed.key),
    }));
}

async function persistDraft(): Promise<boolean> {
  const current = session.value;
  if (current === null || draft.value === null) return false;
  if (!draftValidation.value.valid) {
    mutationError.value = t('wizard.draftInvalid');
    return false;
  }
  if (JSON.stringify(draft.value) === JSON.stringify(current.draft)) return true;
  const patch = {
    steps: draft.value.steps,
    assumptions: draft.value.assumptions,
    questionsRemaining: draft.value.questionsRemaining,
  };
  const scope = `intake:${current.id}:draft`;
  const action = actions.begin(scope, patch, samePayload, current.version);
  const updated = await run(() =>
    plannerClient.updateIntakeDraft(current.id, patch, action.key, current.version),
  );
  if (updated === undefined) return false;
  actions.settle(scope, action);
  draft.value = cloneDraft(updated);
  draftConflict.value = false;
  await refreshSession();
  return true;
}

async function saveDraft(): Promise<void> {
  const saved = await persistDraft();
  if (saved) mutationError.value = null;
}

async function approve(): Promise<void> {
  if (busy.value) return;
  const saved = await persistDraft();
  if (!saved) return;
  const current = session.value;
  if (current === null || current.state !== 'decomposition') {
    await refreshSession();
    return;
  }
  const scope = `intake:${current.id}:approve`;
  const action = actions.begin(scope, { id: current.id }, samePayload, current.version);
  const updated = await run(async () => {
    for (let attempt = 0; ; attempt += 1) {
      // The view may have been disposed, or the connection may have dropped
      // during Retry-After. Never send the delayed request offline; leaving the
      // action unsettled preserves the same idempotency key for the next retry.
      if (disposed) return undefined;
      if (!offline.mutationsEnabled) {
        mutationError.value = t('wizard.approveOffline');
        return undefined;
      }
      try {
        return await plannerClient.approveIntakeDraft(current.id, action.key, current.version);
      } catch (cause) {
        if (
          cause instanceof ApiError &&
          cause.status === 409 &&
          cause.code === 'approval_in_progress' &&
          attempt < 5
        ) {
          const seconds = Math.max(cause.retryAfterSeconds ?? 1, 0);
          liveMessage.value = t('wizard.approveRetrying', { seconds });
          await delay(seconds * 1_000);
          continue;
        }
        throw cause;
      }
    }
  });
  if (updated === undefined) return;
  actions.settle(scope, action);
  applySession(updated);
}

async function reloadDraft(): Promise<void> {
  const fresh = await refreshSession();
  if (fresh?.draft !== undefined) draft.value = cloneDraft(fresh.draft);
  draftConflict.value = false;
  mutationError.value = null;
}

function retry(): void {
  void sessionQuery.refetch();
}

function reasonLabel(reason: string): string {
  return (ASSUMPTION_REASONS as readonly string[]).includes(reason)
    ? t(`wizard.assumptionReasons.${reason as AssumptionReason}`)
    : reason;
}

function fieldLabel(field: IntakeField): string {
  return t(`wizard.fields.${field}`);
}

function questionPrompt(question: PlannedQuestion): string {
  return t(`wizard.questions.${question.field}`);
}

function assumptionValue(field: IntakeField, value: string): ServerText {
  return assumptionValueText(field, value);
}

function stepKindLabel(kind: string): string {
  return (STEP_KINDS as readonly string[]).includes(kind)
    ? t(`wizard.kinds.${kind as (typeof STEP_KINDS)[number]}`)
    : kind;
}

const confidencePercent = computed(() =>
  Math.round((session.value?.detectedType?.confidence ?? 0) * 100),
);
const detectedReasons = computed(() =>
  (session.value?.detectedType?.reasons ?? []).flatMap((reason) => {
    const text = detectionReasonText(reason);
    return text === null ? [] : [{ key: reason, ...text }];
  }),
);
const confidenceLabel = computed(() => formatPercent(confidencePercent.value / 100, 0));
</script>

<template>
  <section class="page wizard" aria-labelledby="wizard-heading">
    <header class="page-header">
      <div class="page-heading">
        <p class="breadcrumb">
          <RouterLink to="/inbox"><UiIcon name="arrow-left" :size="16" />{{ t('wizard.back') }}</RouterLink>
        </p>
        <h1 id="wizard-heading" ref="heading" tabindex="-1">{{ t('wizard.title') }}</h1>
        <p class="page-lede">{{ t('wizard.lede') }}</p>
      </div>
      <div v-if="session !== null && !terminal && currentStep < 5" class="page-actions wizard-controls">
        <UiButton
          v-if="canPause"
          size="sm"
          icon="pause"
          :disabled="!canMutate"
          @click="sessionAction('pause')"
        >
          {{ t('wizard.pause') }}
        </UiButton>
        <UiButton v-else-if="canResume" size="sm" icon="play" :disabled="!canMutate" @click="sessionAction('resume')">
          {{ t('wizard.resume') }}
        </UiButton>
        <UiButton size="sm" variant="danger-ghost" class="danger" :disabled="!canMutate" @click="sessionAction('cancel')">
          {{ t('wizard.cancel') }}
        </UiButton>
      </div>
    </header>

    <p class="visually-hidden" aria-live="polite">{{ liveMessage }}</p>
    <p class="visually-hidden" aria-live="polite" data-testid="ai-wait-live">{{ aiWait.announcement.value }}</p>

    <nav :aria-label="t('wizard.stepper')" class="wizard-stepper">
      <ol class="wizard-progress">
        <li
          v-for="(step, index) in STEPS"
          :key="step"
          :class="{
            'wizard-progress--current': currentStep === index + 1,
            'wizard-progress--done': currentStep > index + 1,
          }"
          :aria-current="currentStep === index + 1 ? 'step' : undefined"
        >
          <span class="wizard-progress-number">
            <UiIcon v-if="currentStep > index + 1" name="check" :size="14" />
            <template v-else>{{ index + 1 }}</template>
          </span>
          <span class="wizard-progress-label">{{ stepLabel(step) }}</span>
          <span v-if="index === 4" class="wizard-progress-note">{{ t('wizard.comingSoon') }}</span>
        </li>
      </ol>
    </nav>

    <UiBanner
      v-if="llmIssue !== null"
      tone="error"
      class="llm-banner"
      role="alert"
      :title="t('wizard.llmTitle')"
    >
      <p>{{ t('wizard.llmBody', { reason: llmIssue }) }}</p>
      <p>{{ t('wizard.llmContinue') }}</p>
      <template #actions>
        <UiButton v-if="session !== null && !terminal" size="sm" :disabled="!canMutate" @click="enterManual">
          {{ t('wizard.toManual') }}
        </UiButton>
        <UiButton v-else size="sm" icon="sync" :disabled="creating" @click="createSession">
          {{ t('common.retry') }}
        </UiButton>
      </template>
    </UiBanner>

    <UiBanner
      v-if="interruptedDecomposition && !aiWaiting"
      tone="warn"
      class="llm-banner"
      role="alert"
      :title="t('aiWait.interrupted.title')"
      data-testid="ai-interrupted"
    >
      <p>{{ t('aiWait.interrupted.body') }}</p>
      <template #actions>
        <UiButton size="sm" variant="primary" icon="sync" :disabled="!canMutate" @click="retryAi">
          {{ t('aiWait.interrupted.retry') }}
        </UiButton>
        <UiButton size="sm" :disabled="!canMutate" @click="enterManual">
          {{ t('aiWait.manual') }}
        </UiButton>
      </template>
    </UiBanner>

    <UiBanner v-else-if="interruptedFallback" tone="info" role="status">
      {{ t('aiWait.interrupted.detectionBody') }}
    </UiBanner>

    <UiBanner v-else-if="cancelledNotice" tone="info" role="status" data-testid="ai-cancelled">
      {{ t('aiWait.cancelledNotice') }}
    </UiBanner>

    <UiBanner v-if="!offline.mutationsEnabled" tone="offline" class="offline-note" role="status">
      {{ t('wizard.offline') }}
    </UiBanner>

    <UiBanner v-if="mutationError !== null" tone="error" role="alert">{{ mutationError }}</UiBanner>

    <UiCard v-if="terminal" class="wizard-card wizard-card--center" role="status">
      <h2>{{ t('wizard.endedTitle') }}</h2>
      <p class="muted">{{ t('wizard.endedBody') }}</p>
      <div class="card-actions">
        <RouterLink class="btn btn--primary" to="/plan/new">{{ t('wizard.startNew') }}</RouterLink>
      </div>
    </UiCard>

    <AiWaitPanel
      v-else-if="aiWait.revealed.value && aiWait.pending.value !== null"
      ref="aiPanel"
      :kind="aiWait.pending.value.kind"
      :elapsed-ms="aiWait.elapsedMs.value"
      :phase="aiWait.phase.value"
      :cancelling="aiWait.cancelling.value"
      :connection-lost="aiWait.connectionLost.value"
      :can-act="offline.mutationsEnabled"
      @cancel="stopAiWait"
      @manual="stopAiWait"
      @check-again="checkAiNow"
    />

    <UiCard v-else-if="!isNew && sessionQuery.isLoading.value" class="wizard-card">
      <p class="loading-row"><UiSpinner /> {{ t('wizard.loading') }}</p>
    </UiCard>

    <UiBanner v-else-if="!isNew && sessionQuery.isError.value" tone="error" class="wizard-card error-panel">
      <p class="error-text" role="alert">{{ t('wizard.loadError') }}</p>
      <template #actions>
        <UiButton size="sm" icon="sync" @click="retry">{{ t('common.retry') }}</UiButton>
      </template>
    </UiBanner>

    <UiCard
      v-else-if="currentStep === 1"
      as="form"
      class="wizard-card"
      aria-labelledby="step1-heading"
      @submit.prevent="createSession"
    >
      <header class="wizard-card-header">
        <h2 id="step1-heading">{{ t('wizard.step1') }}</h2>
        <p class="muted">{{ t('wizard.step1Lede') }}</p>
      </header>

      <UiField id="wizard-title" :label="t('wizard.titleLabel')">
        <input
          id="wizard-title"
          v-model="form.title"
          type="text"
          maxlength="200"
          required
          :placeholder="t('wizard.titlePlaceholder')"
          :disabled="creating || !offline.mutationsEnabled"
        />
      </UiField>

      <div class="field-grid">
        <UiField id="wizard-due" :label="t('wizard.due')">
          <input
            id="wizard-due"
            v-model="form.dueAt"
            type="datetime-local"
            :disabled="creating || !offline.mutationsEnabled"
          />
        </UiField>
        <UiField id="wizard-file" :label="t('wizard.file')">
          <input
            id="wizard-file"
            v-model="form.fileName"
            type="text"
            maxlength="200"
            :disabled="creating || !offline.mutationsEnabled"
          />
        </UiField>
      </div>

      <UiField id="wizard-description" :label="t('wizard.description')">
        <textarea
          id="wizard-description"
          v-model="form.description"
          rows="3"
          maxlength="4000"
          :disabled="creating || !offline.mutationsEnabled"
        ></textarea>
      </UiField>

      <div class="wizard-card-footer">
        <UiButton
          type="submit"
          variant="primary"
          :busy="creating"
          :disabled="creating || !offline.mutationsEnabled || form.title.trim().length === 0"
        >
          {{ creating ? t('wizard.creating') : t('wizard.next') }}
        </UiButton>
      </div>
    </UiCard>

    <UiCard
      v-else-if="currentStep === 2"
      class="wizard-card"
      aria-labelledby="step2-heading"
    >
      <header class="wizard-card-header">
        <h2 id="step2-heading">{{ t('wizard.step2') }}</h2>
      </header>
      <div class="similar-card" role="group" aria-labelledby="similar-heading">
        <div class="similar-card-head">
          <span class="dialog-icon"><UiIcon name="plan" :size="22" /></span>
          <div>
            <h3 id="similar-heading">{{ t('wizard.similarTitle') }}</h3>
            <p>
              <I18nT keypath="wizard.similarBody">
                <template #template><strong>{{ templateName }}</strong></template>
                <template #confidence><strong>{{ confidenceLabel }}</strong></template>
              </I18nT>
            </p>
          </div>
        </div>
        <div class="confidence-meter" aria-hidden="true">
          <span class="confidence-meter-fill" :style="{ width: `${confidencePercent}%` }"></span>
        </div>
        <ul class="reason-list" :aria-label="t('wizard.reasons')">
          <li
            v-for="reason in detectedReasons"
            :key="reason.key"
            class="chip badge--accent"
            :lang="reason.translated ? undefined : 'en'"
          >
            {{ reason.text }}
          </li>
        </ul>
        <p class="similar-question">{{ t('wizard.similarQuestion') }}</p>
        <div class="dialog-actions">
          <UiButton
            variant="primary"
            icon="check"
            :disabled="!canMutate || paused || templateId === undefined"
            @click="confirmType(true)"
          >
            {{ t('wizard.yes') }}
          </UiButton>
          <UiButton :disabled="!canMutate || paused" @click="confirmType(false)">{{ t('wizard.no') }}</UiButton>
        </div>
      </div>
    </UiCard>

    <UiCard
      v-else-if="currentStep === 3"
      class="wizard-card"
      aria-labelledby="step3-heading"
    >
      <header class="wizard-card-header">
        <h2 id="step3-heading">{{ t('wizard.step3') }}</h2>
        <p class="muted">{{ t('wizard.step3Lede') }}</p>
      </header>
      <UiBanner v-if="paused" tone="info" class="offline-note" role="status">
        {{ t('wizard.paused') }}
      </UiBanner>

      <ul v-if="questions.length > 0" class="question-list">
        <li v-for="question in questions" :key="question.field" class="question-card">
          <fieldset :disabled="questionsLocked">
            <legend>
              {{ questionPrompt(question) }}
              <UiBadge v-if="question.required" tone="warn">{{ t('wizard.required') }}</UiBadge>
            </legend>

            <div class="question-answer">
              <label :for="`answer-${question.field}`" class="field-label">{{ t('wizard.answerLabel') }}</label>
              <select
                v-if="isSelectField(question.field)"
                :id="`answer-${question.field}`"
                v-model="answerText[question.field]"
              >
                <option value="">{{ t('wizard.choose') }}</option>
                <option v-for="scope in SCOPE_OPTIONS" :key="scope" :value="scope">
                  {{ t(`wizard.scope.${scope}`) }}
                </option>
              </select>
              <input
                v-else-if="isBooleanField(question.field)"
                :id="`answer-${question.field}`"
                v-model="answerBoolean[question.field]"
                type="checkbox"
              />
              <input
                v-else-if="isNumberField(question.field)"
                :id="`answer-${question.field}`"
                v-model.number="answerNumber[question.field]"
                type="number"
              />
              <input
                v-else
                :id="`answer-${question.field}`"
                v-model="answerText[question.field]"
                type="text"
                maxlength="2000"
              />
            </div>

            <div class="question-actions">
              <UiButton
                variant="primary"
                size="sm"
                :disabled="questionsLocked"
                @click="answer(question, 'answer')"
              >
                {{ t('wizard.answer') }}
              </UiButton>
              <UiButton size="sm" :disabled="questionsLocked" @click="answer(question, 'idk')">
                {{ t('wizard.idk') }}
              </UiButton>
              <UiButton size="sm" variant="ghost" :disabled="questionsLocked" @click="answer(question, 'skip')">
                {{ t('wizard.skip') }}
              </UiButton>
            </div>
          </fieldset>
        </li>
      </ul>
      <p v-else class="muted">{{ t('wizard.noQuestions') }}</p>

      <section v-if="assumptions.length > 0" class="assumptions" aria-labelledby="assumptions-heading">
        <h3 id="assumptions-heading">{{ t('wizard.assumptions') }}</h3>
        <ul class="assumption-list">
          <li v-for="assumption in assumptions" :key="assumption.field" class="assumption-item">
            <span class="assumption-field">{{ fieldLabel(assumption.field) }}</span>
            <span class="chip">{{ reasonLabel(assumption.reason) }}</span>
            <span class="muted">{{ assumptionValue(assumption.field, assumption.value).text }}</span>
          </li>
        </ul>
      </section>
    </UiCard>

    <UiCard
      v-else-if="currentStep === 4"
      class="wizard-card"
      aria-labelledby="step4-heading"
    >
      <header class="wizard-card-header">
        <h2 id="step4-heading">{{ t('wizard.step4') }}</h2>
        <p class="muted">{{ t('wizard.step4Lede') }}</p>
      </header>

      <UiBanner v-if="draftConflict" tone="conflict" role="alert" class="draft-conflict">
        {{ t('wizard.draftConflict') }}
        <template #actions>
          <UiButton size="sm" icon="sync" @click="reloadDraft">{{ t('wizard.reloadDraft') }}</UiButton>
        </template>
      </UiBanner>

      <template v-if="draft !== null">
        <ol class="draft-step-list">
          <li v-for="(step, index) in draft.steps" :key="step.key" class="draft-step-card">
            <header class="draft-step-head">
              <h3><span class="draft-step-index" aria-hidden="true">{{ index + 1 }}</span>{{ step.key }}</h3>
              <UiBadge :tone="step.kind === 'review' || step.kind === 'buffer' ? 'info' : 'neutral'">
                {{ stepKindLabel(step.kind) }}
              </UiBadge>
            </header>

            <UiField :id="`step-title-${step.key}`" :label="t('wizard.stepTitle')">
              <input
                :id="`step-title-${step.key}`"
                v-model="step.title"
                type="text"
                maxlength="120"
                :disabled="!offline.mutationsEnabled || paused"
              />
            </UiField>

            <div class="field-grid">
              <UiField :id="`step-deliverable-${step.key}`" :label="t('wizard.deliverable')">
                <input
                  :id="`step-deliverable-${step.key}`"
                  v-model="step.deliverable"
                  type="text"
                  maxlength="300"
                  :disabled="!offline.mutationsEnabled || paused"
                />
              </UiField>
              <UiField :id="`step-done-${step.key}`" :label="t('wizard.doneCriteria')">
                <input
                  :id="`step-done-${step.key}`"
                  v-model="step.doneCriteria"
                  type="text"
                  maxlength="300"
                  :disabled="!offline.mutationsEnabled || paused"
                />
              </UiField>
            </div>

            <div class="field-grid field-grid--3">
              <UiField :id="`step-kind-${step.key}`" :label="t('wizard.kind')">
                <select
                  :id="`step-kind-${step.key}`"
                  v-model="step.kind"
                  :disabled="!offline.mutationsEnabled || paused"
                >
                  <option v-for="kind in STEP_KINDS" :key="kind" :value="kind">{{ stepKindLabel(kind) }}</option>
                </select>
              </UiField>
              <UiField :id="`step-p50-${step.key}`" :label="t('wizard.p50')">
                <input
                  :id="`step-p50-${step.key}`"
                  v-model.number="step.estimate.p50Minutes"
                  type="number"
                  min="5"
                  max="2400"
                  :disabled="!offline.mutationsEnabled || paused"
                />
              </UiField>
              <UiField :id="`step-p90-${step.key}`" :label="t('wizard.p90')">
                <input
                  :id="`step-p90-${step.key}`"
                  v-model.number="step.estimate.p90Minutes"
                  type="number"
                  min="5"
                  max="4800"
                  :disabled="!offline.mutationsEnabled || paused"
                />
              </UiField>
            </div>

            <fieldset class="dependency-fieldset choice-group">
              <legend>{{ t('wizard.dependencies') }}</legend>
              <label
                v-for="candidate in draft.steps.filter((item) => item.key !== step.key)"
                :key="candidate.key"
                class="chip checkbox-chip"
              >
                <input
                  type="checkbox"
                  :checked="step.dependsOn.includes(candidate.key)"
                  :disabled="!offline.mutationsEnabled || paused"
                  @change="toggleDependency(step, candidate.key)"
                />
                {{ candidate.key }} {{ candidate.title }}
              </label>
            </fieldset>

            <p v-for="issue in issuesFor(step)" :key="issue.code + issue.message" class="error-text field-error">
              <UiIcon name="error" :size="16" /><span>{{ issue.message }}</span>
            </p>

            <div class="draft-step-footer">
              <UiButton
                size="sm"
                variant="danger-ghost"
                icon="trash"
                class="danger"
                :disabled="draftLocked || draft.steps.length <= 3"
                @click="removeStep(index)"
              >
                {{ t('wizard.removeStep') }}
              </UiButton>
            </div>
          </li>
        </ol>

        <p v-for="issue in generalDraftIssues" :key="issue.code + issue.message" class="error-text field-error">
          <UiIcon name="error" :size="16" /><span>{{ issue.message }}</span>
        </p>

        <div class="wizard-card-footer wizard-card-footer--split">
          <UiButton
            icon="plus"
            variant="ghost"
            :disabled="draftLocked || draft.steps.length >= 12"
            @click="addStep"
          >
            {{ t('wizard.addStep') }}
          </UiButton>
          <div class="cluster">
            <UiButton :disabled="draftLocked" @click="saveDraft">{{ t('wizard.saveDraft') }}</UiButton>
            <UiButton
              variant="primary"
              icon="check"
              :disabled="draftLocked"
              @click="approve"
            >
              {{ t('wizard.approveDraft') }}
            </UiButton>
          </div>
        </div>
      </template>
      <p v-else class="loading-row"><UiSpinner /> {{ t('wizard.preparing') }}</p>

      <section v-if="assumptions.length > 0" class="assumptions" aria-labelledby="draft-assumptions-heading">
        <h3 id="draft-assumptions-heading">{{ t('wizard.assumptions') }}</h3>
        <ul class="assumption-list">
          <li v-for="assumption in assumptions" :key="assumption.field" class="assumption-item">
            <span class="assumption-field">{{ fieldLabel(assumption.field) }}</span>
            <span class="chip">{{ reasonLabel(assumption.reason) }}</span>
            <span class="muted">{{ assumptionValue(assumption.field, assumption.value).text }}</span>
          </li>
        </ul>
      </section>
    </UiCard>

    <UiCard
      v-else-if="currentStep === 5"
      class="wizard-card wizard-card--center"
      aria-labelledby="step5-heading"
    >
      <span class="success-mark" aria-hidden="true"><UiIcon name="check" :size="28" /></span>
      <h2 id="step5-heading">{{ t('wizard.step5') }}</h2>
      <p>{{ t('wizard.step5Body') }}</p>
      <p class="next-milestone">{{ t('wizard.nextMilestone') }}</p>
      <div class="card-actions">
        <RouterLink class="btn btn--primary" to="/inbox">{{ t('wizard.viewInbox') }}</RouterLink>
        <RouterLink class="btn btn--secondary" to="/projects">{{ t('wizard.viewProjects') }}</RouterLink>
      </div>
    </UiCard>

    <footer
      v-if="session !== null && !terminal && currentStep >= 2 && currentStep <= 4"
      class="wizard-footer"
    >
      <UiButton
        variant="ghost"
        size="sm"
        :disabled="!offline.mutationsEnabled || busy || paused || aiWait.cancelling.value"
        @click="continueManually"
      >
        {{ t('wizard.toManual') }}
      </UiButton>
    </footer>
  </section>
</template>
