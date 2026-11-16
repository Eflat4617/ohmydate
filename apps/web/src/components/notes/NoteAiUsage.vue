<script setup lang="ts">
import { computed, useId } from 'vue';
import { useInfiniteQuery } from '@tanstack/vue-query';
import { plannerClient, type NoteAiUsage, type NoteAiUsagePage, type NoteAiUsageStatus } from '../../api';
import { keyOwner, noteKeys, ownerFenced, retryFenced, useOwnerKey } from '../../composables/notes';
import { t, tp } from '../../i18n';
import { browserTimeZone, formatDateTime, formatNumber } from '../../i18n/format';
import { useAuthStore } from '../../stores/auth';
import UiBadge from '../ui/UiBadge.vue';
import UiBanner from '../ui/UiBanner.vue';
import UiButton from '../ui/UiButton.vue';
import UiIcon from '../ui/UiIcon.vue';
import UiSkeleton from '../ui/UiSkeleton.vue';

/**
 * "AI 근거 사용 이력" (07 §3.5, 08 §2.7): which AI call received which
 * sections of this note — run id, time, status, section hashes and sizes.
 * The sent text is never stored, so it is never shown.
 */
const props = defineProps<{ documentId: string | null }>();

const PAGE = 10;
const headingId = `note-ai-${useId()}`;
const owner = useOwnerKey();
const auth = useAuthStore();
const timeZone = computed(() => auth.user?.timeZone ?? browserTimeZone());

const usageQuery = useInfiniteQuery({
  queryKey: computed(() => noteKeys.usage(owner.value, props.documentId ?? 'none')),
  queryFn: ({ pageParam, queryKey }: { pageParam: string | null; queryKey: readonly unknown[] }) =>
    ownerFenced(keyOwner(queryKey), (binding) =>
      plannerClient.listDocumentAiUsage(props.documentId ?? '', {
        limit: PAGE,
        ...(pageParam === null ? {} : { cursor: pageParam }),
        signal: binding.signal,
      }),
    ),
  initialPageParam: null as string | null,
  getNextPageParam: (last: NoteAiUsagePage) => last.nextCursor,
  enabled: computed(() => props.documentId !== null),
  retry: retryFenced(),
});

const items = computed<NoteAiUsage[]>(() => (usageQuery.data.value?.pages ?? []).flatMap((page) => page.items));

const STATUS_TONES: Record<NoteAiUsageStatus, 'success' | 'danger' | 'info' | 'warn'> = {
  succeeded: 'success',
  failed: 'danger',
  pending: 'info',
  budget_exceeded: 'warn',
};

function purposeLabel(purpose: string): string {
  return purpose === 'decomposition' ? t('notes.ai.purpose.decomposition') : t('notes.ai.purposeOther');
}

function sizeText(bytes: number): string {
  if (bytes < 1024) return t('notes.size.bytes', { value: formatNumber(bytes) });
  return t('notes.size.kb', { value: formatNumber(bytes / 1024, 1) });
}

function shortHash(hash: string): string {
  return hash.slice(0, 8);
}
</script>

<template>
  <section class="note-section note-ai-usage" :aria-labelledby="headingId" data-note-ai-usage>
    <header class="note-section-header">
      <h3 :id="headingId" class="note-section-title">{{ t('notes.ai.title') }}</h3>
    </header>
    <p class="muted">{{ t('notes.ai.lede') }}</p>
    <p v-if="documentId === null" class="muted">{{ t('notes.ai.saveFirst') }}</p>
    <div v-else-if="usageQuery.isLoading.value">
      <p class="visually-hidden" role="status">{{ t('notes.ai.loading') }}</p>
      <UiSkeleton variant="lines" :lines="2" />
    </div>
    <UiBanner v-else-if="usageQuery.isError.value" tone="error">
      <p role="alert">{{ t('notes.ai.loadError') }}</p>
      <template #actions>
        <UiButton size="sm" icon="sync" @click="usageQuery.refetch()">{{ t('common.retry') }}</UiButton>
      </template>
    </UiBanner>
    <p v-else-if="items.length === 0" class="muted" data-note-ai-empty>{{ t('notes.ai.empty') }}</p>
    <template v-else>
      <ol class="note-ai-list" :aria-label="t('notes.ai.listLabel')">
        <li v-for="item in items" :key="item.id" class="note-ai-item" :data-note-ai-item="item.status">
          <div class="note-ai-head">
            <span class="note-ai-purpose">{{ purposeLabel(item.purpose) }}</span>
            <UiBadge :tone="STATUS_TONES[item.status]" dot>{{ t(`notes.ai.status.${item.status}`) }}</UiBadge>
            <UiBadge v-if="item.stale" tone="warn" :title="t('notes.ai.staleHelp')">{{ t('notes.ai.stale') }}</UiBadge>
          </div>
          <!-- The plain account first: when, how much of this note was sent, and of which version. -->
          <p class="note-ai-meta tabular" data-note-ai-account>
            <time :datetime="item.createdAt">{{ formatDateTime(item.createdAt, timeZone) }}</time>
            <span>{{ tp('notes.ai.sections', item.sectionHashes.length) }}</span>
            <span>{{ t('notes.ai.bytes', { size: sizeText(item.sentBytes) }) }}</span>
            <span>{{ t('notes.ai.version', { version: item.documentVersion }) }}</span>
          </p>
          <p v-if="item.stale" class="field-help">{{ t('notes.ai.staleHelp') }}</p>
          <!-- The technical record (who ran it, which run, which sections by hash) is one press away. -->
          <details class="note-ai-details" data-note-ai-details>
            <summary class="note-ai-more">
              <UiIcon name="chevron-down" :size="14" class="note-ai-more-icon" />{{ t('notes.ai.details') }}
            </summary>
            <p class="note-ai-meta note-ai-meta--run muted">
              <span>{{ t('notes.ai.model', { provider: item.provider, model: item.model }) }}</span>
              <span class="tabular">{{ t('notes.ai.run', { id: item.agentRunId.slice(-8) }) }}</span>
            </p>
            <div class="note-ai-hashes">
              <span class="muted">{{ t('notes.ai.hashesLabel') }}</span>
              <ul class="chip-row">
                <li v-for="hash in item.sectionHashes" :key="hash" class="chip tabular" :data-section-hash="hash">
                  {{ t('notes.ai.section', { hash: shortHash(hash) }) }}
                </li>
              </ul>
            </div>
          </details>
        </li>
      </ol>
      <UiButton
        v-if="usageQuery.hasNextPage.value"
        size="sm"
        variant="ghost"
        :busy="usageQuery.isFetchingNextPage.value"
        :disabled="usageQuery.isFetchingNextPage.value"
        @click="usageQuery.fetchNextPage()"
      >
        {{ t('notes.ai.loadMore') }}
      </UiButton>
    </template>
  </section>
</template>
