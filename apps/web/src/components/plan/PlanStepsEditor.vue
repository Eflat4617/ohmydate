<script setup lang="ts">
import { computed, ref } from 'vue';
import type { DecompositionDraft, DecompositionStep } from '../../api';
import {
  MAX_STEPS,
  MIN_STEPS,
  generalIssues,
  issuesForStep,
  validateDraft,
  type DraftIssue,
} from '../../domain/draftValidation';
import { t, tp } from '../../i18n';
import { formatHoursAndMinutes } from '../../i18n/format';
import UiButton from '../ui/UiButton.vue';
import UiIcon from '../ui/UiIcon.vue';

/**
 * 계획 세우기 · 단계 (HOLO-03A): the steps the work was split into, as rows
 * a person can read down — a number, the step's name, its kind and two
 * times: what it usually takes and a cautious figure. What a step delivers,
 * when it counts as done and which steps come first are one press away
 * ("자세히"), because most of the time only names and times are touched.
 *
 * The total is the card's number. What breaks a rule is said under the row
 * it belongs to (or under the list when it is about the whole).
 *
 * The draft is never changed in place: every edit is a new draft
 * (`update:draft`), so the screen decides what is saved.
 */
const props = withDefaults(defineProps<{ draft: DecompositionDraft; disabled?: boolean }>(), { disabled: false });
const emit = defineEmits<{ 'update:draft': [draft: DecompositionDraft] }>();

const KINDS = ['prep', 'work', 'review', 'buffer'] as const;

const validation = computed(() => validateDraft(props.draft));
const general = computed<readonly DraftIssue[]>(() => generalIssues(validation.value));
const totals = computed(() => ({
  usual: props.draft.steps.reduce((sum, step) => sum + (Number(step.estimate.p50Minutes) || 0), 0),
  cautious: props.draft.steps.reduce((sum, step) => sum + (Number(step.estimate.p90Minutes) || 0), 0),
}));

/** Steps whose details are on show. */
const open = ref<ReadonlySet<string>>(new Set());

function toggle(key: string): void {
  const next = new Set(open.value);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  open.value = next;
}

function issuesOf(step: DecompositionStep): readonly DraftIssue[] {
  return issuesForStep(validation.value, step.key);
}

function withSteps(steps: DecompositionStep[]): void {
  emit('update:draft', { ...props.draft, steps });
}

function patch(index: number, change: Partial<DecompositionStep>): void {
  withSteps(props.draft.steps.map((step, position) => (position === index ? { ...step, ...change } : step)));
}

function textOf(event: Event): string {
  const target = event.target;
  return target instanceof HTMLInputElement || target instanceof HTMLSelectElement ? target.value : '';
}

/** A field of minutes: what was typed as a number; an empty field is 0 (the rules then say what is wrong). */
function minutesOf(event: Event): number {
  const value = Number(textOf(event));
  return Number.isFinite(value) ? value : 0;
}

function setEstimate(index: number, key: 'p50Minutes' | 'p90Minutes', event: Event): void {
  const step = props.draft.steps[index];
  if (step === undefined) return;
  patch(index, { estimate: { ...step.estimate, [key]: minutesOf(event) } });
}

function setKind(index: number, event: Event): void {
  const kind = textOf(event);
  if ((KINDS as readonly string[]).includes(kind)) patch(index, { kind: kind as DecompositionStep['kind'] });
}

function toggleDependency(index: number, key: string): void {
  const step = props.draft.steps[index];
  if (step === undefined) return;
  patch(index, {
    dependsOn: step.dependsOn.includes(key) ? step.dependsOn.filter((ref) => ref !== key) : [...step.dependsOn, key],
  });
}

function nextKey(): string {
  const used = new Set(props.draft.steps.map((step) => step.key));
  for (let index = 1; index <= MAX_STEPS; index += 1) {
    const key = `s${index}`;
    if (!used.has(key)) return key;
  }
  return `s${MAX_STEPS}`;
}

function addStep(): void {
  if (props.draft.steps.length >= MAX_STEPS) return;
  const key = nextKey();
  withSteps([
    ...props.draft.steps,
    {
      key,
      title: t('planSteps.newStep'),
      deliverable: '',
      doneCriteria: '',
      kind: 'work',
      estimate: { p50Minutes: 30, p90Minutes: 45 },
      dependsOn: [],
      splittable: true,
    },
  ]);
}

/** Take a step out, and with it every "comes after it" that pointed at it. */
function removeStep(index: number): void {
  if (props.draft.steps.length <= MIN_STEPS) return;
  const removed = props.draft.steps[index];
  if (removed === undefined) return;
  withSteps(
    props.draft.steps
      .filter((_step, position) => position !== index)
      .map((step) => ({ ...step, dependsOn: step.dependsOn.filter((ref) => ref !== removed.key) })),
  );
}
</script>

