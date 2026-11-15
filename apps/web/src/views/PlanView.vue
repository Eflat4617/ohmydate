<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useQuery, useQueryClient } from '@tanstack/vue-query';
import {
  AI_REQUEST_CLIENT_BOUND_MS,
  ActionStore,
  AiRequestTimeoutError,
  ApiError,
  plannerClient,
  type DecompositionDraft,
  type IntakeAnswerInput,
  type IntakeField,
  type IntakeInput,
  type IdempotentAction,
  type IntakeSession,
  type PlannedQuestion,
} from '../api';
import { validateDraft } from '../domain/draftValidation';
import { useOfflineStore } from '../stores/offline';
import { useAuthStore } from '../stores/auth';
import { useLlmConsentStore } from '../stores/llmConsent';
import { runOwnerBound, waitStep, type OwnerScope, type OwnerSteps } from '../session/ownerBound';
import {
  captureOwnerBinding,
  isOwnerBindingCurrent,
  isOwnerResetPending,
  onActiveOwnerChange,
  type OwnerBinding,
} from '../session/ownerEpoch';
import UiBadge from '../components/ui/UiBadge.vue';
import UiBanner from '../components/ui/UiBanner.vue';
import UiButton from '../components/ui/UiButton.vue';
import UiCard from '../components/ui/UiCard.vue';
import UiIcon from '../components/ui/UiIcon.vue';
import UiSpinner from '../components/ui/UiSpinner.vue';
import EvidenceList from '../components/notes/EvidenceList.vue';
import WizardNotesPanel from '../components/notes/WizardNotesPanel.vue';
import AiWaitPanel from '../components/AiWaitPanel.vue';
import PlanAssumptions from '../components/plan/PlanAssumptions.vue';
import PlanFlowHeader from '../components/plan/PlanFlowHeader.vue';
import PlanGoalForm, { type GoalAiState, type GoalForm } from '../components/plan/PlanGoalForm.vue';
import PlanQuestionForm from '../components/plan/PlanQuestionForm.vue';
import PlanResumeList from '../components/plan/PlanResumeList.vue';
import PlanStepsEditor from '../components/plan/PlanStepsEditor.vue';
import PlanTypeCheck from '../components/plan/PlanTypeCheck.vue';
import { forgetPlanFlow, rememberPlanFlow, usePlanFlows } from '../composables/planFlowMemory';
import { defaultPlanInput, usePlanCreate } from '../composables/usePlanCreate';
import { sessionStage, type PlanStage } from '../domain/planFlow';
import { localDateOf, todayInZone } from '../domain/time';
import { browserTimeZone, formatDateTime } from '../i18n/format';
import {
  AI_WAIT_POLL_MS,
  readStoredAiWait,
  sessionAwaitsAi,
  useAiWait,
  type AiWaitKind,
  type PendingAiWait,
} from '../composables/useAiWait';
import { t } from '../i18n';
import { formatPercent } from '../i18n/format';
import { apiErrorMessage, errorMessage, problemMessage } from '../i18n/problem';
import { detectionReasonLang, detectionReasonText } from '../i18n/server';
import { isProblemCode } from '../api/errors';

/**
 * 계획 세우기 · 목표 → 질문 → 단계 (HOLO-03A). One planning session, from the
 * sentence that says what has to be done to the steps it is split into; the
 * schedules and their confirmation are the same flow's next two stages
 * (PlanScopeView, PlanScheduleView).
 *
 *   목표   `/plan`: what, by when, a few more words. AI consent is asked here
 *          when it is missing — in the card, not in a settings screen.
 *   질문   `/plan/:sessionId`: the AI's check against earlier work, then its
 *          few questions, answered in one go (blank is skip, "모름" is an answer).
 *   단계   the draft, as rows: names and two times. Confirming it makes the
 *          tasks AND the three schedules, and opens them.
 *
 * Every stage is the server's own state, so a session opened again is where
 * it stopped. The AI can be left at any point ("AI 없이 직접 짜기"): what was
 * typed stays, and the steps are written by hand.
 *
 * Long AI calls (FU-76) keep their calm panel: time passed, a hint, 취소 and
 * 직접 작성으로 계속. A reload resumes the wait; it never sends twice.
 */
const props = defineProps<{ sessionId?: string }>();

const route = useRoute();
const router = useRouter();
const queryClient = useQueryClient();
const offline = useOfflineStore();
const auth = useAuthStore();
const llmConsent = useLlmConsentStore();
const actions = new ActionStore();

const flows = usePlanFlows();
const planCreate = usePlanCreate();

const heading = ref<InstanceType<typeof PlanFlowHeader> | null>(null);
const liveMessage = ref('');
const busyCount = ref(0);
const busy = computed(() => busyCount.value > 0);
const mutationError = ref<string | null>(null);
const draftConflict = ref(false);
const llmIssue = ref<string | null>(null);

const form = ref<GoalForm>({ title: '', dueAt: '', description: '' });
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
  // Never the template's id: a kind of work without a name is "이전 작업".
  () => templateQuery.data.value?.name ?? t('planAsk.type.templateFallback'),
);

