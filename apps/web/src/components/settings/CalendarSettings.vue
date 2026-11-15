<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useQueryClient } from '@tanstack/vue-query';
import {
  ActionStore,
  ApiError,
  isStoredFinalResult,
  plannerClient,
  type GoogleIntegration,
  type GoogleIntegrationStatus,
  type GoogleSyncErrorCode,
  type GoogleSyncResult,
} from '../../api';
import {
  GOOGLE_CALLBACK_PATH,
  GOOGLE_SETUP,
  draftFrom,
  googleCallbackResult,
  isAllowedAuthorizationUrl,
  isReadOnlyCalendar,
  localWebOrigin,
  openedOnLocalhost,
  reminderChoices,
  reminderFromOptionValue,
  reminderOptionValue,
  sameDraft,
  settingsPutBody,
  type GoogleCallbackResult,
  type GoogleSettingsDraft,
  type GoogleSettingsValues,
} from '../../domain/googleIntegration';
import {
  CALENDAR_DAY_EVENTS_QUERY,
  GOOGLE_INTEGRATION_QUERY,
  navigateTopLevel,
  useGoogleIntegration,
} from '../../composables/useGoogleCalendar';
import { useOwnerTimeZone } from '../../composables/usePlannerRange';
import { useOfflineStore } from '../../stores/offline';
import UiBadge from '../ui/UiBadge.vue';
import UiBanner from '../ui/UiBanner.vue';
import UiButton from '../ui/UiButton.vue';
import UiDialog from '../ui/UiDialog.vue';
import UiField from '../ui/UiField.vue';
import UiIcon from '../ui/UiIcon.vue';
import UiSkeleton from '../ui/UiSkeleton.vue';
import { t } from '../../i18n';
import { formatDateTime } from '../../i18n/format';
import { errorMessage } from '../../i18n/problem';
import { ownerKeyOf, runOwnerBound, type OwnerScope, type OwnerSteps } from '../../session/ownerBound';

/**
 * CAL-04 — 캘린더 연동: the settings page of the Google Calendar integration
 * (CAL-03 server, ADR-024, 08 §2.11). One state per `status`:
 * - not_configured: what connecting does and the one-time setup on the laptop
 *   (no button that cannot work);
 * - disconnected: what is read and what is sent, then 구글 계정 연결;
 * - connected: last sync, 지금 동기화, the calendars to import, what to send
 *   to the phone, 연결 끊기;
 * - needs_reauth: one line that sign-in expired, 다시 연결; nothing else lost.
 * Every write is owner-bound and carries an Idempotency-Key; the settings PUT
 * and the disconnect carry If-Match (412 → re-read, as on 가용 시간).
 */
const offline = useOfflineStore();
const queryClient = useQueryClient();
const route = useRoute();
const router = useRouter();
const actions = new ActionStore();
const { timeZone } = useOwnerTimeZone();

const integrationQuery = useGoogleIntegration();
const integration = computed<GoogleIntegration | null>(() => integrationQuery.data.value ?? null);
const status = computed<GoogleIntegrationStatus | null>(() => integration.value?.status ?? null);
const loading = computed(() => integration.value === null && integrationQuery.isLoading.value);
const loadFailed = computed(() => integration.value === null && integrationQuery.isError.value);

const EXPORT_CALENDAR = 'OhMyDate';
const exportName = computed(() => integration.value?.exportCalendarName ?? EXPORT_CALENDAR);

const browserLocation = typeof location === 'undefined' ? null : location;
const webOrigin = localWebOrigin(browserLocation);
const redirectUri = `${webOrigin}${GOOGLE_CALLBACK_PATH}`;
const onLocalhost = openedOnLocalhost(browserLocation);
const appOrigin = browserLocation?.origin ?? '';

const message = ref('');
const error = ref<string | null>(null);
const heading = ref<HTMLElement | null>(null);

// ── Coming back from Google: ?google=connected|denied|error, shown once ────
const returned = ref<GoogleCallbackResult | null>(null);
const returnedTone = computed<'success' | 'warn' | 'error'>(() =>
  returned.value === 'connected' ? 'success' : returned.value === 'denied' ? 'warn' : 'error',
);
const returnedText = computed(() => {
  if (returned.value === 'connected') return t('googleCalendar.returned.connected');
  if (returned.value === 'denied') return t('googleCalendar.returned.denied');
  return t('googleCalendar.returned.error', { origin: webOrigin });
});