<template>
  <div class="plan-steps" data-plan-steps>
    <p class="plan-steps-total" data-plan-steps-total>
      <span class="plan-steps-total-label">{{ tp('planSteps.count', draft.steps.length) }}</span>
      <span class="numeral">{{ formatHoursAndMinutes(totals.usual) }}</span>
      <span class="plan-steps-total-note tabular">
        {{ t('planSteps.totalCautious', { duration: formatHoursAndMinutes(totals.cautious) }) }}
      </span>
    </p>

    <div class="plan-steps-cols" aria-hidden="true">
      <span></span>
      <span>{{ t('planSteps.name') }}</span>
      <span>{{ t('planSteps.kind') }}</span>
      <span>{{ t('planSteps.usual') }}</span>
      <span>{{ t('planSteps.cautious') }}</span>
      <span></span>
    </div>

    <ol class="plan-step-list">
      <li
        v-for="(step, index) in draft.steps"
        :key="step.key"
        class="plan-step"
        :class="{ 'plan-step--invalid': issuesOf(step).length > 0 }"
        :data-step="step.key"
      >
        <div class="plan-step-row">
          <span class="plan-step-index tabular" aria-hidden="true">{{ index + 1 }}</span>
          <input
            :id="`step-title-${step.key}`"
            class="plan-step-name"
            type="text"
            maxlength="120"
            :value="step.title"
            :aria-label="t('planSteps.nameAria', { index: index + 1 })"
            :disabled="disabled"
            @input="patch(index, { title: textOf($event) })"
          />
          <select
            :id="`step-kind-${step.key}`"
            class="plan-step-kind"
            :value="step.kind"
            :aria-label="t('planSteps.kindAria', { index: index + 1 })"
            :disabled="disabled"
            @change="setKind(index, $event)"
          >
            <option v-for="kind in KINDS" :key="kind" :value="kind">{{ t(`planSteps.kinds.${kind}`) }}</option>
          </select>
          <input
            :id="`step-p50-${step.key}`"
            class="plan-step-minutes"
            type="number"
            min="5"
            max="2400"
            inputmode="numeric"
            :value="step.estimate.p50Minutes"
            :aria-label="t('planSteps.usualAria', { index: index + 1 })"
            :disabled="disabled"
            @input="setEstimate(index, 'p50Minutes', $event)"
          />
          <input
            :id="`step-p90-${step.key}`"
            class="plan-step-minutes"
            type="number"
            min="5"
            max="4800"
            inputmode="numeric"
            :value="step.estimate.p90Minutes"
            :aria-label="t('planSteps.cautiousAria', { index: index + 1 })"
            :disabled="disabled"
            @input="setEstimate(index, 'p90Minutes', $event)"
          />
          <div class="plan-step-tools">
            <button
              type="button"
              class="btn btn--ghost btn--sm plan-step-more"
              :aria-expanded="open.has(step.key) ? 'true' : 'false'"
              :aria-controls="`step-more-${step.key}`"
              :aria-label="t('planSteps.moreAria', { index: index + 1 })"
              :data-step-more="step.key"
              @click="toggle(step.key)"
            >
              <span aria-hidden="true">{{ t('planSteps.more') }}</span>
              <UiIcon name="chevron-down" :size="16" class="plan-step-more-icon" />
            </button>
            <button
              type="button"
              class="btn btn--ghost btn--icon btn--sm"
              :aria-label="t('planSteps.removeAria', { index: index + 1 })"
              :title="t('planSteps.remove')"
              :disabled="disabled || draft.steps.length <= MIN_STEPS"
              :data-step-remove="step.key"
              @click="removeStep(index)"
            >
              <UiIcon name="trash" :size="16" />
            </button>
          </div>
        </div>

        <div v-show="open.has(step.key)" :id="`step-more-${step.key}`" class="plan-step-details">
          <div class="field-grid">
            <div class="field">
              <label class="field-label" :for="`step-deliverable-${step.key}`">{{ t('planSteps.deliverable') }}</label>
              <input
                :id="`step-deliverable-${step.key}`"
                type="text"
                maxlength="300"
                :value="step.deliverable"
                :disabled="disabled"
                @input="patch(index, { deliverable: textOf($event) })"
              />
            </div>
            <div class="field">
              <label class="field-label" :for="`step-done-${step.key}`">{{ t('planSteps.doneCriteria') }}</label>
              <input
                :id="`step-done-${step.key}`"
                type="text"
                maxlength="300"
                :value="step.doneCriteria"
                :disabled="disabled"
                @input="patch(index, { doneCriteria: textOf($event) })"
              />
            </div>
          </div>
          <fieldset class="choice-group plan-step-deps" :disabled="disabled">
            <legend>{{ t('planSteps.dependencies') }}</legend>
            <template v-for="(candidate, position) in draft.steps" :key="candidate.key">
              <label v-if="candidate.key !== step.key" class="choice-chip">
                <input
                  type="checkbox"
                  :checked="step.dependsOn.includes(candidate.key)"
                  :data-step-dep="candidate.key"
                  @change="toggleDependency(index, candidate.key)"
                />
                {{ t('planSteps.dependencyOption', { index: position + 1, title: candidate.title }) }}
              </label>
            </template>
          </fieldset>
        </div>

        <p v-for="issue in issuesOf(step)" :key="issue.code + issue.message" class="field-error plan-step-issue" :data-issue="issue.code">
          <UiIcon name="error" :size="16" /><span>{{ issue.message }}</span>
        </p>
      </li>
    </ol>

    <p v-for="issue in general" :key="issue.code + issue.message" class="field-error" :data-issue="issue.code">
      <UiIcon name="error" :size="16" /><span>{{ issue.message }}</span>
    </p>

    <div class="plan-steps-foot">
      <UiButton icon="plus" variant="ghost" :disabled="disabled || draft.steps.length >= MAX_STEPS" data-step-add @click="addStep">
        {{ t('planSteps.add') }}
      </UiButton>
      <p class="field-help">{{ t('planSteps.rules') }}</p>
    </div>
  </div>
</template>
