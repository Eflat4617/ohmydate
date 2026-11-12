<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { onBeforeRouteLeave, onBeforeRouteUpdate, useRoute, useRouter } from 'vue-router';
import { useInfiniteQuery } from '@tanstack/vue-query';
import { plannerClient, type ContextDocument, type ContextDocumentPage } from '../api';
import NoteConfirmDialog from '../components/notes/NoteConfirmDialog.vue';
import NoteEditor from '../components/notes/NoteEditor.vue';
import { noteSummary } from '../components/notes/summary';
import UiBadge from '../components/ui/UiBadge.vue';
import UiBanner from '../components/ui/UiBanner.vue';
import UiButton from '../components/ui/UiButton.vue';
import UiEmptyState from '../components/ui/UiEmptyState.vue';
import UiIcon from '../components/ui/UiIcon.vue';
import UiSkeleton from '../components/ui/UiSkeleton.vue';
import { NOTE_PAGE_SIZE, keyOwner, noteKeys, ownerFenced, parsePresetLink, retryFenced, useOwnerKey } from '../composables/notes';
import { useMediaQuery } from '../composables/useMediaQuery';
import { t, tp } from '../i18n';
import { browserTimeZone, formatDateTime } from '../i18n/format';
import { useAuthStore } from '../stores/auth';
import { useOfflineStore } from '../stores/offline';
import { runOwnerBound, type OwnerSteps } from '../session/ownerBound';
import { useToastStore } from '../stores/toast';

/**
 * Notes workspace (07 §3.5, page component `NotesWorkspace`): a searchable,
 * paged list beside the editor on desktop; on mobile the list and the editor
 * are separate steps. `/notes`, `/notes/new` and `/notes/:id` share this one
 * view instance, so picking another note never reloads the list.
 */
const SEARCH_DEBOUNCE_MS = 300;

const route = useRoute();
const router = useRouter();
const owner = useOwnerKey();
const offline = useOfflineStore();
const auth = useAuthStore();
const toast = useToastStore();
const desktop = useMediaQuery('(min-width: 1024px)');
const timeZone = computed(() => auth.user?.timeZone ?? browserTimeZone());

const searchInput = ref('');
const q = ref('');
const searchEl = ref<HTMLInputElement | null>(null);
let searchTimer: ReturnType<typeof setTimeout> | null = null;

watch(searchInput, (value) => {
  if (searchTimer !== null) clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    searchTimer = null;
    q.value = value.trim();
  }, SEARCH_DEBOUNCE_MS);
});
onBeforeUnmount(() => {
  if (searchTimer !== null) clearTimeout(searchTimer);
});

function submitSearch(): void {
  if (searchTimer !== null) clearTimeout(searchTimer);
  searchTimer = null;
  q.value = searchInput.value.trim();
}

function clearSearch(): void {
  if (searchTimer !== null) clearTimeout(searchTimer);
  searchTimer = null;
  searchInput.value = '';
  q.value = '';
  searchEl.value?.focus();
}

/** The API accepts 1–200 characters; longer input is cut, not rejected. */
const serverQ = computed(() => Array.from(q.value).slice(0, 200).join(''));

const listQuery = useInfiniteQuery({
  queryKey: computed(() => noteKeys.list(owner.value, serverQ.value)),
  // Each page is one owner-fenced request for the key's owner (M6-03R-1 H1).
  queryFn: ({ pageParam, queryKey }: { pageParam: string | null; queryKey: readonly unknown[] }) =>
    ownerFenced(keyOwner(queryKey), (binding) =>
      plannerClient.listDocuments({
        ...(serverQ.value.length > 0 ? { q: serverQ.value } : {}),
        limit: NOTE_PAGE_SIZE,
        ...(pageParam === null ? {} : { cursor: pageParam }),
        signal: binding.signal,
      }),
    ),
  initialPageParam: null as string | null,
  getNextPageParam: (last: ContextDocumentPage) => last.nextCursor,
  // One quiet retry, then the error state with its own retry button.
  retry: retryFenced(1),
});

const notes = computed<ContextDocument[]>(() => (listQuery.data.value?.pages ?? []).flatMap((page) => page.items));
const firstLoad = computed(() => listQuery.isLoading.value && listQuery.data.value === undefined);
const listFailed = computed(() => listQuery.isError.value && listQuery.data.value === undefined);
const moreFailed = computed(() => listQuery.isFetchNextPageError.value);
const searchStatus = computed(() => {
  if (serverQ.value.length === 0 || listQuery.data.value === undefined) return '';
  return listQuery.hasNextPage.value
    ? t('notes.search.statusMore', { q: serverQ.value })
    : tp('notes.search.status', notes.value.length, { q: serverQ.value });
});

// ── Selection (route) ─────────────────────────────────────────────────
const selectedId = computed(() => {
  if (route.name !== 'notes-detail') return null;
  const value = route.params['id'];
  const id = Array.isArray(value) ? value[0] : value;
  return typeof id === 'string' && id.length > 0 ? id : null;
});
const creating = computed(() => route.name === 'notes-new');
const presetLink = computed(() => (creating.value ? parsePresetLink(route.query['link']) : null));
const hasSelection = computed(() => creating.value || selectedId.value !== null);

