<script setup lang="ts">
import { computed, nextTick, ref } from 'vue';
import { useQuery, useQueryClient } from '@tanstack/vue-query';
import {
  ActionStore,
  ApiError,
  isStoredFinalResult,
  plannerClient,
  type EstimationProfile,
  type EstimationProfileGroup,
  type EstimationProfileItem,
  type EstimationReset,
  type Task,
} from '../api';
import UiBadge from '../components/ui/UiBadge.vue';
import UiBanner from '../components/ui/UiBanner.vue';
import UiButton from '../components/ui/UiButton.vue';
import UiCard from '../components/ui/UiCard.vue';
import UiDialog from '../components/ui/UiDialog.vue';
import UiIcon from '../components/ui/UiIcon.vue';
import UiSkeleton from '../components/ui/UiSkeleton.vue';
import { t, tp } from '../i18n';
import { browserTimeZone, formatDate, formatDuration, formatNumber } from '../i18n/format';
import { errorMessage } from '../i18n/problem';
import { confidenceText, groupDimensionLabel, ratioText, stepKindLabel } from '../i18n/replan';
import { runOwnerBound, type OwnerSteps } from '../session/ownerBound';
import { captureOwnerBinding } from '../session/ownerEpoch';
import { useAuthStore } from '../stores/auth';
import { useOfflineStore } from '../stores/offline';
import { useSessionStore } from '../stores/session';

/**
 * "내 패턴" (07 §3.5 Review, 05 §6/§10): what the estimator learned from
 * session reviews. Per task type it shows the prior (×1) against the personal
 * mean and the applied, shrunk correction with sample count and confidence;
 * each feedback item can be excluded or re-included, and corrections can be
 * reset after an explicit confirmation. Only minutes and ratios are shown —
 * never review notes.
 */
const PAGE_SIZE = 20;

const auth = useAuthStore();
const offline = useOfflineStore();
const sessionStore = useSessionStore();
const queryClient = useQueryClient();
const actions = new ActionStore();

const ownerKey = computed(() => sessionStore.ownerId ?? 'anonymous');
const timeZone = computed(() => auth.user?.timeZone ?? browserTimeZone());
const readOnly = computed(() => !offline.mutationsEnabled);

const profileKey = computed(() => ['estimation-profile', ownerKey.value]);
const profileQuery = useQuery({
  queryKey: profileKey,
  queryFn: () => {
    const binding = captureOwnerBinding();
    return plannerClient.getEstimationProfile(binding.signal);
  },
});
const templatesQuery = useQuery({
  queryKey: computed(() => ['templates', 'patterns', ownerKey.value]),
  queryFn: () => plannerClient.listTaskTemplates({ limit: 100 }),
});
const tasksQuery = useQuery({
  queryKey: computed(() => ['tasks', 'patterns', ownerKey.value]),
  queryFn: async () => {
    const tasks: Task[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 5; page += 1) {
      const result = await plannerClient.listTasks({ limit: 100, ...(cursor === undefined ? {} : { cursor }) });
      tasks.push(...result.items);
      if (result.nextCursor === null) break;
      cursor = result.nextCursor;
    }
    return tasks;
  },
});

const profile = computed<EstimationProfile | null>(() => profileQuery.data.value ?? null);
const templateNames = computed(
  () => new Map((templatesQuery.data.value?.items ?? []).map((template) => [template.id, template.name])),
);
const taskTitles = computed(() => new Map((tasksQuery.data.value ?? []).map((task) => [task.id, task.title])));

const coldStart = computed(() => profile.value !== null && profile.value.items.length === 0);
const groups = computed(() => {
  const list = [...(profile.value?.groups ?? [])];
  return list.sort((left, right) =>
    left.dimension === right.dimension ? right.sampleCount - left.sampleCount : left.dimension === 'template' ? -1 : 1,
  );
});

const visibleCount = ref(PAGE_SIZE);
const items = computed(() => profile.value?.items ?? []);
const visibleItems = computed(() => items.value.slice(0, visibleCount.value));

function templateName(templateId: string | undefined): string {
  if (templateId === undefined) return t('patterns.groupTemplateFallback');
  return templateNames.value.get(templateId) ?? t('patterns.groupTemplateFallback');
}

function groupTitle(group: EstimationProfileGroup): string {
  if (group.dimension === 'template') return t('patterns.groupTemplate', { name: templateName(group.templateId) });
  return t('patterns.groupKind', { kind: group.taskKind === undefined ? groupDimensionLabel(group) : stepKindLabel(group.taskKind) });
}

function itemTitle(item: EstimationProfileItem): string {
  const title = taskTitles.value.get(item.taskId);
  if (title !== undefined) return title;
  if (item.taskKind !== undefined) return t('patterns.taskFallback', { kind: stepKindLabel(item.taskKind) });
  return t('patterns.taskUnknown');
}

