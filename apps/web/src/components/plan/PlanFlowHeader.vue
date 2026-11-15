<script setup lang="ts">
import { computed, ref } from 'vue';
import { PLAN_STAGES, type PlanStage } from '../../domain/planFlow';
import { t } from '../../i18n';
import UiIcon from '../ui/UiIcon.vue';

/**
 * The head every stage of 계획 세우기 shares (HOLO-03A): the title, what this
 * stage is for, and the rail that says where the flow is —
 *
 *   목표 → 질문 → 단계 → 일정안 → 확정
 *
 * A stage that is done is ticked, the current one carries the lime mark
 * (`aria-current="step"`), the ones to come are quiet. A done stage is a link
 * only where it has an address of its own (`links`): the rail never pretends
 * a step can be undone.
 */
const props = withDefaults(
  defineProps<{
    title: string;
    lede?: string | null;
    stage: PlanStage;
    /** Addresses of stages that can be opened from here. */
    links?: Partial<Record<PlanStage, string>>;
    /** The flow is over (the plan is confirmed): every stage is ticked. */
    finished?: boolean;
    /** Stages the flow did not go through (a plan made straight from tasks): marked as passed over, never ticked. */
    skipped?: readonly PlanStage[];
  }>(),
  { lede: null, links: () => ({}), finished: false, skipped: () => [] },
);

const heading = ref<HTMLElement | null>(null);
const position = computed(() => PLAN_STAGES.indexOf(props.stage));

const stages = computed(() =>
  PLAN_STAGES.map((stage, index) => {
    const skipped = props.skipped.includes(stage);
    const done = !skipped && (props.finished || index < position.value);
    const current = !props.finished && index === position.value;
    return {
      stage,
      index,
      label: t(`planFlow.stage.${stage}`),
      done,
      skipped,
      current,
      to: done && !current ? (props.links[stage] ?? null) : null,
    };
  }),
);

function focus(): void {
  heading.value?.focus();
}

defineExpose({ focus });
</script>

<template>
  <header class="page-header plan-head">
    <div class="page-heading">
      <h1 id="plan-heading" ref="heading" tabindex="-1" data-plan-title>{{ title }}</h1>
      <p v-if="lede" class="page-lede" data-plan-lede>{{ lede }}</p>
    </div>
    <div class="page-actions"><slot name="actions" /></div>
  </header>
  <nav class="plan-rail" :aria-label="t('planFlow.stages')" data-plan-rail>
    <ol class="plan-rail-list">
      <li
        v-for="item in stages"
        :key="item.stage"
        class="plan-rail-item"
        :class="{
          'plan-rail-item--done': item.done,
          'plan-rail-item--current': item.current,
          'plan-rail-item--skipped': item.skipped,
        }"
        :aria-current="item.current ? 'step' : undefined"
        :data-stage="item.stage"
        :data-state="item.current ? 'current' : item.skipped ? 'skipped' : item.done ? 'done' : 'todo'"
      >
        <span class="plan-rail-mark" aria-hidden="true">
          <UiIcon v-if="item.done" name="check" :size="12" />
          <template v-else-if="item.skipped">–</template>
          <template v-else>{{ item.index + 1 }}</template>
        </span>
        <RouterLink v-if="item.to" class="plan-rail-label" :to="item.to">
          {{ item.label }}<span class="visually-hidden"> {{ t('planFlow.stageDoneWord') }}</span>
        </RouterLink>
        <span v-else class="plan-rail-label">
          {{ item.label
          }}<span v-if="item.done" class="visually-hidden"> {{ t('planFlow.stageDoneWord') }}</span
          ><span v-else-if="item.skipped" class="visually-hidden"> {{ t('planFlow.stageSkippedWord') }}</span>
        </span>
      </li>
    </ol>
  </nav>
</template>
