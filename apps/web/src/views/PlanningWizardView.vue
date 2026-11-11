<script setup lang="ts">
import { computed, nextTick, reactive, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useQuery, useQueryClient } from '@tanstack/vue-query';
import {
  ActionStore,
  ApiError,
  plannerClient,
  type DecompositionDraft,
  type DecompositionStep,
  type IntakeAnswerInput,
  type IntakeField,
  type IntakeInput,
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

const props = defineProps<{ sessionId?: string }>();

const route = useRoute();
const router = useRouter();
const queryClient = useQueryClient();
const offline = useOfflineStore();
const actions = new ActionStore();

const STEP_LABELS = ['기본정보', '유형 확인', '질문', '단계 초안', '일정안'] as const;
const FIELD_LABELS: Record<IntakeField, string> = {
  deliverable: '산출물',
  dueAt: '마감',
  estimatedScope: '규모',
  currentProgress: '진행률',
  availabilityConfirmed: '가용 시간 확인',
  prerequisites: '사전 준비',
  priority: '우선순위',
  maxFocusMinutes: '집중 한도',
  reviewNeeded: '검토 필요',
};
const REASON_LABELS: Record<string, string> = {
  skip: '건너뛰기',
  idk: '모름',
  unanswered: '미응답',
};

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
  () => templateQuery.data.value?.name ?? session.value?.detectedType?.templateId ?? '이전 작업',
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
const canMutate = computed(() => offline.mutationsEnabled && !busy.value);
const questionsLocked = computed(() => !canMutate.value || paused.value);
const draftLocked = computed(() => !canMutate.value || paused.value);

const answerText = reactive<Record<string, string>>({});
const answerNumber = reactive<Record<string, number>>({});
const answerBoolean = reactive<Record<string, boolean>>({});

const draft = ref<DecompositionDraft | null>(null);

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

watch(
  () => session.value?.error,
  (error) => {
    if (error !== undefined) llmIssue.value = `${error.message} (${error.code})`;
  },
  { immediate: true },
);

watch(currentStep, async (next, previous) => {
  if (next === previous) return;
  if (next === 0) {
    liveMessage.value = '계획 세션이 종료되었습니다.';
    return;
  }
  liveMessage.value = `${next}단계: ${STEP_LABELS[next - 1] ?? ''}`;
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

function handleError(cause: unknown): void {
  if (cause instanceof ApiError) {
    if (cause.code === 'llm_unavailable' || cause.code === 'budget_exceeded') {
      llmIssue.value = `${cause.detail} (${cause.code})`;
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
      mutationError.value = `${cause.detail} 화면을 새로 고쳤습니다.`;
      void refreshSession();
      return;
    }
    mutationError.value = cause.detail;
    return;
  }
  mutationError.value = cause instanceof Error ? cause.message : '요청을 처리하지 못했습니다.';
}

async function run<T>(operation: () => Promise<T>): Promise<T | undefined> {
  if (!offline.mutationsEnabled) {
    mutationError.value = '오프라인에서는 변경할 수 없습니다. 연결이 돌아오면 다시 시도하세요.';
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
    mutationError.value = '제목을 입력하세요.';
    return;
  }
  creating.value = true;
  try {
    const input = buildInput();
    const scope = 'intake:create';
    const action = actions.begin(scope, input, samePayload);
    const created = await run(() => plannerClient.createIntakeSession(input, action.key));
    if (created === undefined) return;
    actions.settle(scope, action);
    queryClient.setQueryData(['intake', created.id], created);
    await router.push({ name: 'plan-session', params: { sessionId: created.id } });
  } finally {
    creating.value = false;
  }
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
  const updated = await run(() =>
    plannerClient.confirmIntakeType(current.id, confirmation, action.key, current.version),
  );
  if (updated === undefined) return;
  actions.settle(scope, action);
  applySession(updated);
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
      mutationError.value = '답변을 입력하거나 [모름] 또는 [건너뛰기]를 선택하세요.';
      return;
    }
    if (typeof value === 'number' && !Number.isFinite(value)) {
      mutationError.value = '숫자를 입력하세요.';
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
  const updated = await run(() =>
    plannerClient.answerIntakeQuestions(
      current.id,
      [payload],
      actionToken.key,
      current.version,
    ),
  );
  if (updated === undefined) return;
  actions.settle(scope, actionToken);
  answerText[question.field] = '';
  applySession(updated);
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
      title: '새 단계',
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
    mutationError.value = '초안에 오류가 있습니다. 표시된 항목을 수정하세요.';
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
          liveMessage.value = `승인 처리 중입니다. ${seconds}초 후 다시 시도합니다.`;
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
  return REASON_LABELS[reason] ?? reason;
}

function fieldLabel(field: IntakeField): string {
  return FIELD_LABELS[field];
}

const confidencePercent = computed(() =>
  Math.round((session.value?.detectedType?.confidence ?? 0) * 100),
);
const detectedReasons = computed(() => session.value?.detectedType?.reasons ?? []);
const nextMilestone = '다음 단계: 일정안(곧 지원)';
</script>

<template>
  <section class="page wizard" aria-labelledby="wizard-heading">
    <header class="page-header">
      <div>
        <p class="breadcrumb">
          <RouterLink to="/inbox">Inbox</RouterLink>
        </p>
        <h1 id="wizard-heading" ref="heading" tabindex="-1">계획 마법사</h1>
      </div>
      <div v-if="session !== null && !terminal && currentStep < 5" class="wizard-controls">
        <button
          v-if="canPause"
          type="button"
          :disabled="!canMutate"
          @click="sessionAction('pause')"
        >
          일시정지
        </button>
        <button v-else-if="canResume" type="button" :disabled="!canMutate" @click="sessionAction('resume')">
          재개
        </button>
        <button type="button" class="danger" :disabled="!canMutate" @click="sessionAction('cancel')">
          취소
        </button>
      </div>
    </header>

    <p class="visually-hidden" aria-live="polite">{{ liveMessage }}</p>

    <nav aria-label="계획 단계">
      <ol class="wizard-progress">
        <li
          v-for="(label, index) in STEP_LABELS"
          :key="label"
          :class="{
            'wizard-progress--current': currentStep === index + 1,
            'wizard-progress--done': currentStep > index + 1,
          }"
          :aria-current="currentStep === index + 1 ? 'step' : undefined"
        >
          <span class="wizard-progress-number">{{ index + 1 }}</span>
          <span>{{ label }}</span>
          <span v-if="index === 4" class="muted">곧 지원</span>
        </li>
      </ol>
    </nav>

    <div v-if="llmIssue !== null" class="llm-banner" role="alert">
      <p>AI를 사용할 수 없습니다: {{ llmIssue }}</p>
      <p>다른 기능은 계속 사용할 수 있으며, 직접 작성으로 진행할 수 있습니다.</p>
      <button v-if="session !== null && !terminal" type="button" :disabled="!canMutate" @click="enterManual">
        직접 작성으로 전환
      </button>
      <button v-else type="button" :disabled="creating" @click="createSession">다시 시도</button>
    </div>

    <p v-if="!offline.mutationsEnabled" class="offline-note" role="status">
      오프라인: 읽기 전용입니다. 연결이 돌아오면 변경할 수 있습니다.
    </p>

    <p v-if="mutationError !== null" class="error-text" role="alert">{{ mutationError }}</p>

    <div v-if="terminal" class="wizard-card" role="status">
      <h2>계획 세션이 종료되었습니다</h2>
      <p class="muted">이 세션은 더 이상 변경할 수 없습니다.</p>
      <RouterLink to="/plan/new">새 계획 시작</RouterLink>
    </div>

    <div v-else-if="!isNew && sessionQuery.isLoading.value" class="wizard-card">
      <p class="muted">계획을 불러오는 중…</p>
    </div>

    <div v-else-if="!isNew && sessionQuery.isError.value" class="wizard-card error-panel">
      <p class="error-text" role="alert">계획을 불러오지 못했습니다.</p>
      <button type="button" @click="retry">다시 시도</button>
    </div>

    <form
      v-else-if="currentStep === 1"
      class="wizard-card"
      aria-labelledby="step1-heading"
      @submit.prevent="createSession"
    >
      <h2 id="step1-heading">1단계 · 기본정보</h2>
      <p class="muted">제목과 마감만 있으면 시작할 수 있습니다.</p>

      <label for="wizard-title">제목</label>
      <input
        id="wizard-title"
        v-model="form.title"
        type="text"
        maxlength="200"
        required
        :disabled="creating || !offline.mutationsEnabled"
      />

      <label for="wizard-due">마감 (선택, 현지 시간)</label>
      <input
        id="wizard-due"
        v-model="form.dueAt"
        type="datetime-local"
        :disabled="creating || !offline.mutationsEnabled"
      />

      <label for="wizard-description">설명 (선택)</label>
      <textarea
        id="wizard-description"
        v-model="form.description"
        rows="3"
        maxlength="4000"
        :disabled="creating || !offline.mutationsEnabled"
      ></textarea>

      <label for="wizard-file">파일 이름 (선택, 업로드는 곧 지원)</label>
      <input
        id="wizard-file"
        v-model="form.fileName"
        type="text"
        maxlength="200"
        :disabled="creating || !offline.mutationsEnabled"
      />

      <button
        type="submit"
        class="primary-action"
        :disabled="creating || !offline.mutationsEnabled || form.title.trim().length === 0"
      >
        {{ creating ? '만드는 중…' : '다음' }}
      </button>
    </form>

    <section
      v-else-if="currentStep === 2"
      class="wizard-card"
      aria-labelledby="step2-heading"
    >
      <h2 id="step2-heading">2단계 · 유형 확인</h2>
      <div class="similar-card" role="group" aria-labelledby="similar-heading">
        <h3 id="similar-heading">이전 작업과 비슷해요</h3>
        <p>
          이전 <strong>{{ templateName }}</strong> 유형과 비슷합니다.
          신뢰도 <strong>{{ confidencePercent }}%</strong>
        </p>
        <ul class="reason-list" aria-label="판단 근거">
          <li v-for="reason in detectedReasons" :key="reason" class="chip">{{ reason }}</li>
        </ul>
        <p>이번에도 같은 유형인가요?</p>
        <div class="dialog-actions">
          <button
            type="button"
            class="primary-action"
            :disabled="!canMutate || paused || templateId === undefined"
            @click="confirmType(true)"
          >
            예
          </button>
          <button type="button" :disabled="!canMutate || paused" @click="confirmType(false)">아니오</button>
        </div>
      </div>
    </section>

    <section
      v-else-if="currentStep === 3"
      class="wizard-card"
      aria-labelledby="step3-heading"
    >
      <h2 id="step3-heading">3단계 · 질문</h2>
      <p class="muted">라운드당 최대 5개 질문입니다. 모르면 [모름], 나중에 답하려면 [건너뛰기]를 선택하세요.</p>
      <p v-if="paused" class="offline-note" role="status">
        일시정지되었습니다. 재개하면 이어서 답할 수 있습니다.
      </p>

      <ul v-if="questions.length > 0" class="question-list">
        <li v-for="question in questions" :key="question.field" class="question-card">
          <fieldset :disabled="questionsLocked">
            <legend>
              {{ question.prompt }}
              <span v-if="question.required" class="chip">필수</span>
            </legend>

            <label :for="`answer-${question.field}`">답변</label>
            <select
              v-if="isSelectField(question.field)"
              :id="`answer-${question.field}`"
              v-model="answerText[question.field]"
            >
              <option value="">선택하세요</option>
              <option value="small">small</option>
              <option value="medium">medium</option>
              <option value="large">large</option>
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

            <div class="dialog-actions">
              <button
                type="button"
                class="primary-action"
                :disabled="questionsLocked"
                @click="answer(question, 'answer')"
              >
                답변
              </button>
              <button type="button" :disabled="questionsLocked" @click="answer(question, 'idk')">
                모름
              </button>
              <button type="button" :disabled="questionsLocked" @click="answer(question, 'skip')">
                건너뛰기
              </button>
            </div>
          </fieldset>
        </li>
      </ul>
      <p v-else class="muted">남은 질문이 없습니다.</p>

      <section v-if="assumptions.length > 0" aria-labelledby="assumptions-heading">
        <h3 id="assumptions-heading">가정</h3>
        <ul class="assumption-list">
          <li v-for="assumption in assumptions" :key="assumption.field" class="assumption-item">
            <span>{{ fieldLabel(assumption.field) }}</span>
            <span class="chip">{{ reasonLabel(assumption.reason) }}</span>
            <span class="muted">{{ assumption.value }}</span>
          </li>
        </ul>
      </section>
    </section>

    <section
      v-else-if="currentStep === 4"
      class="wizard-card"
      aria-labelledby="step4-heading"
    >
      <h2 id="step4-heading">4단계 · 단계 초안</h2>
      <p class="muted">단계 수 3–12, P50 ≤ 240분, P90 ≥ P50, 검토/버퍼 1개 이상, 순환 없는 의존 관계.</p>

      <p v-if="draftConflict" class="error-text" role="alert">
        다른 곳에서 초안이 먼저 변경되었습니다. 작성 중인 내용은 유지됩니다.
        <button type="button" class="link-button" @click="reloadDraft">최신 초안 불러오기</button>
      </p>

      <template v-if="draft !== null">
        <ol class="draft-step-list">
          <li v-for="(step, index) in draft.steps" :key="step.key" class="draft-step-card">
            <h3>{{ step.key }}</h3>

            <label :for="`step-title-${step.key}`">제목</label>
            <input
              :id="`step-title-${step.key}`"
              v-model="step.title"
              type="text"
              maxlength="120"
              :disabled="!offline.mutationsEnabled || paused"
            />

            <label :for="`step-deliverable-${step.key}`">산출물</label>
            <input
              :id="`step-deliverable-${step.key}`"
              v-model="step.deliverable"
              type="text"
              maxlength="300"
              :disabled="!offline.mutationsEnabled || paused"
            />

            <label :for="`step-done-${step.key}`">완료 기준</label>
            <input
              :id="`step-done-${step.key}`"
              v-model="step.doneCriteria"
              type="text"
              maxlength="300"
              :disabled="!offline.mutationsEnabled || paused"
            />

            <label :for="`step-kind-${step.key}`">종류</label>
            <select
              :id="`step-kind-${step.key}`"
              v-model="step.kind"
              :disabled="!offline.mutationsEnabled || paused"
            >
              <option value="prep">prep</option>
              <option value="work">work</option>
              <option value="review">review</option>
              <option value="buffer">buffer</option>
            </select>

            <label :for="`step-p50-${step.key}`">P50 (분)</label>
            <input
              :id="`step-p50-${step.key}`"
              v-model.number="step.estimate.p50Minutes"
              type="number"
              min="5"
              max="2400"
              :disabled="!offline.mutationsEnabled || paused"
            />

            <label :for="`step-p90-${step.key}`">P90 (분)</label>
            <input
              :id="`step-p90-${step.key}`"
              v-model.number="step.estimate.p90Minutes"
              type="number"
              min="5"
              max="4800"
              :disabled="!offline.mutationsEnabled || paused"
            />

            <fieldset class="dependency-fieldset">
              <legend>선행 단계</legend>
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

            <p v-for="issue in issuesFor(step)" :key="issue.code + issue.message" class="error-text">
              {{ issue.message }}
            </p>

            <button
              type="button"
              class="danger"
              :disabled="draftLocked || draft.steps.length <= 3"
              @click="removeStep(index)"
            >
              단계 삭제
            </button>
          </li>
        </ol>

        <p v-for="issue in generalDraftIssues" :key="issue.code + issue.message" class="error-text">
          {{ issue.message }}
        </p>

        <div class="dialog-actions">
          <button
            type="button"
            :disabled="draftLocked || draft.steps.length >= 12"
            @click="addStep"
          >
            단계 추가
          </button>
          <button type="button" :disabled="draftLocked" @click="saveDraft">초안 저장</button>
          <button
            type="button"
            class="primary-action"
            :disabled="draftLocked"
            @click="approve"
          >
            초안 승인
          </button>
        </div>
      </template>
      <p v-else class="muted">초안을 준비하는 중…</p>

      <section v-if="assumptions.length > 0" aria-labelledby="draft-assumptions-heading">
        <h3 id="draft-assumptions-heading">가정</h3>
        <ul class="assumption-list">
          <li v-for="assumption in assumptions" :key="assumption.field" class="assumption-item">
            <span>{{ fieldLabel(assumption.field) }}</span>
            <span class="chip">{{ reasonLabel(assumption.reason) }}</span>
            <span class="muted">{{ assumption.value }}</span>
          </li>
        </ul>
      </section>
    </section>

    <section
      v-else-if="currentStep === 5"
      class="wizard-card"
      aria-labelledby="step5-heading"
    >
      <h2 id="step5-heading">초안 승인 완료</h2>
      <p>단계 초안이 승인되어 작업이 생성되었습니다.</p>
      <p class="next-milestone">{{ nextMilestone }}</p>
      <div class="dialog-actions">
        <RouterLink class="button-link" to="/inbox">인박스에서 생성된 작업 보기</RouterLink>
        <RouterLink class="button-link" to="/projects">프로젝트 보기</RouterLink>
      </div>
    </section>

    <footer
      v-if="session !== null && !terminal && currentStep >= 2 && currentStep <= 4"
      class="wizard-footer"
    >
      <button type="button" class="link-button" :disabled="!canMutate || paused" @click="enterManual">
        직접 작성으로 전환
      </button>
    </footer>
  </section>
</template>
