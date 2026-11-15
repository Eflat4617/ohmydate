<script setup lang="ts">
import { computed } from 'vue';
import type { Violation } from '../api';
import { violationText } from '../domain/plan';
import { t } from '../i18n';
import { renderExplanation, violationMessageText, type ExplanationItem } from '../i18n/explanation';

/**
 * FU-62 rendering of scheduler reasons in Korean.
 *
 * - `lines` (+ `items`): a candidate's or replan proposal's `explanation` with
 *   its coded `explanationItems`, as a collapsed "계산 근거" list. Rows written
 *   before FU-62 have no items; they keep the original English lines under
 *   "계산 근거 (원문)".
 * - `violations`: validator findings (preview-edit result or a 422
 *   `constraint_violation`). A coded finding reads as one Korean sentence; a
 *   legacy one keeps the generic text of its rule plus the original message.
 *   The rule's code (H1…H8) is not shown — it is the finding's `data-code`.
 */
const props = withDefaults(
  defineProps<{
    timeZone: string;
    lines?: readonly string[];
    items?: readonly ExplanationItem[] | undefined;
    violations?: readonly Violation[];
    taskNames?: Readonly<Record<string, string>>;
    /** What the folded list of reasons is called ("이렇게 짠 이유"); "계산 근거" by default. */
    title?: string | null;
    /** The reasons start unfolded. */
    open?: boolean;
  }>(),
  { lines: () => [], items: undefined, violations: () => [], taskNames: () => ({}), title: null, open: false },
);

const context = computed(() => ({
  timeZone: props.timeZone,
  taskName: (taskId: string) => props.taskNames[taskId],
}));

const explanation = computed(() => renderExplanation(props.lines, props.items, context.value));

const findings = computed(() =>
  props.violations.map((violation) => ({
    code: violation.code,
    text: violationMessageText(violation, context.value),
    generic: violationText(violation),
    message: violation.message,
  })),
);
</script>

<template>
  <details
    v-if="lines.length > 0"
    class="candidate-explanation"
    :open="open"
    :data-explanation="explanation.coded ? 'coded' : 'original'"
  >
    <summary>{{ explanation.coded ? (title ?? t('explanation.title')) : t('explanation.original') }}</summary>
    <ul class="explanation-list" :lang="explanation.coded ? undefined : 'en'">
      <li
        v-for="(entry, index) in explanation.entries"
        :key="index"
        :lang="explanation.coded && !entry.translated ? 'en' : undefined"
      >
        {{ entry.text }}
      </li>
    </ul>
  </details>
  <ul v-if="findings.length > 0" class="violation-list">
    <li
      v-for="(finding, index) in findings"
      :key="index"
      :data-coded="finding.text !== null ? 'true' : 'false'"
      :data-code="finding.code"
    >
      <template v-if="finding.text !== null">{{ finding.text }}</template>
      <template v-else>
        {{ finding.generic }}
        <span class="muted" lang="en">{{ finding.message }}</span>
      </template>
    </li>
  </ul>
</template>