let newNonce = 0;
/** A note just created keeps its editor instance when the URL gains its id. */
let adoptCreatedId: string | null = null;
function keyFor(): string {
  if (creating.value) {
    newNonce += 1;
    return `new:${newNonce}`;
  }
  return selectedId.value === null ? 'none' : `doc:${selectedId.value}`;
}
const editorKey = ref(keyFor());
watch(
  () => [route.name, selectedId.value, route.query['link']] as const,
  () => {
    if (route.name === 'notes-detail' && adoptCreatedId !== null && adoptCreatedId === selectedId.value) {
      adoptCreatedId = null;
      return;
    }
    adoptCreatedId = null;
    editorKey.value = keyFor();
    void focusAfterSelection();
  },
);

const editorRef = ref<InstanceType<typeof NoteEditor> | null>(null);
const editorPane = ref<HTMLElement | null>(null);

async function focusAfterSelection(): Promise<void> {
  await nextTick();
  if (creating.value) {
    editorRef.value?.focusTitle();
    return;
  }
  // On mobile the list is gone once a note opens: move focus into the editor.
  if (!desktop.value && selectedId.value !== null) {
    await nextTick();
    editorPane.value?.querySelector<HTMLElement>('h2, [data-note-not-found]')?.focus();
  }
}

onMounted(() => {
  if (creating.value) void focusAfterSelection();
});

// ── Unsaved changes guard ─────────────────────────────────────────────
const leavePrompt = ref<((leave: boolean) => void) | null>(null);
let internalNavigation = false;

function confirmLeave(): Promise<boolean> | boolean {
  if (editorRef.value?.isDirty() !== true) return true;
  return new Promise<boolean>((resolve) => {
    leavePrompt.value = resolve;
  });
}

function answerLeave(leave: boolean): void {
  const resolve = leavePrompt.value;
  leavePrompt.value = null;
  resolve?.(leave);
}

onBeforeRouteUpdate((to, from) => {
  if (internalNavigation) {
    internalNavigation = false;
    return true;
  }
  if (to.path === from.path) return true;
  return confirmLeave();
});
onBeforeRouteLeave(() => {
  if (internalNavigation) {
    internalNavigation = false;
    return true;
  }
  return confirmLeave();
});

/** A navigation this screen makes itself (no "unsaved changes" question), as steps of an owner-bound task. */
function* navigateSteps(path: string, replace = false): OwnerSteps<void> {
  internalNavigation = true;
  try {
    yield replace ? router.replace(path) : router.push(path);
  } finally {
    internalNavigation = false;
  }
}

async function navigateInternally(path: string, replace = false): Promise<void> {
  await runOwnerBound(() => navigateSteps(path, replace));
}

function onCreated(note: ContextDocument): void {
  adoptCreatedId = note.id;
  void navigateInternally(`/notes/${note.id}`, true);
}

function onCopied(note: ContextDocument): void {
  toast.show(t('notes.conflict.copied'));
  void navigateInternally(`/notes/${note.id}`);
}

// Runs for the owner who deleted the note (the editor emits `deleted` from its
// own owner-bound task); the focus move after the navigation is fenced too.
async function onDeleted(): Promise<void> {
  await runOwnerBound(function* (owner) {
    toast.show(t('notes.editor.deleted'));
    yield* navigateSteps('/notes');
    yield* owner.wait(nextTick());
    searchEl.value?.focus();
  });
}

function summaryOf(note: ContextDocument): string {
  return noteSummary(note.title, note.bodyMd, 90);
}
</script>