watch(
  () => route.query['google'],
  (value) => {
    if (value === undefined) return;
    const result = googleCallbackResult(value);
    if (result !== null) returned.value = result;
    const rest = { ...route.query };
    delete rest['google'];
    void router.replace({ path: route.path, query: rest, hash: route.hash });
  },
  { immediate: true },
);

// ── The settings draft (calendars to import, what to send) ────────────────
const draft = ref<GoogleSettingsDraft | null>(null);
/** The connection version the draft was taken from (If-Match). */
const draftVersion = ref<number | null>(null);
const dirty = ref(false);

watch(
  integration,
  (value) => {
    if (value === null) return;
    if (draft.value === null || !dirty.value) {
      draft.value = draftFrom(value);
      draftVersion.value = value.version;
      dirty.value = false;
    }
  },
  { immediate: true },
);

const canEdit = computed(() => offline.mutationsEnabled);
const reminderOptions = computed(() => reminderChoices(draft.value?.settings.reminderMinutes ?? null));

function reminderLabel(minutes: number | null): string {
  if (minutes === null) return t('googleCalendar.export.reminderNone');
  if (minutes === 0) return t('googleCalendar.export.reminderAtStart');
  return t('googleCalendar.export.reminderBefore', { minutes });
}

function updateDraft(next: GoogleSettingsDraft): void {
  draft.value = next;
  const server = integration.value;
  dirty.value = server === null ? true : !sameDraft(next, draftFrom(server)) || draftVersion.value !== server.version;
  error.value = null;
}

function toggleCalendar(id: string, checked: boolean): void {
  const current = draft.value;
  if (current === null || !canEdit.value) return;
  const selected = current.selected.filter((item) => item !== id);
  if (checked) selected.push(id);
  updateDraft({ ...current, selected });
}

function setSetting<K extends keyof GoogleSettingsValues>(key: K, value: GoogleSettingsValues[K]): void {
  const current = draft.value;
  if (current === null || !canEdit.value) return;
  updateDraft({ ...current, settings: { ...current.settings, [key]: value } });
}

function onSwitch(key: 'exportBlocks' | 'exportCommitments' | 'dailySummary', event: Event): void {
  if (event.target instanceof HTMLInputElement) setSetting(key, event.target.checked);
}

function onCalendarChange(id: string, event: Event): void {
  if (event.target instanceof HTMLInputElement) toggleCalendar(id, event.target.checked);
}

function onReminderChange(event: Event): void {
  if (event.target instanceof HTMLSelectElement) setSetting('reminderMinutes', reminderFromOptionValue(event.target.value));
}

// ── Reading and refreshing ────────────────────────────────────────────────
function cacheKey(owner: OwnerScope): unknown[] {
  return [GOOGLE_INTEGRATION_QUERY, ownerKeyOf(owner.ownerId)];
}

/** Re-read the connection under this owner (after a refusal or a change elsewhere). */
function* rereadSteps(owner: OwnerScope): OwnerSteps<GoogleIntegration> {
  const fresh = yield* owner.wait(plannerClient.getGoogleIntegration({ fresh: true }));
  queryClient.setQueryData(cacheKey(owner), fresh);
  return fresh;
}

/** What an import or a disconnect changed elsewhere: 약속, the month, Today's agenda, day labels. */
function* refreshImportedSteps(): OwnerSteps<void> {
  yield queryClient.invalidateQueries({ queryKey: ['commitments'] });
  yield queryClient.invalidateQueries({ queryKey: ['planner-range'] });
  yield queryClient.invalidateQueries({ queryKey: ['day-agenda'] });
  yield queryClient.invalidateQueries({ queryKey: [CALENDAR_DAY_EVENTS_QUERY] });
  yield queryClient.invalidateQueries({ queryKey: ['availability'] });
}

const checking = ref(false);
const checkNote = ref('');

async function checkAgain(): Promise<void> {
  checking.value = true;
  error.value = null;
  message.value = '';
  checkNote.value = '';
  await runOwnerBound(
    function* (owner) {
      const fresh = yield* rereadSteps(owner);
      if (fresh.status === 'not_configured') checkNote.value = t('googleCalendar.setup.stillNotConfigured');
    },
    {
      onError: (cause) => {
        error.value = errorMessage(cause, t('googleCalendar.loadError'));
      },
      onSettled: () => {
        checking.value = false;
      },
    },
  );
}

function retryLoad(): void {
  void integrationQuery.refetch();
}

// ── Connect (and reconnect): POST :connect → top-level navigation ────────
const connecting = ref(false);