function itemDate(item: EstimationProfileItem): string {
  return formatDate(item.createdAt, timeZone.value);
}

function qualityKey(item: EstimationProfileItem): 'ok' | 'outlier' | 'excluded' {
  if (item.excluded) return 'excluded';
  return item.quality === 'outlier' ? 'outlier' : 'ok';
}

const QUALITY_TONES = { ok: 'success', outlier: 'warn', excluded: 'neutral' } as const;

const announcement = ref('');
const errorText = ref<string | null>(null);
const busyId = ref<string | null>(null);
const resetTarget = ref<EstimationReset | null>(null);
const resetBusy = ref(false);
const resetError = ref<string | null>(null);
const summaryHeading = ref<HTMLElement | null>(null);

/** Announce politely. A generator: its own wait is fenced like the task's (delegate with `yield*`). */
function* announce(message: string): OwnerSteps<void> {
  announcement.value = '';
  yield nextTick();
  announcement.value = message;
}

function samePayload<T>(left: T, right: T): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

// Owner isolation (ADR-023): toggle and reset run under the owner who started
// them (runOwnerBound). After a user switch nothing is cached or announced.
async function toggle(item: EstimationProfileItem, include: boolean): Promise<void> {
  if (readOnly.value || busyId.value !== null) return;
  const excluded = !include;
  if (item.excluded === excluded) return;
  busyId.value = item.feedbackId;
  errorText.value = null;
  const scope = `feedback:${item.feedbackId}`;
  const action = actions.begin(scope, { excluded }, samePayload, item.version);
  await runOwnerBound(
    function* (owner) {
      try {
        yield* owner.wait(
          plannerClient.patchEstimationFeedback(item.feedbackId, excluded, action.key, item.version, owner.signal),
        );
        actions.settle(scope, action);
        yield* owner.wait(profileQuery.refetch());
        yield* announce(excluded ? t('patterns.excludedDone') : t('patterns.includedDone'));
      } catch (cause) {
        // M5-03R-1 M1: keep the key unless the server stored a final result.
        if (isStoredFinalResult(cause)) actions.settle(scope, action);
        if (cause instanceof ApiError && cause.status === 412) {
          yield* owner.wait(profileQuery.refetch());
          errorText.value = t('patterns.toggleConflict');
        } else {
          errorText.value = errorMessage(cause, t('patterns.toggleError'));
        }
      }
    },
    {
      onSettled: () => {
        busyId.value = null;
      },
    },
  );
}

function onToggle(item: EstimationProfileItem, event: Event): void {
  const target = event.target;
  if (!(target instanceof HTMLInputElement)) return;
  // The switch mirrors the server state; it only flips once the PATCH lands.
  target.checked = !item.excluded;
  // Currently excluded → include it again, and vice versa.
  void toggle(item, item.excluded);
}

function openReset(target: EstimationReset): void {
  if (readOnly.value) return;
  resetError.value = null;
  resetTarget.value = target;
}

const resetCount = computed(() => {
  const target = resetTarget.value;
  if (target === null) return 0;
  if (target.scope === 'all') return items.value.length;
  return items.value.filter((item) => item.templateId === target.templateId).length;
});

async function confirmReset(): Promise<void> {
  const target = resetTarget.value;
  if (target === null || readOnly.value || resetBusy.value) return;
  resetBusy.value = true;
  resetError.value = null;
  const scope = `estimation:reset:${target.scope}:${target.templateId ?? ''}`;
  const action = actions.begin(scope, target, samePayload);
  await runOwnerBound(
    function* (owner) {
      try {
        const refreshed = yield* owner.wait(plannerClient.resetEstimation(action.payload, action.key, owner.signal));
        actions.settle(scope, action);
        queryClient.setQueryData(profileKey.value, refreshed);
        resetTarget.value = null;
        visibleCount.value = PAGE_SIZE;
        yield* announce(t('patterns.resetDone'));
        yield* owner.wait(nextTick());
        summaryHeading.value?.focus();
      } catch (cause) {
        // M5-03R-1 M1: keep the key unless the server stored a final result.
        if (isStoredFinalResult(cause)) actions.settle(scope, action);
        resetError.value = errorMessage(cause, t('patterns.resetError'));
      }
    },
    {
      onSettled: () => {
        resetBusy.value = false;
      },
    },
  );
}
</script>

