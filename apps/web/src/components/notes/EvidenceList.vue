<script setup lang="ts">
import { computed, useId } from 'vue';
import { useQueries } from '@tanstack/vue-query';
import { plannerClient, type ContextDocument, type DecompositionEvidence, type DecompositionStep } from '../../api';
import { keyOwner, noteKeys, ownerFenced, retryFenced, useOwnerKey } from '../../composables/notes';
import { t } from '../../i18n';
import { browserTimeZone, formatDateTime } from '../../i18n/format';
import { useAuthStore } from '../../stores/auth';
import UiBadge from '../ui/UiBadge.vue';
import UiIcon from '../ui/UiIcon.vue';

/**
 * Note evidence of a decomposition draft (05 §9/§10): what the model relied
 * on, as `fact` (the note says so) or `inference` (derived), with the source
 * note, the section, and the note's update time when it was sent. References
 * the server could not match were already removed. The statement is quoted
 * note material: it is shown as plain text and never acted on.
 */
const props = defineProps<{ evidence: readonly DecompositionEvidence[]; steps: readonly DecompositionStep[] }>();

const uid = useId();
const owner = useOwnerKey();
const auth = useAuthStore();
const timeZone = computed(() => auth.user?.timeZone ?? browserTimeZone());
const docIds = computed(() => [...new Set(props.evidence.map((item) => item.source.docId))]);

const noteQueries = useQueries({
  queries: computed(() =>
    docIds.value.map((id) => ({
      queryKey: noteKeys.doc(owner.value, id),
      queryFn: ({ queryKey }: { queryKey: readonly unknown[] }) =>
        ownerFenced(keyOwner(queryKey), (binding) => plannerClient.getDocument(id, binding.signal)),
      retry: retryFenced(1),
      refetchOnWindowFocus: false,
    })),
  ),
});

interface NoteState {
  readonly note: ContextDocument | null;
  readonly loading: boolean;
}

const notes = computed(() => {
  const map = new Map<string, NoteState>();
  docIds.value.forEach((id, index) => {
    const query = noteQueries.value[index];
    map.set(id, { note: query?.data ?? null, loading: query?.isLoading ?? true });
  });
  return map;
});

const stepTitles = computed(() => new Map(props.steps.map((step) => [step.key, step.title] as const)));

function noteOf(item: DecompositionEvidence): NoteState {
  return notes.value.get(item.source.docId) ?? { note: null, loading: true };
}

function changedSince(item: DecompositionEvidence): boolean {
  const note = noteOf(item).note;
  return note !== null && Date.parse(note.updatedAt) > Date.parse(item.updatedAt);
}

function stepLabel(key: string): string {
  const title = stepTitles.value.get(key);
  return title === undefined ? key : `${key} · ${title}`;
}
</script>

<template>
  <section class="wizard-evidence" :aria-labelledby="`${uid}-title`" data-wizard-evidence>
    <h3 :id="`${uid}-title`" class="wizard-evidence-title">{{ t('notes.evidence.title') }}</h3>
    <p class="muted">{{ t('notes.evidence.lede') }}</p>
    <p class="field-help">{{ t('notes.evidence.legend') }}</p>
    <p v-if="evidence.length === 0" class="muted" data-evidence-none>{{ t('notes.evidence.none') }}</p>
    <ol v-else class="evidence-list" :aria-label="t('notes.evidence.listLabel')">
      <li
        v-for="(item, index) in evidence"
        :key="`${item.source.docId}:${item.source.sectionHash}:${index}`"
        class="evidence-item"
        :class="`evidence-item--${item.kind}`"
        :data-evidence-kind="item.kind"
      >
        <div class="evidence-head">
          <UiBadge :tone="item.kind === 'fact' ? 'success' : 'info'" size="lg" data-evidence-badge>
            <UiIcon :name="item.kind === 'fact' ? 'check-circle' : 'ai'" :size="14" />
            {{ t(`notes.evidence.kind.${item.kind}`) }}
          </UiBadge>
          <span class="muted evidence-kind-help">{{ t(`notes.evidence.kindHelp.${item.kind}`) }}</span>
        </div>
        <blockquote class="evidence-statement" :aria-label="t('notes.evidence.statement')" data-evidence-statement>
          {{ item.statement }}
        </blockquote>
        <dl class="kv-list evidence-source">
          <div>
            <dt>{{ t('notes.evidence.source') }}</dt>
            <dd data-evidence-source>
              <span v-if="noteOf(item).loading" class="muted">{{ t('notes.evidence.noteLoading') }}</span>
              <span v-else-if="noteOf(item).note === null" class="muted">{{ t('notes.evidence.noteMissing') }}</span>
              <strong v-else class="evidence-note-title">{{ noteOf(item).note?.title }}</strong>
              <span class="chip tabular evidence-section">{{ t('notes.evidence.section', { hash: item.source.sectionHash.slice(0, 8) }) }}</span>
            </dd>
          </div>
          <div>
            <dt>{{ t('notes.evidence.noteTimeLabel') }}</dt>
            <dd class="tabular">
              <time :datetime="item.updatedAt">{{ formatDateTime(item.updatedAt, timeZone) }}</time>
              <UiBadge v-if="changedSince(item)" tone="warn" class="evidence-changed">{{ t('notes.evidence.noteChanged') }}</UiBadge>
            </dd>
          </div>
          <div>
            <dt>{{ t('notes.evidence.steps') }}</dt>
            <dd>
              <ul v-if="item.stepKeys.length > 0" class="chip-row">
                <li v-for="key in item.stepKeys" :key="key" class="chip">{{ stepLabel(key) }}</li>
              </ul>
              <span v-else class="muted">{{ t('notes.evidence.stepsNone') }}</span>
            </dd>
          </div>
        </dl>
        <RouterLink
          v-if="noteOf(item).note !== null"
          :to="`/notes/${item.source.docId}`"
          class="btn btn--ghost btn--sm evidence-open"
          :aria-label="t('notes.evidence.openNoteAria', { title: noteOf(item).note?.title ?? '' })"
          data-evidence-open
        >
          <UiIcon name="note" :size="16" /><span>{{ t('notes.evidence.openNote') }}</span>
        </RouterLink>
      </li>
    </ol>
  </section>
</template>