async function connect(): Promise<void> {
  if (!offline.mutationsEnabled || connecting.value) return;
  connecting.value = true;
  error.value = null;
  message.value = '';
  const scope = 'google:connect';
  const action = actions.begin(scope, {}, () => true);
  await runOwnerBound(function* (owner) {
    try {
      const answer = yield* owner.wait(plannerClient.connectGoogleIntegration(action.key));
      actions.settle(scope, action);
      if (!isAllowedAuthorizationUrl(answer.authorizationUrl, appOrigin)) {
        connecting.value = false;
        error.value = t('googleCalendar.connectRefused');
        return;
      }
      // The page is leaving for Google's consent screen; keep the button busy.
      message.value = t('googleCalendar.connecting');
      navigateTopLevel(answer.authorizationUrl);
    } catch (cause) {
      if (isStoredFinalResult(cause)) actions.settle(scope, action);
      connecting.value = false;
      if (cause instanceof ApiError && cause.status === 409) {
        yield* rereadSteps(owner);
        error.value = t('googleCalendar.changed');
        return;
      }
      error.value = errorMessage(cause, t('googleCalendar.connectError'));
    }
  });
}

/** Coming back with the browser's back button restores this page as it was: busy. */
function onPageShow(event: PageTransitionEvent): void {
  if (event.persisted) connecting.value = false;
}

onMounted(() => window.addEventListener('pageshow', onPageShow));
onBeforeUnmount(() => window.removeEventListener('pageshow', onPageShow));

// ── Sync now ──────────────────────────────────────────────────────────────
const syncing = ref(false);
const syncResult = ref('');

function syncSentence(result: GoogleSyncResult): string {
  return t('googleCalendar.sync.result', {
    importedCreated: result.imported.created,
    importedUpdated: result.imported.updated,
    importedRemoved: result.imported.removed,
    dayEvents: result.imported.dayEvents,
    exportedCreated: result.exported.created,
    exportedUpdated: result.exported.updated,
    exportedRemoved: result.exported.removed,
  });
}

async function syncNow(): Promise<void> {
  if (!offline.mutationsEnabled || syncing.value) return;
  syncing.value = true;
  error.value = null;
  message.value = '';
  syncResult.value = '';
  const scope = 'google:sync';
  const action = actions.begin(scope, {}, () => true);
  await runOwnerBound(
    function* (owner) {
      try {
        const result = yield* owner.wait(plannerClient.syncGoogleIntegration(action.key));
        actions.settle(scope, action);
        syncResult.value = syncSentence(result);
        yield* rereadSteps(owner);
        yield* refreshImportedSteps();
      } catch (cause) {
        if (isStoredFinalResult(cause)) actions.settle(scope, action);
        if (cause instanceof ApiError && cause.status === 503) {
          error.value = t('googleCalendar.sync.unavailable');
          yield* rereadSteps(owner);
          return;
        }
        if (cause instanceof ApiError && cause.status === 409) {
          const fresh = yield* rereadSteps(owner);
          error.value = fresh.status === 'needs_reauth' ? t('googleCalendar.sync.reauth') : t('googleCalendar.changed');
          return;
        }
        error.value = errorMessage(cause, t('googleCalendar.sync.error'));
      }
    },
    {
      onSettled: () => {
        syncing.value = false;
      },
    },
  );
}

const lastSyncLine = computed(() => {
  const at = integration.value?.lastSyncAt ?? null;
  if (at === null) return t('googleCalendar.sync.never');
  return t('googleCalendar.sync.last', { when: formatDateTime(at, timeZone.value) });
});

function lastErrorText(code: GoogleSyncErrorCode | null): string {
  if (code === null) return t('googleCalendar.sync.ok');
  const known = (Object.keys(ERROR_CODES) as string[]).includes(code);
  return known ? t(`googleCalendar.lastError.${code}`) : t('googleCalendar.lastErrorUnknown');
}

const ERROR_CODES: Record<GoogleSyncErrorCode, true> = {
  auth_revoked: true,
  rate_limited: true,
  google_unavailable: true,
  google_rejected: true,
  too_many_events: true,
  run_deadline: true,
  internal_error: true,
};

const lastResultLine = computed(() => lastErrorText(integration.value?.lastError ?? null));

// ── Save the settings: PUT with If-Match; 412 → re-read and choose ────────
const saving = ref(false);
const conflict = ref<{ server: GoogleIntegration; local: GoogleSettingsDraft } | null>(null);
const conflictHeading = ref<HTMLElement | null>(null);