<template>
  <section class="page page--wide patterns-page">
    <header class="page-header">
      <div class="page-heading">
        <h1>{{ t('patterns.title') }}</h1>
        <p class="page-lede">{{ t('patterns.lede') }}</p>
      </div>
      <div class="page-actions">
        <UiBadge v-if="readOnly" tone="offline" dot class="chip--offline" role="status">
          {{ t('common.readOnlyOffline') }}
        </UiBadge>
      </div>
    </header>

    <p class="status-region status-note" role="status" aria-live="polite">{{ announcement }}</p>

    <div v-if="profileQuery.isLoading.value">
      <p class="visually-hidden" role="status">{{ t('patterns.loading') }}</p>
      <UiSkeleton variant="card" :count="2" :lines="3" />
    </div>
    <UiBanner v-else-if="profileQuery.isError.value || profile === null" tone="error" class="error-panel">
      <p class="error-text" role="alert">{{ t('patterns.loadError') }}</p>
      <template #actions>
        <UiButton size="sm" icon="sync" @click="profileQuery.refetch()">{{ t('common.retry') }}</UiButton>
      </template>
    </UiBanner>

    <template v-else>
      <UiBanner v-if="readOnly" tone="offline">{{ t('patterns.offline') }}</UiBanner>
      <UiBanner v-if="errorText" tone="error" role="alert">{{ errorText }}</UiBanner>

      <div class="patterns-layout">
        <UiCard class="patterns-summary" aria-labelledby="patterns-summary-title">
          <h2 id="patterns-summary-title" ref="summaryHeading" class="card-title" tabindex="-1">
            {{ t('patterns.summaryTitle') }}
          </h2>
          <dl class="stat-grid patterns-stats">
            <div class="stat">
              <dt>{{ t('patterns.samples') }}</dt>
              <dd class="stat-value" data-summary="samples">{{ tp('patterns.samplesValue', profile.sampleCount) }}</dd>
            </div>
            <div class="stat">
              <dt>{{ t('patterns.confidence') }}</dt>
              <dd class="stat-value" data-summary="confidence">{{ confidenceText(profile.confidence) }}</dd>
            </div>
          </dl>
        </UiCard>

        <UiCard v-if="coldStart" class="patterns-cold" variant="sunken" aria-labelledby="patterns-cold-title" data-cold-start>
          <h2 id="patterns-cold-title" class="card-title">{{ t('patterns.coldTitle') }}</h2>
          <p>{{ t('patterns.coldBody') }}</p>
          <p class="muted">{{ t('patterns.coldNext') }}</p>
        </UiCard>

        <UiCard class="patterns-method" variant="flat" aria-labelledby="patterns-method-title">
          <h2 id="patterns-method-title" class="card-title">{{ t('patterns.methodTitle') }}</h2>
          <ul class="patterns-method-list">
            <li v-if="!coldStart">{{ t('patterns.coldBody') }}</li>
            <li>{{ t('patterns.methodShrink', { k: profile.shrinkageK }) }}</li>
            <li>{{ t('patterns.methodOutlier', { z: formatNumber(profile.outlierZThreshold, 1) }) }}</li>
          </ul>
        </UiCard>
      </div>

      <section class="patterns-groups" aria-labelledby="patterns-groups-title">
        <div class="section-head">
          <h2 id="patterns-groups-title" class="h2">{{ t('patterns.groupsTitle') }}</h2>
        </div>
        <p class="muted patterns-section-lede">{{ t('patterns.groupsLede') }}</p>
        <ul v-if="groups.length > 0" class="patterns-group-list">
          <UiCard v-for="group in groups" :key="group.key" as="li" compact class="patterns-group" :data-group="group.key">
            <div class="patterns-group-head">
              <h3 class="h3">{{ groupTitle(group) }}</h3>
              <p class="patterns-group-meta muted">
                <span class="tabular">{{ tp('patterns.sampleCount', group.sampleCount) }}</span>
                <span class="tabular">{{ t('patterns.confidence') }} {{ confidenceText(group.confidence) }}</span>
              </p>
            </div>
            <dl class="patterns-ratios">
              <div class="stat">
                <dt>{{ t('patterns.prior') }}</dt>
                <dd class="stat-value">{{ ratioText(1) }}</dd>
              </div>
              <div class="stat">
                <dt>{{ t('patterns.personal') }}</dt>
                <dd class="stat-value" data-ratio="personal">{{ ratioText(Math.exp(group.stats.logRatioMean)) }}</dd>
              </div>
              <div class="stat">
                <dt>{{ t('patterns.applied') }}</dt>
                <dd class="stat-value" data-ratio="applied">{{ ratioText(group.stats.p50Ratio) }}</dd>
              </div>
              <div class="stat">
                <dt>{{ t('patterns.appliedP90') }}</dt>
                <dd class="stat-value">{{ ratioText(group.stats.p90Ratio) }}</dd>
              </div>
            </dl>
            <p class="field-help patterns-group-help">
              {{ t('patterns.groupMethod', { dimension: groupDimensionLabel(group), k: profile.shrinkageK }) }}
            </p>
            <div v-if="group.dimension === 'template' && group.templateId" class="card-footer">
              <UiButton
                size="sm"
                variant="danger-ghost"
                icon="trash"
                :disabled="readOnly"
                @click="openReset({ scope: 'template', templateId: group.templateId })"
              >
                {{ t('patterns.resetTemplate') }}
              </UiButton>
            </div>
          </UiCard>
        </ul>
        <p v-else class="muted">{{ t('patterns.groupsEmpty') }}</p>
      </section>

      <section class="patterns-feedback" aria-labelledby="patterns-feedback-title">
        <div class="section-head">
          <h2 id="patterns-feedback-title" class="h2">{{ t('patterns.feedbackTitle') }}</h2>
        </div>
        <p class="muted patterns-section-lede">{{ t('patterns.feedbackLede') }}</p>
        <ul v-if="visibleItems.length > 0" class="patterns-items" :aria-label="t('patterns.feedbackList')">
          <li
            v-for="item in visibleItems"
            :key="item.feedbackId"
            class="patterns-item"
            :class="{ 'patterns-item--off': qualityKey(item) !== 'ok' }"
            :data-feedback-id="item.feedbackId"
          >
            <div class="patterns-item-main">
              <p class="patterns-item-title">{{ itemTitle(item) }}</p>
              <p class="patterns-item-meta muted">
                <span>{{ itemDate(item) }}</span>
                <span class="tabular">
                  {{ t('patterns.feedbackItem', { estimated: formatDuration(item.estimatedP50), actual: formatDuration(item.actualFocusMin) }) }}
                </span>
                <span class="tabular patterns-item-ratio">{{ ratioText(item.ratio) }}</span>
              </p>
            </div>
            <UiBadge :tone="QUALITY_TONES[qualityKey(item)]" dot data-quality>{{ t(`patterns.quality.${qualityKey(item)}`) }}</UiBadge>
            <label class="patterns-switch">
              <input
                type="checkbox"
                role="switch"
                class="switch"
                :checked="!item.excluded"
                :disabled="readOnly || busyId !== null"
                :aria-label="t('patterns.includeAria', { title: itemTitle(item), date: itemDate(item) })"
                :aria-busy="busyId === item.feedbackId ? 'true' : undefined"
                data-include
                @change="onToggle(item, $event)"
              />
              <span class="patterns-switch-label">{{ t('patterns.include') }}</span>
            </label>
          </li>
        </ul>
        <p v-else class="muted">{{ t('patterns.feedbackEmpty') }}</p>
        <div class="patterns-feedback-actions">
          <UiButton v-if="items.length > visibleCount" size="sm" @click="visibleCount += PAGE_SIZE">
            {{ t('patterns.showMore') }}
          </UiButton>
          <UiButton
            variant="danger-ghost"
            icon="trash"
            :disabled="readOnly || items.length === 0"
            data-reset-all
            @click="openReset({ scope: 'all' })"
          >
            {{ t('patterns.resetAll') }}
          </UiButton>
        </div>
      </section>
    </template>

    <UiDialog
      v-if="resetTarget"
      role="alertdialog"
      labelledby="patterns-reset-title"
      describedby="patterns-reset-body"
      size="sm"
      as="section"
      class="patterns-reset-dialog"
      :dismissible="!resetBusy"
      @close="resetTarget = null"
    >
      <header class="dialog-header dialog-header--start">
        <span class="dialog-icon dialog-icon--warn"><UiIcon name="trash" :size="22" /></span>
        <div class="dialog-heading">
          <h2 id="patterns-reset-title" class="dialog-title">
            {{
              resetTarget.scope === 'all'
                ? t('patterns.resetTitleAll')
                : t('patterns.resetTitleTemplate', { name: templateName(resetTarget.templateId) })
            }}
          </h2>
          <div id="patterns-reset-body" class="muted">
            <p>
              {{
                resetTarget.scope === 'all'
                  ? tp('patterns.resetBodyAll', resetCount)
                  : tp('patterns.resetBodyTemplate', resetCount)
              }}
            </p>
            <p class="danger">{{ t('patterns.resetIrreversible') }}</p>
          </div>
        </div>
      </header>
      <UiBanner v-if="resetError" tone="error" role="alert">{{ resetError }}</UiBanner>
      <div class="dialog-actions">
        <UiButton variant="ghost" :disabled="resetBusy" data-autofocus @click="resetTarget = null">
          {{ t('common.cancel') }}
        </UiButton>
        <UiButton variant="danger" :disabled="resetBusy" :busy="resetBusy" data-reset-confirm @click="confirmReset">
          {{
            resetBusy
              ? t('patterns.resetting')
              : resetTarget.scope === 'all'
                ? t('patterns.resetConfirmAll')
                : t('patterns.resetConfirmTemplate')
          }}
        </UiButton>
      </div>
    </UiDialog>
  </section>
</template>
