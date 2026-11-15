<script setup lang="ts">
import { computed } from 'vue';
import { useQuery } from '@tanstack/vue-query';
import { ApiError, plannerClient } from '../../api';
import { forgetPlanFlow, readPlanFlows, usePlanFlows } from '../../composables/planFlowMemory';
import { retryTransient } from '../../composables/usePlannerRange';
import { sessionStage, type PlanStage } from '../../domain/planFlow';
import { t, tp } from '../../i18n';
import { ownerFenced, useOwnerKey } from '../../session/ownerBound';
import { captureOwnerBinding } from '../../session/ownerEpoch';
import UiIcon from '../ui/UiIcon.vue';

/**
 * "하던 계획" (HOLO-03A, FLOW §5 되돌아오기): the plans the owner started and
 * did not finish, each with the way back in. 계획 세우기 shows the list;
 * 개요 drops in the newest one (`limit="1"`).
 *
 * The device only knows ids (planFlowMemory); the name and how far each got
 * are read from the server, under the owner the list is for. One that turns
 * out finished, given up or gone is dropped from the device's list on the
 * spot. With nothing to go on to, nothing is rendered.
 */
const props = withDefaults(defineProps<{ limit?: number; compact?: boolean }>(), { limit: 3, compact: false });

interface Row {
  readonly kind: 'session' | 'plan';
  readonly id: string;
  readonly title: string | null;
  /** Where a session stopped; a plan is at 일정안. */
  readonly stage: PlanStage;
  /** Tasks of a plan made straight from tasks (it has no name of its own). */
  readonly taskCount: number | null;
  readonly to: string;
}

const owner = useOwnerKey();
const { entries } = usePlanFlows();

function gone(cause: unknown): boolean {
  return cause instanceof ApiError && cause.status === 404;
}

const query = useQuery({
  queryKey: computed(() => ['plan-flows', owner.value, entries.value.map((entry) => `${entry.kind}:${entry.id}`).join(',')]),
  queryFn: ({ queryKey }) =>
    ownerFenced(String(queryKey[1]), async (binding): Promise<Row[]> => {
      const rows: Row[] = [];
      for (const entry of readPlanFlows(binding.ownerId)) {
        try {
          if (entry.kind === 'session') {
            const session = await plannerClient.getIntakeSession(entry.id, { fresh: true });
            const stage = sessionStage(session);
            if (stage === 'ended' || stage === 'confirmed') {
              forgetPlanFlow(binding, 'session', entry.id);
              continue;
            }
            rows.push({ kind: 'session', id: entry.id, title: session.input.title, stage, taskCount: null, to: `/plan/${entry.id}` });
            continue;
          }
          const plan = await plannerClient.getPlan(entry.id, { fresh: true });
          if (plan.status !== 'draft') {
            forgetPlanFlow(binding, 'plan', entry.id);
            continue;
          }
          let title: string | null = null;
          if (entry.sessionId !== undefined) {
            // The plan came from a planning session: it is called what the goal was called.
            title = await plannerClient
              .getIntakeSession(entry.sessionId)
              .then((session) => session.input.title)
              .catch(() => null);
          }
          rows.push({
            kind: 'plan',
            id: entry.id,
            title,
            stage: 'schedule',
            taskCount: 'taskIds' in plan.scope ? plan.scope.taskIds.length : null,
            to: `/plan/schedule/${entry.id}${entry.sessionId === undefined ? '' : `?session=${entry.sessionId}`}`,
          });
        } catch (cause) {
          // Gone on the server: stop offering it. Anything else: leave it for the next look.
          if (gone(cause)) forgetPlanFlow(binding, entry.kind, entry.id);
        }
      }
      return rows;
    }),
  enabled: computed(() => entries.value.length > 0),
  retry: retryTransient,
});

const rows = computed(() => (entries.value.length === 0 ? [] : (query.data.value ?? []).slice(0, props.limit)));

function titleOf(row: Row): string {
  if (row.title !== null && row.title.length > 0) return row.title;
  return row.taskCount === null ? t('planFlow.resume.untitled') : tp('planFlow.resume.tasks', row.taskCount);
}

function stateOf(row: Row): string {
  return row.kind === 'plan'
    ? t('planFlow.resume.plan')
    : t('planFlow.resume.session', { stage: t(`planFlow.stage.${row.stage}`) });
}

/** Dropped at the press, under the owner who pressed. */
function forget(row: Row): void {
  forgetPlanFlow(captureOwnerBinding(), row.kind, row.id);
}
</script>

<template>
  <section
    v-if="rows.length > 0"
    class="card plan-resume"
    :class="{ 'card--compact': compact, 'plan-resume--compact': compact }"
    aria-labelledby="plan-resume-title"
    data-plan-resume
  >
    <h2 id="plan-resume-title" class="card-title"><UiIcon name="plan" :size="18" />{{ t('planFlow.resume.title') }}</h2>
    <ul class="plan-resume-list">
      <li v-for="row in rows" :key="`${row.kind}:${row.id}`" class="plan-resume-item" :data-resume="row.id" :data-resume-kind="row.kind">
        <div class="plan-resume-text">
          <p class="plan-resume-name">{{ titleOf(row) }}</p>
          <p class="plan-resume-state">{{ stateOf(row) }}</p>
        </div>
        <RouterLink class="btn btn--secondary btn--sm" :to="row.to" :aria-label="t('planFlow.resume.openAria', { title: titleOf(row) })">
          {{ t('planFlow.resume.open') }}
        </RouterLink>
        <button
          type="button"
          class="btn btn--ghost btn--icon btn--sm"
          :aria-label="t('planFlow.resume.forgetAria', { title: titleOf(row) })"
          :title="t('planFlow.resume.forget')"
          data-resume-forget
          @click="forget(row)"
        >
          <UiIcon name="close" :size="16" />
        </button>
      </li>
    </ul>
  </section>
</template>