/** Where the flow is: before a session `goal`, then what the session's own state says. */
const stage = computed<PlanStage | 'ended'>(() => (session.value === null ? 'goal' : sessionStage(session.value)));
/**
 * The AI found an earlier kind of work like this one and waits for "같은
 * 방식으로?" — the first thing asked in 질문.
 */
const typeCheck = computed(() => {
  const current = session.value;
  if (current === null || stage.value !== 'questions') return false;
  if (current.state === 'type_detection') return current.detectedType !== undefined;
  return current.detectedType?.classification === 'similar';
});

const terminal = computed(() => stage.value === 'ended');
const paused = computed(() => session.value?.state === 'needs_input');
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
/** Nothing of the session can be changed right now: offline, a request is out, the AI is working, or it is set aside. */
const locked = computed(() => !canMutate.value || paused.value);

const draft = ref<DecompositionDraft | null>(null);
let disposed = false;
onUnmounted(() => {
  disposed = true;
});

const draftValidation = computed(() =>
  draft.value === null ? { valid: true, issues: [] } : validateDraft(draft.value),
);

/** Only what the user edits; `evidence` is server-produced and never sent back. */
function editableDraft(value: DecompositionDraft | undefined): string {
  if (value === undefined) return '';
  return JSON.stringify({
    steps: value.steps,
    assumptions: value.assumptions,
    questionsRemaining: value.questionsRemaining,
  });
}

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

/** Why the AI could not be used, in words. The code itself is for logs: it is the banner's `data-code`. */
const llmIssueCode = ref<string | null>(null);