const canSave = computed(
  () => offline.mutationsEnabled && draft.value !== null && dirty.value && !saving.value && integration.value !== null,
);

async function save(): Promise<void> {
  const server = integration.value;
  const local = draft.value;
  if (server === null || local === null || !canSave.value) return;
  saving.value = true;
  error.value = null;
  message.value = '';
  const payload = settingsPutBody(local, server.calendars);
  const version = draftVersion.value ?? server.version;
  const scope = 'google:settings';
  const action = actions.begin(scope, payload, (left, right) => JSON.stringify(left) === JSON.stringify(right), version);
  await runOwnerBound(
    function* (owner) {
      try {
        const updated = yield* owner.wait(plannerClient.putGoogleIntegrationSettings(payload, action.key, version));
        actions.settle(scope, action);
        queryClient.setQueryData(cacheKey(owner), updated);
        draft.value = draftFrom(updated);
        draftVersion.value = updated.version;
        dirty.value = false;
        message.value = t('googleCalendar.saved');
      } catch (cause) {
        if (isStoredFinalResult(cause)) actions.settle(scope, action);
        if (cause instanceof ApiError && cause.status === 412) {
          const fresh = yield* rereadSteps(owner);
          conflict.value = { server: fresh, local: draft.value ?? local };
          yield* owner.wait(nextTick());
          conflictHeading.value?.focus();
          return;
        }
        if (cause instanceof ApiError && cause.status === 409) {
          yield* rereadSteps(owner);
          error.value = t('googleCalendar.changed');
          return;
        }
        error.value = errorMessage(cause, t('googleCalendar.saveError'));
      }
    },
    {
      onSettled: () => {
        saving.value = false;
      },
    },
  );
}

function keepLocal(): void {
  if (conflict.value === null) return;
  const { server, local } = conflict.value;
  conflict.value = null;
  draft.value = local;
  draftVersion.value = server.version;
  dirty.value = true;
  message.value = t('googleCalendar.conflict.keptLocal');
  void nextTick().then(() => document.getElementById('google-settings-save')?.focus());
}

function useServer(): void {
  if (conflict.value === null) return;
  const { server } = conflict.value;
  conflict.value = null;
  draft.value = draftFrom(server);
  draftVersion.value = server.version;
  dirty.value = false;
  message.value = t('googleCalendar.conflict.usedServer');
}

// ── Disconnect: confirm, then DELETE with If-Match ────────────────────────
const disconnectOpen = ref(false);
const removeExported = ref(true);
const disconnecting = ref(false);

function openDisconnect(): void {
  removeExported.value = true;
  disconnectOpen.value = true;
}

function closeDisconnect(): void {
  if (!disconnecting.value) disconnectOpen.value = false;
}

async function disconnect(): Promise<void> {
  const server = integration.value;
  if (server === null || !offline.mutationsEnabled || disconnecting.value) return;
  disconnecting.value = true;
  error.value = null;
  message.value = '';
  const remove = removeExported.value;
  const name = exportName.value;
  const scope = 'google:disconnect';
  const action = actions.begin(scope, { remove }, (left, right) => left.remove === right.remove, server.version);
  await runOwnerBound(
    function* (owner) {
      try {
        yield* owner.wait(plannerClient.disconnectGoogleIntegration(remove, action.key, server.version));
        actions.settle(scope, action);
        disconnectOpen.value = false;
        dirty.value = false;
        draft.value = null;
        message.value = remove ? t('googleCalendar.disconnect.done') : t('googleCalendar.disconnect.doneKept', { name });
        yield* rereadSteps(owner);
        yield* refreshImportedSteps();
        heading.value?.focus();
      } catch (cause) {
        if (isStoredFinalResult(cause)) actions.settle(scope, action);
        disconnectOpen.value = false;
        if (cause instanceof ApiError && (cause.status === 412 || cause.status === 409)) {
          yield* rereadSteps(owner);
          error.value = t('googleCalendar.changed');
          return;
        }
        error.value = errorMessage(cause, t('googleCalendar.disconnect.error'));
      }
    },
    {
      onSettled: () => {
        disconnecting.value = false;
      },
    },
  );
}

const statusTone = computed<'success' | 'warn' | 'neutral'>(() => {
  switch (status.value) {
    case 'connected':
      return 'success';
    case 'needs_reauth':
      return 'warn';
    default:
      return 'neutral';
  }
});