<template>
  <section class="page page--wide notes-page" aria-labelledby="notes-title" data-notes-page>
    <header class="page-header">
      <div class="page-heading">
        <h1 id="notes-title">{{ t('notes.title') }}</h1>
        <p class="page-lede">{{ t('notes.lede') }}</p>
      </div>
      <div class="page-actions">
        <UiBadge v-if="!offline.mutationsEnabled" tone="offline" dot class="chip--offline" role="status">
          {{ t('common.readOnlyOffline') }}
        </UiBadge>
        <RouterLink to="/notes/new" class="btn btn--primary" data-note-new>
          <UiIcon name="plus" :size="18" />
          <span>{{ t('notes.newNote') }}</span>
        </RouterLink>
      </div>
    </header>

    <UiBanner v-if="!offline.mutationsEnabled" tone="offline">{{ t('notes.offline') }}</UiBanner>

    <div class="notes-layout" :class="{ 'notes-layout--detail': hasSelection }">
      <section class="notes-list-pane" aria-labelledby="notes-list-title" data-notes-list>
        <h2 id="notes-list-title" class="notes-pane-title">{{ t('notes.listTitle') }}</h2>
        <form class="notes-search" role="search" @submit.prevent="submitSearch">
          <label for="notes-search" class="field-label">{{ t('notes.search.label') }}</label>
          <div class="notes-search-row">
            <input
              id="notes-search"
              ref="searchEl"
              v-model="searchInput"
              type="search"
              maxlength="200"
              autocomplete="off"
              :placeholder="t('notes.search.placeholder')"
              aria-describedby="notes-search-help"
              data-notes-search
            />
            <UiButton type="submit" icon="search" :aria-label="t('notes.search.submit')" icon-only />
          </div>
          <p id="notes-search-help" class="field-help">{{ t('notes.search.help') }}</p>
        </form>
        <p class="visually-hidden" role="status" aria-live="polite" data-notes-search-status>{{ searchStatus }}</p>

        <div v-if="firstLoad">
          <p class="visually-hidden" role="status">{{ t('notes.loading') }}</p>
          <UiSkeleton variant="card" :count="3" :lines="2" />
        </div>
        <UiBanner v-else-if="listFailed" tone="error" class="error-panel">
          <p class="error-text" role="alert">{{ t('notes.loadError') }}</p>
          <template #actions>
            <UiButton size="sm" icon="sync" @click="listQuery.refetch()">{{ t('common.retry') }}</UiButton>
          </template>
        </UiBanner>
        <UiEmptyState
          v-else-if="notes.length === 0 && serverQ.length > 0"
          icon="search"
          :title="t('notes.noResultsTitle', { q: serverQ })"
          compact
          data-notes-no-results
        >
          <p>{{ t('notes.noResultsBody') }}</p>
          <template #actions>
            <UiButton size="sm" @click="clearSearch">{{ t('notes.search.clear') }}</UiButton>
          </template>
        </UiEmptyState>
        <UiEmptyState v-else-if="notes.length === 0" icon="note" :title="t('notes.emptyTitle')" compact data-notes-empty>
          <p>{{ t('notes.emptyBody') }}</p>
        </UiEmptyState>
        <template v-else>
          <ul class="note-list" :aria-label="t('notes.listLabel')">
            <li v-for="note in notes" :key="note.id" class="note-list-row">
              <RouterLink
                :to="`/notes/${note.id}`"
                class="note-list-item"
                :class="{ 'note-list-item--active': note.id === selectedId }"
                :aria-current="note.id === selectedId ? 'page' : undefined"
                :data-note-item="note.id"
              >
                <span class="note-list-title">{{ note.title }}</span>
                <span v-if="summaryOf(note)" class="note-list-summary">{{ summaryOf(note) }}</span>
                <span class="note-list-meta">
                  <time :datetime="note.updatedAt" class="tabular">{{ t('notes.updated', { time: formatDateTime(note.updatedAt, timeZone) }) }}</time>
                  <UiBadge v-if="note.llmAllowed" tone="accent">{{ t('notes.badges.aiAllowed') }}</UiBadge>
                  <UiBadge v-if="note.sensitivity === 'P1'" tone="warn">{{ t('notes.badges.sensitive') }}</UiBadge>
                  <UiBadge v-if="note.source === 'task_description'" tone="outline">{{ t('notes.badges.promoted') }}</UiBadge>
                  <UiBadge v-if="note.links.length > 0" tone="neutral">{{ tp('notes.badges.links', note.links.length) }}</UiBadge>
                </span>
              </RouterLink>
            </li>
          </ul>
          <UiBanner v-if="moreFailed" tone="error" role="alert">{{ t('notes.loadMoreError') }}</UiBanner>
          <UiButton
            v-if="listQuery.hasNextPage.value"
            variant="ghost"
            block
            :busy="listQuery.isFetchingNextPage.value"
            :disabled="listQuery.isFetchingNextPage.value"
            data-notes-more
            @click="listQuery.fetchNextPage()"
          >
            {{ listQuery.isFetchingNextPage.value ? t('notes.loadingMore') : t('notes.loadMore') }}
          </UiButton>
        </template>
      </section>

      <div ref="editorPane" class="notes-detail-pane" data-notes-detail>
        <RouterLink v-if="hasSelection" to="/notes" class="notes-back">
          <UiIcon name="arrow-left" :size="16" />{{ t('notes.backToList') }}
        </RouterLink>
        <NoteEditor
          v-if="hasSelection"
          :key="editorKey"
          ref="editorRef"
          :note-id="selectedId"
          :preset-link="presetLink"
          @created="onCreated"
          @copied="onCopied"
          @deleted="onDeleted"
        />
        <UiEmptyState v-else icon="note" :title="t('notes.selectTitle')" class="notes-select-empty">
          <p>{{ t('notes.selectBody') }}</p>
        </UiEmptyState>
      </div>
    </div>

    <NoteConfirmDialog
      v-if="leavePrompt"
      :title="t('notes.leaveDialog.title')"
      :body="t('notes.leaveDialog.body')"
      :confirm-label="t('notes.leaveDialog.leave')"
      :cancel-label="t('notes.leaveDialog.stay')"
      :danger="false"
      @confirm="answerLeave(true)"
      @cancel="answerLeave(false)"
    />
  </section>
</template>