function llmIssueText(code: string): string {
  llmIssueCode.value = code;
  return isProblemCode(code) ? problemMessage(code) : t('aiWait.errors.unknown');
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

/** What the stage is called to someone who cannot see the rail: the type check is part of 질문. */
watch([stage, typeCheck], async ([next, check], [previous, previousCheck]) => {
  if (next === previous && check === previousCheck) return;
  if (next === 'ended') {
    liveMessage.value = t('planAsk.ended.live');
    return;
  }
  liveMessage.value = t('planFlow.stageLive', { label: t(`planFlow.stage.${next}`) });
  await nextTick();
  heading.value?.focus();
});

function applySession(updated: IntakeSession): void {
  queryClient.setQueryData(['intake', updated.id], updated);
  if (updated.draft !== undefined && draft.value === null) draft.value = cloneDraft(updated.draft);
  if (updated.manual && updated.error === undefined) llmIssue.value = null;
}

/** Re-read the session inside an owner-bound task (delegate with `yield*`). A failed read answers null. */
function* refreshSessionSteps(): OwnerSteps<IntakeSession | null> {
  if (sessionId.value.length === 0) return null;
  try {
    const fresh = yield* waitStep(plannerClient.getIntakeSession(sessionId.value, { fresh: true }));
    queryClient.setQueryData(['intake', fresh.id], fresh);
    return fresh;
  } catch {
    return null;
  }
}

/** Re-read the session for the current owner; a read that outlives the owner caches nothing. */
async function refreshSession(): Promise<IntakeSession | null> {
  const outcome = await runOwnerBound(refreshSessionSteps);
  return outcome.status === 'done' ? outcome.value : null;
}

// ---------------------------------------------------------------------------
// FU-76: waiting for long AI calls.
//
// Owner isolation (ADR-023, FU-76R-1 H2): every flow below captures the
// OwnerBinding before its first await and drops itself (no cache, storage,
// navigation or further request) once the binding is stale; an owner change
// stops polling/replay at once. Stopping on the client never cancels the
// server's AI call.
// ---------------------------------------------------------------------------

let aiController: AbortController | null = null;
let aiCancelRequested = false;
let pollToken = 0;

/** The verified owner (confirmed by /me) and its binding, or null before verification. */
function verifiedOwner(): { readonly binding: OwnerBinding; readonly ownerId: string } | null {
  const binding = captureOwnerBinding();
  const user = auth.user;
  if (!auth.confirmed || user === null || isOwnerResetPending()) return null;
  if (binding.ownerId !== user.id) return null;
  return { binding, ownerId: user.id };
}

/** The record names its owner only when verified; otherwise it is never persisted. */
function ownedRecord(record: Omit<PendingAiWait, 'ownerId'>): {
  readonly record: PendingAiWait;
  readonly binding: OwnerBinding;
} {
  const owner = verifiedOwner();
  return owner === null
    ? { record, binding: captureOwnerBinding() }
    : { record: { ...record, ownerId: owner.ownerId }, binding: owner.binding };
}

function stale(binding: OwnerBinding): boolean {
  return disposed || !isOwnerBindingCurrent(binding);
}

/** User cancel and owner invalidation both stop the request on the client only. */
function freshAiSignal(binding: OwnerBinding): AbortSignal {
  const controller = new AbortController();
  aiController = controller;
  aiCancelRequested = false;
  if (binding.signal.aborted) controller.abort();
  else binding.signal.addEventListener('abort', () => controller.abort(), { once: true });
  return controller.signal;
}

const offOwnerChange = onActiveOwnerChange(() => {
  // The store already dropped every stored record; drop the in-memory wait
  // and stop every loop. The previous owner's server call keeps running.
  pollToken += 1;
  aiController?.abort();
  aiController = null;
  aiWait.reset();
  creating.value = false;
  consentAsking.value = false;
});
onUnmounted(offOwnerChange);

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

function finishWithSession(binding: OwnerBinding, updated: IntakeSession, outcome: 'done' | 'cancelled'): void {
  if (stale(binding)) return;
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

/** Owner-bound pause between polls; false once the owner or the loop changed. */
async function pause(binding: OwnerBinding, token: number, ms: number): Promise<boolean> {
  await delay(ms);
  return !stale(binding) && token === pollToken;
}

/** Reloaded or reconnected: follow the session state, never re-submit. */
async function pollSession(binding: OwnerBinding, id: string): Promise<void> {
  const token = ++pollToken;
  for (;;) {
    if (stale(binding) || token !== pollToken || aiWait.pending.value === null) return;
    if (!offline.online) {
      aiWait.connectionLost.value = true;
    } else {
      try {
        const fresh = await plannerClient.getIntakeSession(id, { fresh: true });
        if (stale(binding) || token !== pollToken) return;
        aiWait.connectionLost.value = false;
        if (sessionAwaitsAi(fresh) === null) {
          finishWithSession(binding, fresh, 'done');
          return;
        }
        queryClient.setQueryData(['intake', fresh.id], fresh);
      } catch (cause) {
        if (stale(binding) || token !== pollToken) return;
        if (isConnectionLoss(cause)) {
          aiWait.connectionLost.value = true;
        } else {
          aiWait.finish('silent');
          handleError(cause);
          return;
        }
      }
    }
    if (!(await pause(binding, token, AI_WAIT_POLL_MS))) return;
  }
}

/** A create replay (same Idempotency-Key) until the stored outcome exists. */
async function replayCreate(
  binding: OwnerBinding,
  input: IntakeInput,
  key: string,
): Promise<IntakeSession | null> {
  const token = ++pollToken;
  for (;;) {
    if (stale(binding) || token !== pollToken) return null;
    const started = aiWait.pending.value?.startedAt ?? Date.now();
    if (aiWait.cancelling.value && Date.now() - started > AI_REQUEST_CLIENT_BOUND_MS) return null;
    if (!offline.online) {
      aiWait.connectionLost.value = true;
      if (!(await pause(binding, token, AI_WAIT_POLL_MS))) return null;
      continue;
    }
    try {
      const created = await plannerClient.createIntakeSession(input, key, { signal: binding.signal });
      if (stale(binding) || token !== pollToken) return null;
      aiWait.connectionLost.value = false;
      return created;
    } catch (cause) {
      if (stale(binding) || token !== pollToken) return null;
      if (isInProgress(cause)) {
        if (!(await pause(binding, token, Math.max(1, cause.retryAfterSeconds ?? 1) * 1_000))) return null;
        continue;
      }
      if (isConnectionLoss(cause)) {
        aiWait.connectionLost.value = true;
        if (!(await pause(binding, token, AI_WAIT_POLL_MS))) return null;
        continue;
      }
      throw cause;
    }
  }
}

function finishCreateWithError(binding: OwnerBinding, cause: unknown): void {
  if (stale(binding)) return;
  aiController = null;
  aiWait.finish('silent');
  creating.value = false;
  handleError(cause);
}

async function onCreated(
  binding: OwnerBinding,
  created: IntakeSession,
  outcome: 'done' | 'cancelled' = 'done',
): Promise<void> {
  if (stale(binding)) return;
  const action = actions.peek<IntakeInput>('intake:create');
  if (action !== undefined) actions.settle('intake:create', action);
  queryClient.setQueryData(['intake', created.id], created);
  aiController = null;
  aiWait.finish(outcome);
  creating.value = false;
  // Unfinished business from here on (개요 and 계획 세우기 offer to go on).
  rememberPlanFlow(binding, { kind: 'session', id: created.id });
  await router.push({ name: 'plan-session', params: { sessionId: created.id } });
}

async function sendCreate(binding: OwnerBinding, input: IntakeInput, key: string): Promise<void> {
  const signal = freshAiSignal(binding);
  try {
    const created = await plannerClient.createIntakeSession(input, key, { signal });
    await onCreated(binding, created);
  } catch (cause) {
    if (aiCancelRequested || stale(binding)) return;
    if (!isConnectionLoss(cause) && !isInProgress(cause)) {
      finishCreateWithError(binding, cause);
      return;
    }
    try {
      const created = await replayCreate(binding, input, key);
      if (created !== null) await onCreated(binding, created);
    } catch (replayCause) {
      finishCreateWithError(binding, replayCause);
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
    mutationError.value = t('planAsk.offlineMutation');
    return undefined;
  }
  mutationError.value = null;
  const owned = ownedRecord({ kind, startedAt: Date.now(), sessionId: current.id });
  const binding = owned.binding;
  aiWait.start(owned.record, { reveal, binding });
  const signal = freshAiSignal(binding);
  try {
    const updated = await send(signal);
    if (stale(binding)) return undefined;
    actions.settle(scope, token);
    finishWithSession(binding, updated, 'done');
    return updated;
  } catch (cause) {
    if (aiCancelRequested || stale(binding)) return undefined;
    if (isConnectionLoss(cause)) {
      aiWait.connectionLost.value = !offline.online;
      void pollSession(binding, current.id);
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
  const binding = captureOwnerBinding();
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
      created = await replayCreate(binding, pending.create.input, pending.create.key);
    } catch {
      created = null;
    }
    if (stale(binding)) return;
    if (created === null) {
      // Could not reach it within the bound: keep what was typed on the first stage.
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
    if (stale(binding)) return;
    const scope = `intake:${id}:manual`;
    const token = actions.begin(scope, { manual: true }, samePayload, fresh.version);
    const manual = await plannerClient.enterManualIntakeMode(id, token.key, fresh.version);
    if (stale(binding)) return;
    actions.settle(scope, token);
    if (pending.create !== undefined) await onCreated(binding, manual, 'cancelled');
    else finishWithSession(binding, manual, 'cancelled');
  } catch (cause) {
    if (stale(binding)) return;
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
  const binding = captureOwnerBinding();
  if (pending.sessionId !== undefined) {
    void pollSession(binding, pending.sessionId);
    return;
  }
  if (pending.create !== undefined) {
    try {
      const created = await replayCreate(binding, pending.create.input, pending.create.key);
      if (created !== null) await onCreated(binding, created);
    } catch (cause) {
      finishCreateWithError(binding, cause);
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
// The stored start time is used only for the same verified owner.
watch(
  session,
  (value) => {
    if (value === null || aiWait.pending.value !== null) return;
    const kind = sessionAwaitsAi(value);
    if (kind === null) return;
    const owner = verifiedOwner();
    const stored = owner === null ? null : readStoredAiWait(owner.ownerId);
    const updatedAt = Date.parse(value.updatedAt);
    const startedAt =
      stored?.sessionId === value.id
        ? stored.startedAt
        : Number.isFinite(updatedAt)
          ? Math.min(Date.now(), updatedAt)
          : Date.now();
    const owned = ownedRecord({ kind, startedAt, sessionId: value.id });
    aiWait.start(owned.record, { reveal: 'now', binding: owned.binding });
    void pollSession(owned.binding, value.id);
  },
  { immediate: true },
);

// A reload during the create (type detection) replays the same request key,
// but only for the same verified owner that stored it.
onMounted(async () => {
  if (!isNew.value) {
    void auth.ensureOwnerConfirmed();
    return;
  }
  const bootstrap = captureOwnerBinding();
  await auth.ensureOwnerConfirmed();
  if (stale(bootstrap) || !isNew.value || aiWait.pending.value !== null) return;
  const owner = verifiedOwner();
  if (owner === null) return;
  const stored: PendingAiWait | null = readStoredAiWait(owner.ownerId);
  if (stored?.create === undefined || stored.sessionId !== undefined) return;
  const binding = owner.binding;
  form.value = {
    title: stored.create.form.title,
    dueAt: stored.create.form.dueAt,
    description: stored.create.form.description,
  };
  creating.value = true;
  aiWait.start(stored, { reveal: 'now', binding });
  const { input, key } = stored.create;
  try {
    const created = await replayCreate(binding, input, key);
    if (created !== null) await onCreated(binding, created);
  } catch (cause) {
    finishCreateWithError(binding, cause);
  }
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
      mutationError.value = t('planAsk.refreshedAfterConflict', { message: apiErrorMessage(cause) });
      void refreshSession();
      return;
    }
    mutationError.value = apiErrorMessage(cause);
    return;
  }
  mutationError.value = errorMessage(cause, t('planAsk.requestFailed'));
}

/**
 * Every mutation that does not wait for the AI goes through here, as steps of an owner-bound
 * task (ADR-023): the handler runs `runOwnerBound(function* () { … yield*
 * run(…) … })`, so the request and everything the handler does with its
 * answer continue only for the owner who started it. A failure is shown and
 * answers `undefined`.
 */
function* run<T>(steps: () => OwnerSteps<T>): OwnerSteps<T | undefined> {
  if (!offline.mutationsEnabled) {
    mutationError.value = t('planAsk.offlineMutation');
    return undefined;
  }
  busyCount.value += 1;
  mutationError.value = null;
  try {
    return yield* steps();
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
  const input: IntakeInput = { title: form.value.title.trim() };
  const dueAt = toInstant(form.value.dueAt);
  if (dueAt !== undefined) input.dueAt = dueAt;
  const description = form.value.description.trim();
  if (description.length > 0) input.description = description.slice(0, 4_000);
  return input;
}

const samePayload = (left: unknown, right: unknown): boolean =>
  JSON.stringify(left) === JSON.stringify(right);

// ── AI consent, asked right here (FLOW §2) ─────────────────────────────
/** The consent question is open in the goal card. */
const consentAsking = ref(false);
const consentSaving = ref(false);
const consentError = ref<string | null>(null);

const aiState = computed<GoalAiState>(() => {
  if (!llmConsent.needed) return auth.user?.llmProvider === 'deepseek' ? 'on' : 'none';
  return llmConsent.undecided ? 'ask' : 'off';
});

/**
 * The answer to "AI가 도와줄까요?". It is saved like the consent dialog saves
 * it; then, when a goal is already typed, the plan starts with that answer.
 * A "no" that could not be saved still starts without the AI: the server
 * never calls it without a recorded yes.
 */
async function answerConsent(granted: boolean): Promise<void> {
  if (consentSaving.value) return;
  consentSaving.value = true;
  consentError.value = null;
  await runOwnerBound(
    function* (owner) {
      try {
        yield* owner.wait(auth.setLlmConsent(granted));
      } catch {
        if (granted) {
          consentError.value = t('planStart.consent.error');
          return;
        }
      }
      consentAsking.value = false;
      if (form.value.title.trim().length > 0) startCreate();
    },
    {
      onSettled: () => {
        consentSaving.value = false;
      },
    },
  );
}

function createSession(): void {
  if (form.value.title.trim().length === 0) {
    mutationError.value = t('planStart.titleRequired');
    return;
  }
  if (!offline.mutationsEnabled) {
    mutationError.value = t('planAsk.offlineMutation');
    return;
  }
  if (creating.value) return;
  mutationError.value = null;
  // FU-91: starting a plan is an AI action. While consent was never answered
  // the question opens in the card and the request waits for the answer, so
  // it goes out with the AI or without it accordingly.
  if (llmConsent.undecided) {
    consentAsking.value = true;
    return;
  }
  startCreate();
}

function startCreate(): void {
  if (creating.value) return;
  creating.value = true;
  const input = buildInput();
  const action = actions.begin('intake:create', input, samePayload);
  // FU-76: type detection waits for the AI; the record lets a reload replay
  // the same key (and restore these inputs) instead of creating twice. It is
  // persisted only for the verified owner (FU-76R-1 H2).
  const owned = ownedRecord({
    kind: 'type_detection',
    startedAt: Date.now(),
    create: { key: action.key, input, form: { ...form.value } },
  });
  aiWait.start(owned.record, { reveal: 'delayed', binding: owned.binding });
  void sendCreate(owned.binding, input, action.key);
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

/**
 * The answers of 질문, all in one request. It may start the decomposition,
 * so it waits like every AI step does.
 */
async function submitAnswers(answers: IntakeAnswerInput[]): Promise<void> {
  const current = session.value;
  if (current === null || answers.length === 0) return;
  const scope = `intake:${current.id}:answers`;
  const actionToken = actions.begin(scope, answers, samePayload, current.version);
  await sendAiMutation(current, scope, actionToken, (signal) =>
    plannerClient.answerIntakeQuestions(current.id, answers, actionToken.key, current.version, { signal }),
  );
}

async function enterManual(): Promise<void> {
  const current = session.value;
  if (current === null) return;
  const scope = `intake:${current.id}:manual`;
  const action = actions.begin(scope, { manual: true }, samePayload, current.version);
  await runOwnerBound(function* () {
    const updated = yield* run(() =>
      waitStep(plannerClient.enterManualIntakeMode(current.id, action.key, current.version)),
    );
    if (updated === undefined) return;
    actions.settle(scope, action);
    applySession(updated);
  });
}

/** `resume`: go on with a session that was set aside. `cancel`: give the plan up (it cannot be reopened). */
async function sessionAction(action: 'resume' | 'cancel'): Promise<void> {
  const current = session.value;
  if (current === null) return;
  const scope = `intake:${current.id}:${action}`;
  const token = actions.begin(scope, { action }, samePayload, current.version);
  await runOwnerBound(function* (owner) {
    const updated = yield* run(() =>
      action === 'resume'
        ? waitStep(plannerClient.resumeIntakeSession(current.id, token.key, current.version))
        : waitStep(plannerClient.cancelIntakeSession(current.id, token.key, current.version)),
    );
    if (updated === undefined) return;
    actions.settle(scope, token);
    applySession(updated);
    if (action === 'cancel') forgetPlanFlow(owner.binding, 'session', current.id);
  });
}

/** Save the edited draft, as steps of an owner-bound task. True when the server has it. */
function* persistDraftSteps(): OwnerSteps<boolean> {
  const current = session.value;
  if (current === null || draft.value === null) return false;
  if (!draftValidation.value.valid) {
    mutationError.value = t('planSteps.invalid');
    return false;
  }
  if (editableDraft(draft.value) === editableDraft(current.draft)) return true;
  const patch = {
    steps: draft.value.steps,
    assumptions: draft.value.assumptions,
    questionsRemaining: draft.value.questionsRemaining,
  };
  const scope = `intake:${current.id}:draft`;
  const action = actions.begin(scope, patch, samePayload, current.version);
  const updated = yield* run(() =>
    waitStep(plannerClient.updateIntakeDraft(current.id, patch, action.key, current.version)),
  );
  if (updated === undefined) return false;
  actions.settle(scope, action);
  draft.value = cloneDraft(updated);
  draftConflict.value = false;
  yield* refreshSessionSteps();
  return true;
}

async function saveDraft(): Promise<void> {
  await runOwnerBound(function* () {
    const saved = yield* persistDraftSteps();
    if (saved) {
      mutationError.value = null;
      liveMessage.value = t('planSteps.saved');
    }
  });
}

/** The session's goal: the plan is made of its tasks, and the notes it grounds on are linked to it. */
const goalId = computed(() => session.value?.goalId ?? null);

const availabilityQuery = useQuery({
  queryKey: ['availability'],
  queryFn: () => plannerClient.getAvailability(),
});

/** Where the schedules of this session's steps are made (what to place and the session travel with it). */
function scopeLocation(): { name: string; query: Record<string, string> } {
  const query: Record<string, string> = { session: sessionId.value };
  if (goalId.value !== null) query['goalId'] = goalId.value;
  return { name: 'plan-scope', query };
}

/**
 * 단계 → 일정안, as steps of the task that confirmed the steps: the three
 * schedules are made for the goal's tasks with nothing more asked (a
 * fortnight, or up to the due day; all three ways) and opened. When there is
 * something to ask first — no hours to plan within yet — or the plan could
 * not be made, 일정안 만들기 opens instead, with the goal already picked.
 */
function* openSchedules(owner: OwnerScope): OwnerSteps<void> {
  const current = session.value;
  const goal = goalId.value;
  const availability = availabilityQuery.data.value;
  if (current === null || goal === null || availability === undefined || availability.rules.length === 0) {
    yield* owner.wait(router.push(scopeLocation()));
    return;
  }
  const zone = availability.timeZone;
  const dueAt = current.input.dueAt;
  const plan = yield* planCreate.createSteps(
    defaultPlanInput(
      { goalId: goal },
      {
        today: todayInZone(zone),
        dueDate: dueAt !== undefined && Number.isFinite(Date.parse(dueAt)) ? localDateOf(dueAt, zone) : null,
        timeZone: zone,
      },
    ),
  );
  if (plan === null) {
    yield* owner.wait(router.push(scopeLocation()));
    return;
  }
  rememberPlanFlow(owner.binding, { kind: 'plan', id: plan.id, sessionId: current.id });
  yield* owner.wait(router.push({ name: 'plan-schedule', params: { id: plan.id }, query: { session: current.id } }));
}

const approving = ref(false);

async function approve(): Promise<void> {
  if (busy.value || approving.value) return;
  approving.value = true;
  // One owner for the whole chain (save the draft, confirm it, make the
  // schedules): a user switch in between must not send the next request with
  // the next user's session.
  await runOwnerBound(
    function* (owner) {
      const saved = yield* persistDraftSteps();
      if (!saved) return;
      const current = session.value;
      if (current === null || current.state !== 'decomposition') {
        yield* refreshSessionSteps();
        return;
      }
      const scope = `intake:${current.id}:approve`;
      const action = actions.begin(scope, { id: current.id }, samePayload, current.version);
      const updated = yield* run(function* () {
        for (let attempt = 0; ; attempt += 1) {
          // The view may have been disposed, or the connection may have dropped
          // during Retry-After. Never send the delayed request offline; leaving the
          // action unsettled preserves the same idempotency key for the next retry.
          if (disposed) return undefined;
          if (!offline.mutationsEnabled) {
            mutationError.value = t('planSteps.approveOffline');
            return undefined;
          }
          try {
            return yield* waitStep(plannerClient.approveIntakeDraft(current.id, action.key, current.version));
          } catch (cause) {
            if (
              cause instanceof ApiError &&
              cause.status === 409 &&
              cause.code === 'approval_in_progress' &&
              attempt < 5
            ) {
              const seconds = Math.max(cause.retryAfterSeconds ?? 1, 0);
              liveMessage.value = t('planSteps.approveRetrying', { seconds });
              yield delay(seconds * 1_000);
              continue;
            }
            throw cause;
          }
        }
      });
      if (updated === undefined) return;
      actions.settle(scope, action);
      applySession(updated);
      // The steps are tasks now: on to the schedules.
      void queryClient.invalidateQueries({ queryKey: ['tasks'] });
      void queryClient.invalidateQueries({ queryKey: ['goals'] });
      yield* openSchedules(owner);
    },
    {
      onSettled: () => {
        approving.value = false;
      },
    },
  );
}

async function reloadDraft(): Promise<void> {
  await runOwnerBound(function* () {
    const fresh = yield* refreshSessionSteps();
    if (fresh?.draft !== undefined) draft.value = cloneDraft(fresh.draft);
    draftConflict.value = false;
    mutationError.value = null;
  });
}

function retry(): void {
  void sessionQuery.refetch();
}

const confidence = computed(() => Math.max(0, Math.min(1, session.value?.detectedType?.confidence ?? 0)));
const confidenceLabel = computed(() => formatPercent(Math.round(confidence.value * 100) / 100, 0));
const detectedReasons = computed(() =>
  (session.value?.detectedType?.reasons ?? []).flatMap((reason) => {
    const text = detectionReasonText(reason);
    return text === null
      ? []
      : [{ key: reason, text: text.text, lang: detectionReasonLang(reason, text, auth.user?.locale) }];
  }),
);

/** M6-03: reference notes are linked to the plan's goal (grounding, 08 §2.7) while it is being shaped. */
const showNotesPanel = computed(() => goalId.value !== null && (stage.value === 'questions' || stage.value === 'steps'));
const evidence = computed(() => session.value?.draft?.evidence);

// ── Head ───────────────────────────────────────────────────────────────
const title = computed(() => session.value?.input.title ?? t('planFlow.title'));
const lede = computed(() => {
  const current = session.value;
  if (current === null) return isNew.value ? t('planStart.lede') : null;
  const dueAt = current.input.dueAt;
  if (dueAt === undefined || !Number.isFinite(Date.parse(dueAt))) return null;
  return t('planFlow.due', { when: formatDateTime(dueAt, auth.user?.timeZone ?? browserTimeZone()) });
});
/** The rail's stage; a session that ended keeps the place it stopped at. */
const railStage = computed<PlanStage>(() => (stage.value === 'ended' ? 'questions' : stage.value));

/** The schedules being compared for this session's steps, when this device made them. */
const openPlan = computed(() => flows.entries.value.find((entry) => entry.kind === 'plan' && entry.sessionId === sessionId.value) ?? null);
const scheduleTo = computed(() =>
  openPlan.value === null
    ? scopeLocation()
    : { name: 'plan-schedule', params: { id: openPlan.value.id }, query: { session: sessionId.value } },
);
</script>

<template>
  <section class="page page--wide plan-page plan-session" aria-labelledby="plan-heading" :data-plan-stage="stage">
    <PlanFlowHeader ref="heading" :title="title" :lede="lede" :stage="railStage">
      <template #actions>
        <UiBadge v-if="!offline.mutationsEnabled" tone="offline" dot class="chip--offline" role="status">
          {{ t('common.readOnlyOffline') }}
        </UiBadge>
        <template v-if="session !== null && (stage === 'questions' || stage === 'steps')">
          <UiButton v-if="paused" size="sm" icon="play" :disabled="!canMutate" data-plan-continue @click="sessionAction('resume')">
            {{ t('planAsk.resume') }}
          </UiButton>
          <UiButton size="sm" variant="danger-ghost" :disabled="!canMutate" data-plan-stop @click="sessionAction('cancel')">
            {{ t('planAsk.stop') }}
          </UiButton>
        </template>
      </template>
    </PlanFlowHeader>

    <p class="visually-hidden" aria-live="polite" data-plan-live>{{ liveMessage }}</p>
    <p class="visually-hidden" aria-live="polite" data-testid="ai-wait-live">{{ aiWait.announcement.value }}</p>

    <UiBanner
      v-if="llmIssue !== null"
      tone="error"
      class="llm-banner"
      role="alert"
      :title="t('planAsk.llm.title')"
      :data-code="llmIssueCode ?? undefined"
      data-plan-llm-issue
    >
      <p>{{ t('planAsk.llm.body', { reason: llmIssue }) }}</p>
      <p>{{ t('planAsk.llm.continue') }}</p>
      <template #actions>
        <UiButton v-if="session !== null && !terminal" size="sm" :disabled="!canMutate" @click="enterManual">
          {{ t('planAsk.llm.toManual') }}
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
      {{ isNew ? t('planStart.offline') : t('planAsk.offline') }}
    </UiBanner>
    <UiBanner v-if="mutationError !== null" tone="error" role="alert" data-plan-error>{{ mutationError }}</UiBanner>

    <div class="plan-flow-grid">
      <div class="plan-flow-main">
        <UiCard v-if="terminal" class="plan-ended" role="status" data-plan-ended>
          <h2 class="card-title">{{ t('planAsk.ended.title') }}</h2>
          <p>{{ t('planAsk.ended.body') }}</p>
          <div class="plan-stage-actions">
            <RouterLink class="btn btn--primary" to="/plan">{{ t('planAsk.ended.startNew') }}</RouterLink>
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

        <UiCard v-else-if="!isNew && sessionQuery.isLoading.value" class="plan-loading">
          <p class="loading-row"><UiSpinner /> {{ t('planAsk.loading') }}</p>
        </UiCard>

        <UiBanner v-else-if="!isNew && sessionQuery.isError.value" tone="error" class="error-panel">
          <p class="error-text" role="alert">{{ t('planAsk.loadError') }}</p>
          <template #actions>
            <UiButton size="sm" icon="sync" @click="retry">{{ t('common.retry') }}</UiButton>
            <RouterLink class="btn btn--ghost btn--sm" to="/plan">{{ t('planAsk.ended.startNew') }}</RouterLink>
          </template>
        </UiBanner>

        <!-- 목표 -->
        <PlanGoalForm
          v-else-if="stage === 'goal'"
          v-model:form="form"
          :ai="aiState"
          :asking="consentAsking"
          :answering="consentSaving"
          :consent-error="consentError"
          :busy="creating"
          :disabled="!offline.mutationsEnabled"
          @submit="createSession"
          @answer="answerConsent"
          @ask="consentAsking = true"
        />

        <!-- 질문 -->
        <template v-else-if="stage === 'questions'">
          <UiBanner v-if="paused" tone="info" role="status" data-plan-paused>{{ t('planAsk.paused') }}</UiBanner>
          <PlanTypeCheck
            v-if="typeCheck"
            :template-name="templateName"
            :confidence-text="confidenceLabel"
            :confidence="confidence"
            :reasons="detectedReasons"
            :can-accept="templateId !== undefined"
            :disabled="locked"
            @confirm="confirmType"
          />
          <PlanQuestionForm v-else-if="questions.length > 0" :questions="questions" :disabled="locked" @submit="submitAnswers">
            <template #secondary>
              <UiButton
                v-if="session !== null && !session.manual"
                variant="ghost"
                :disabled="!offline.mutationsEnabled || busy || paused || aiWait.cancelling.value"
                data-plan-manual
                @click="continueManually"
              >
                {{ t('planAsk.manual') }}
              </UiButton>
            </template>
          </PlanQuestionForm>
          <UiCard v-else class="plan-questions plan-questions--none" data-plan-questions-none>
            <p>{{ t('planAsk.noQuestions') }}</p>
            <div v-if="session !== null && !session.manual" class="plan-stage-actions">
              <UiButton
                variant="ghost"
                :disabled="!offline.mutationsEnabled || busy || paused || aiWait.cancelling.value"
                data-plan-manual
                @click="continueManually"
              >
                {{ t('planAsk.manual') }}
              </UiButton>
            </div>
          </UiCard>
        </template>

        <!-- 단계 -->
        <template v-else-if="stage === 'steps'">
          <UiBanner v-if="paused" tone="info" role="status" data-plan-paused>{{ t('planAsk.paused') }}</UiBanner>
          <UiCard class="plan-steps-card" aria-labelledby="plan-steps-title" data-plan-steps-card>
            <header class="plan-stage-head">
              <h2 id="plan-steps-title" class="card-title"><UiIcon name="list" :size="18" />{{ t('planSteps.title') }}</h2>
              <p class="plan-stage-lede">{{ t('planSteps.lede') }}</p>
            </header>

            <UiBanner v-if="draftConflict" tone="conflict" role="alert" class="draft-conflict" data-plan-draft-conflict>
              {{ t('planSteps.conflict') }}
              <template #actions>
                <UiButton size="sm" icon="sync" @click="reloadDraft">{{ t('planSteps.reload') }}</UiButton>
              </template>
            </UiBanner>

            <template v-if="draft !== null">
              <PlanStepsEditor v-model:draft="draft" :disabled="!offline.mutationsEnabled || paused" />
              <footer class="plan-steps-confirm">
                <p class="plan-steps-confirm-lede">{{ t('planSteps.approveLede') }}</p>
                <div class="plan-stage-actions">
                  <UiButton :disabled="locked || approving" data-plan-save @click="saveDraft">{{ t('planSteps.save') }}</UiButton>
                  <UiButton
                    variant="primary"
                    size="lg"
                    icon="compare"
                    :busy="approving"
                    :disabled="locked || approving"
                    data-plan-approve-steps
                    @click="approve"
                  >
                    {{ approving ? t('planSteps.approving') : t('planSteps.approve') }}
                  </UiButton>
                </div>
              </footer>
            </template>
            <p v-else class="loading-row" data-plan-preparing><UiSpinner /> {{ t('planSteps.preparing') }}</p>
          </UiCard>
          <EvidenceList v-if="evidence !== undefined && draft !== null" :evidence="evidence" :steps="draft.steps" />
        </template>

        <!-- The steps are tasks now: on to the schedules. -->
        <UiCard v-else class="plan-next plan-done" aria-labelledby="plan-done-title" data-plan-done>
          <div class="plan-next-text">
            <h2 id="plan-done-title" class="plan-next-title">
              <span class="success-mark" aria-hidden="true"><UiIcon name="check" :size="18" /></span>{{ t('planSteps.done.title') }}
            </h2>
            <p class="plan-next-first">{{ t('planSteps.done.body') }}</p>
          </div>
          <div class="plan-next-actions">
            <RouterLink class="btn btn--primary" :to="scheduleTo" data-plan-to-schedule>
              <UiIcon name="compare" :size="18" class="btn-icon" />
              {{ openPlan === null ? t('planSteps.done.open') : t('planSteps.done.resume') }}
            </RouterLink>
            <RouterLink class="plan-next-link" to="/inbox">{{ t('planSteps.done.inbox') }}</RouterLink>
          </div>
        </UiCard>
      </div>

      <aside v-if="stage === 'goal' && isNew" class="plan-flow-side">
        <PlanResumeList />
        <UiCard compact class="plan-existing" aria-labelledby="plan-existing-title" data-plan-existing>
          <h2 id="plan-existing-title" class="card-title"><UiIcon name="inbox" :size="18" />{{ t('planStart.existing.title') }}</h2>
          <p class="plan-prep-lede">{{ t('planStart.existing.body') }}</p>
          <div class="plan-prep-actions">
            <RouterLink class="btn btn--secondary" to="/plan/schedule">{{ t('planStart.existing.open') }}</RouterLink>
          </div>
        </UiCard>
      </aside>
      <aside v-else-if="session !== null && (stage === 'questions' || stage === 'steps')" class="plan-flow-side">
        <WizardNotesPanel
          v-if="showNotesPanel && goalId"
          :goal-id="goalId"
          :after-draft="stage === 'steps'"
          :disabled="locked"
        />
        <PlanAssumptions :assumptions="assumptions" />
      </aside>
    </div>
  </section>
</template>