const SETUP = GOOGLE_SETUP;
</script>

<template>
  <section class="settings-section calendar-settings" aria-labelledby="calendar-settings-title" data-settings-calendar>
    <header class="settings-section-head">
      <div class="page-heading">
        <h2 id="calendar-settings-title" ref="heading" class="settings-section-title" tabindex="-1">{{ t('googleCalendar.title') }}</h2>
        <p class="page-lede">{{ t('googleCalendar.lede') }}</p>
      </div>
    </header>

    <UiBanner v-if="!offline.mutationsEnabled" tone="offline" class="offline-note" role="status">
      {{ t('googleCalendar.offline') }}
    </UiBanner>
    <UiBanner
      v-if="returned"
      :tone="returnedTone"
      :role="returned === 'error' ? 'alert' : 'status'"
      class="google-returned"
      :data-google-returned="returned"
    >
      {{ returnedText }}
    </UiBanner>
    <p class="status-region status-note" role="status" aria-live="polite">{{ message }}</p>
    <UiBanner v-if="error" tone="error" role="alert" data-google-error>{{ error }}</UiBanner>

    <div v-if="loading">
      <p class="visually-hidden" role="status">{{ t('googleCalendar.loading') }}</p>
      <UiSkeleton variant="card" :count="2" :lines="3" />
    </div>
    <UiBanner v-else-if="loadFailed" tone="error" class="error-panel">
      <p class="error-text" role="alert">{{ t('googleCalendar.loadError') }}</p>
      <template #actions>
        <UiButton size="sm" icon="sync" data-google-retry @click="retryLoad">{{ t('common.retry') }}</UiButton>
      </template>
    </UiBanner>

    <div v-else-if="integration && status" class="google-body" :data-google-status="status">
      <p class="google-status-line">
        <span class="google-status-label">{{ t('googleCalendar.statusLabel') }}</span>
        <UiBadge :tone="statusTone">{{ t(`googleCalendar.status.${status}`) }}</UiBadge>
      </p>

      <!-- ── not_configured: what it does, and the one-time setup ───────── -->
      <template v-if="status === 'not_configured'">
        <section class="card settings-card settings-group google-section" aria-labelledby="google-intro-title">
          <h3 id="google-intro-title" class="card-title">{{ t('googleCalendar.intro.heading') }}</h3>
          <ul class="google-points">
            <li>{{ t('googleCalendar.intro.toPhone') }}</li>
            <li>{{ t('googleCalendar.intro.fromPhone') }}</li>
            <li>{{ t('googleCalendar.intro.allDay') }}</li>
          </ul>
        </section>

        <section class="card settings-card settings-group google-section" aria-labelledby="google-setup-title" data-google-setup>
          <h3 id="google-setup-title" class="card-title">{{ t('googleCalendar.setup.heading') }}</h3>
          <p>{{ t('googleCalendar.setup.lede') }}</p>
          <p class="google-guide">
            <span class="muted">{{ t('googleCalendar.setup.guide') }}</span>
            <code class="google-code-inline">{{ SETUP.guidePath }}</code>
          </p>
          <ol class="google-steps" :aria-label="t('googleCalendar.setup.steps')">
            <li>
              <p>{{ t('googleCalendar.setup.step1') }}</p>
              <code class="google-code-inline">{{ SETUP.consoleUrl }}</code>
            </li>
            <li>
              <p>{{ t('googleCalendar.setup.step2') }}</p>
              <pre class="google-code"><code>{{ SETUP.scopes.join('\n') }}</code></pre>
            </li>
            <li>
              <p>{{ t('googleCalendar.setup.step3') }}</p>
              <pre class="google-code" data-google-redirect-uri><code>{{ redirectUri }}</code></pre>
            </li>
            <li>
              <p>{{ t('googleCalendar.setup.step4') }}</p>
              <pre class="google-code" data-google-client-file><code>{{ SETUP.placeCommands.join('\n') }}</code></pre>
            </li>
            <li>
              <p>{{ t('googleCalendar.setup.step5') }}</p>
              <pre class="google-code" data-google-restart><code>{{ SETUP.restartCommands.join('\n') }}</code></pre>
            </li>
            <li>
              <p>{{ t('googleCalendar.setup.step6', { origin: webOrigin }) }}</p>
            </li>
          </ol>
          <div class="settings-actions">
            <UiButton icon="sync" :busy="checking" :disabled="checking" data-google-check @click="checkAgain">
              {{ t('googleCalendar.setup.checkAgain') }}
            </UiButton>
          </div>
          <p class="google-check-note" role="status" aria-live="polite" data-google-check-note>{{ checkNote }}</p>
        </section>
      </template>

      <!-- ── disconnected: what goes where, then connect ────────────────── -->
      <template v-else-if="status === 'disconnected'">
        <section class="card settings-card settings-group google-section" aria-labelledby="google-plan-title">
          <h3 id="google-plan-title" class="card-title">{{ t('googleCalendar.plan.heading') }}</h3>
          <dl class="kv-list google-plan">
            <dt>{{ t('googleCalendar.plan.readLabel') }}</dt>
            <dd>{{ t('googleCalendar.plan.read') }}</dd>
            <dt>{{ t('googleCalendar.plan.sendLabel') }}</dt>
            <dd>{{ t('googleCalendar.plan.send', { name: exportName }) }}</dd>
            <dt>{{ t('googleCalendar.plan.keepLabel') }}</dt>
            <dd>{{ t('googleCalendar.plan.keep') }}</dd>
          </dl>
          <p class="muted">{{ t('googleCalendar.plan.consentHint') }}</p>
          <UiBanner v-if="onLocalhost" tone="warn" data-google-localhost>
            {{ t('googleCalendar.localhost', { origin: webOrigin }) }}
          </UiBanner>
          <div class="settings-actions">
            <UiButton
              variant="primary"
              icon="link"
              :busy="connecting"
              :disabled="!offline.mutationsEnabled || connecting"
              data-google-connect
              @click="connect"
            >
              {{ t('googleCalendar.connect') }}
            </UiButton>
          </div>
        </section>
      </template>

      <!-- ── connected / needs_reauth ───────────────────────────────────── -->
      <template v-else>
        <UiBanner v-if="status === 'needs_reauth'" tone="warn" class="google-reauth" data-google-reauth>
          <p class="google-reauth-line">{{ t('googleCalendar.reauth.line') }}</p>
          <p class="google-reauth-hint">{{ t('googleCalendar.reauth.hint') }}</p>
          <template #actions>
            <UiButton
              variant="primary"
              icon="link"
              :busy="connecting"
              :disabled="!offline.mutationsEnabled || connecting"
              data-google-reconnect
              @click="connect"
            >
              {{ t('googleCalendar.reconnect') }}
            </UiButton>
          </template>
        </UiBanner>
        <UiBanner v-if="onLocalhost && status === 'needs_reauth'" tone="warn" data-google-localhost>
          {{ t('googleCalendar.localhost', { origin: webOrigin }) }}
        </UiBanner>

        <section class="card settings-card settings-group google-section" aria-labelledby="google-sync-title" data-google-sync>
          <h3 id="google-sync-title" class="card-title">{{ t('googleCalendar.sync.heading') }}</h3>
          <p class="settings-current google-last-sync tabular" data-google-last-sync>
            {{ lastSyncLine }}
            <!-- needs_reauth: the banner above already says why syncing stopped. -->
            <span
              v-if="status === 'connected'"
              class="google-last-result"
              :class="{ 'google-last-result--problem': integration.lastError !== null }"
            >
              {{ lastResultLine }}
            </span>
          </p>
          <p v-if="status === 'connected'" class="muted">{{ t('googleCalendar.sync.auto') }}</p>
          <template v-if="status === 'connected'">
            <UiBanner v-if="!integration.importAvailable" tone="warn" data-google-scope="import">
              {{ t('googleCalendar.scopes.importOff') }}
              <template #actions>
                <UiButton size="sm" icon="link" :disabled="!offline.mutationsEnabled || connecting" @click="connect">
                  {{ t('googleCalendar.reconnect') }}
                </UiButton>
              </template>
            </UiBanner>
            <UiBanner v-if="!integration.exportAvailable" tone="warn" data-google-scope="export">
              {{ t('googleCalendar.scopes.exportOff') }}
              <template v-if="integration.importAvailable" #actions>
                <UiButton size="sm" icon="link" :disabled="!offline.mutationsEnabled || connecting" @click="connect">
                  {{ t('googleCalendar.reconnect') }}
                </UiButton>
              </template>
            </UiBanner>
            <p v-if="integration.exportAvailable" class="muted">{{ t('googleCalendar.phoneHint', { name: exportName }) }}</p>
            <div class="settings-actions">
              <UiButton
                icon="sync"
                :busy="syncing"
                :disabled="!offline.mutationsEnabled || syncing"
                data-google-sync-now
                @click="syncNow"
              >
                {{ syncing ? t('googleCalendar.sync.running') : t('googleCalendar.sync.now') }}
              </UiButton>
            </div>
            <p class="google-sync-result" role="status" aria-live="polite" data-google-sync-result>{{ syncResult }}</p>
          </template>
        </section>

        <form v-if="draft" class="settings-form google-settings-form" @submit.prevent="save">
          <fieldset class="card settings-card settings-group google-section" data-google-calendars>
            <legend class="card-title">{{ t('googleCalendar.calendars.legend') }}</legend>
            <p class="muted">{{ t('googleCalendar.calendars.lede') }}</p>
            <p v-if="integration.calendars.length === 0" class="google-empty">{{ t('googleCalendar.calendars.empty') }}</p>
            <ul v-else class="google-calendars">
              <li v-for="calendar in integration.calendars" :key="calendar.id" class="google-calendar">
                <label class="google-calendar-label">
                  <input
                    type="checkbox"
                    :checked="draft.selected.includes(calendar.id)"
                    :disabled="!canEdit"
                    :data-google-calendar="calendar.id"
                    @change="onCalendarChange(calendar.id, $event)"
                  />
                  <span class="google-calendar-name">{{ calendar.name }}</span>
                  <span v-if="calendar.primary" class="google-calendar-tag">
                    <span class="visually-hidden">, </span>{{ t('googleCalendar.calendars.primary') }}
                  </span>
                  <span v-if="isReadOnlyCalendar(calendar.accessRole)" class="google-calendar-tag google-calendar-tag--muted">
                    <span class="visually-hidden">, </span>{{ t('googleCalendar.calendars.readOnly') }}
                  </span>
                </label>
              </li>
            </ul>
          </fieldset>

          <fieldset class="card settings-card settings-group google-section" data-google-export>
            <legend class="card-title">{{ t('googleCalendar.export.legend') }}</legend>
            <p class="muted">{{ t('googleCalendar.export.lede', { name: exportName }) }}</p>
            <div class="google-switches">
              <div class="google-switch">
                <label class="switch-row">
                  <input
                    type="checkbox"
                    role="switch"
                    class="switch"
                    :checked="draft.settings.exportBlocks"
                    :disabled="!canEdit"
                    aria-describedby="google-export-blocks-help"
                    data-google-setting="exportBlocks"
                    @change="onSwitch('exportBlocks', $event)"
                  />
                  <span>{{ t('googleCalendar.export.blocks') }}</span>
                </label>
                <p id="google-export-blocks-help" class="muted">{{ t('googleCalendar.export.blocksHelp') }}</p>
              </div>
              <div class="google-switch">
                <label class="switch-row">
                  <input
                    type="checkbox"
                    role="switch"
                    class="switch"
                    :checked="draft.settings.exportCommitments"
                    :disabled="!canEdit"
                    aria-describedby="google-export-commitments-help"
                    data-google-setting="exportCommitments"
                    @change="onSwitch('exportCommitments', $event)"
                  />
                  <span>{{ t('googleCalendar.export.commitments') }}</span>
                </label>
                <p id="google-export-commitments-help" class="muted">{{ t('googleCalendar.export.commitmentsHelp') }}</p>
              </div>
              <div class="google-switch">
                <label class="switch-row">
                  <input
                    type="checkbox"
                    role="switch"
                    class="switch"
                    :checked="draft.settings.dailySummary"
                    :disabled="!canEdit"
                    aria-describedby="google-daily-help"
                    data-google-setting="dailySummary"
                    @change="onSwitch('dailySummary', $event)"
                  />
                  <span>{{ t('googleCalendar.export.daily') }}</span>
                </label>
                <p id="google-daily-help" class="muted">{{ t('googleCalendar.export.dailyHelp') }}</p>
              </div>
            </div>
            <UiField
              id="google-reminder"
              :label="t('googleCalendar.export.reminder')"
              :help="t('googleCalendar.export.reminderHelp')"
              class="field--narrow"
            >
              <template #default="{ describedby }">
                <select
                  id="google-reminder"
                  :value="reminderOptionValue(draft.settings.reminderMinutes)"
                  :disabled="!canEdit"
                  :aria-describedby="describedby"
                  data-google-setting="reminderMinutes"
                  @change="onReminderChange"
                >
                  <option v-for="minutes in reminderOptions" :key="reminderOptionValue(minutes)" :value="reminderOptionValue(minutes)">
                    {{ reminderLabel(minutes) }}
                  </option>
                </select>
              </template>
            </UiField>
          </fieldset>

          <div class="form-actions">
            <UiButton
              id="google-settings-save"
              type="submit"
              :variant="status === 'connected' ? 'primary' : 'secondary'"
              :busy="saving"
              :disabled="!canSave"
              data-google-save
            >
              {{ saving ? t('common.saving') : t('googleCalendar.save') }}
            </UiButton>
            <UiBadge :tone="dirty ? 'warn' : 'success'">
              {{ dirty ? t('googleCalendar.stateUnsaved') : t('googleCalendar.stateSaved') }}
            </UiBadge>
          </div>
        </form>

        <section class="card settings-card settings-group google-section google-disconnect" aria-labelledby="google-disconnect-title">
          <h3 id="google-disconnect-title" class="card-title">{{ t('googleCalendar.disconnect.heading') }}</h3>
          <p class="muted">{{ t('googleCalendar.disconnect.lede') }}</p>
          <div class="settings-actions">
            <UiButton
              variant="danger-ghost"
              icon="close"
              :disabled="!offline.mutationsEnabled"
              data-google-disconnect
              @click="openDisconnect"
            >
              {{ t('googleCalendar.disconnect.open') }}
            </UiButton>
          </div>
        </section>
      </template>
    </div>

    <UiDialog
      v-if="disconnectOpen"
      role="alertdialog"
      labelledby="google-disconnect-dialog-title"
      describedby="google-disconnect-dialog-body"
      size="sm"
      :dismissible="!disconnecting"
      @close="closeDisconnect"
    >
      <header class="dialog-header dialog-header--start">
        <span class="dialog-icon dialog-icon--warn"><UiIcon name="warn" :size="22" /></span>
        <div class="dialog-heading">
          <h2 id="google-disconnect-dialog-title" class="dialog-title">{{ t('googleCalendar.disconnect.title') }}</h2>
        </div>
      </header>
      <div id="google-disconnect-dialog-body" class="google-disconnect-body">
        <p>{{ t('googleCalendar.disconnect.imported') }}</p>
        <p>{{ t('googleCalendar.disconnect.settings') }}</p>
      </div>
      <div class="google-disconnect-choice">
        <label class="check-row">
          <input
            v-model="removeExported"
            type="checkbox"
            :disabled="disconnecting"
            aria-describedby="google-remove-exported-help"
            data-google-remove-exported
          />
          <span>{{ t('googleCalendar.disconnect.removeExported', { name: exportName }) }}</span>
        </label>
        <p id="google-remove-exported-help" class="muted">{{ t('googleCalendar.disconnect.removeExportedHelp') }}</p>
      </div>
      <div class="dialog-actions">
        <UiButton variant="ghost" data-autofocus :disabled="disconnecting" @click="closeDisconnect">
          {{ t('common.cancel') }}
        </UiButton>
        <UiButton
          variant="danger"
          :busy="disconnecting"
          :disabled="disconnecting || !offline.mutationsEnabled"
          data-google-disconnect-confirm
          @click="disconnect"
        >
          {{ t('googleCalendar.disconnect.confirm') }}
        </UiButton>
      </div>
    </UiDialog>

    <UiDialog
      v-if="conflict"
      role="alertdialog"
      labelledby="google-conflict-title"
      close-on-backdrop
      @close="conflict = null"
    >
      <header class="dialog-header dialog-header--start">
        <span class="dialog-icon dialog-icon--warn"><UiIcon name="sync" :size="22" /></span>
        <div class="dialog-heading">
          <h2 id="google-conflict-title" ref="conflictHeading" class="dialog-title" tabindex="-1">
            {{ t('googleCalendar.conflict.title') }}
          </h2>
          <p class="muted">{{ t('googleCalendar.conflict.body') }}</p>
        </div>
      </header>
      <div class="dialog-actions dialog-actions--start">
        <UiButton variant="primary" :disabled="!offline.mutationsEnabled" data-google-keep-local @click="keepLocal">
          {{ t('googleCalendar.conflict.keepLocal') }}
        </UiButton>
        <UiButton data-google-use-server @click="useServer">{{ t('googleCalendar.conflict.useServer') }}</UiButton>
        <UiButton variant="ghost" @click="conflict = null">{{ t('googleCalendar.conflict.keepEditing') }}</UiButton>
      </div>
    </UiDialog>
  </section>
</template>
