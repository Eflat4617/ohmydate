<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, provide, ref, shallowRef, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import {
  LAYOUT_REGIONS,
  isPageComponent,
  validateLayoutSpec,
  type LayoutInput,
  type LayoutItem,
  type LayoutSpec,
  type PanelComponentId,
} from '@ohmydate/ui-policy';
import { t } from '../../i18n';
import { layoutClock } from '../../layout/clock';
import { refreshLayoutNow, useLayoutNow } from '../../layout/now';
import { LAYOUT_CONTEXT } from '../../layout/context';
import { captureFocus, restoreFocus } from '../../layout/focusKeeper';
import { createInteractionTracker } from '../../layout/interaction';
import { useContextObserver } from '../../layout/observer';
import { PANEL_REGISTRY } from '../../layout/registry';
import { PLANNING_ROUTES, routeKindOf, workspacePathFor } from '../../layout/routes';
import { captureOwnerBinding, isOwnerBindingCurrent } from '../../session/ownerEpoch';
import { useLayoutStore } from '../../stores/layout';

/**
 * Renderer (07 §2): lays the LayoutSpec's regions out on a CSS grid with
 * stable keys. The routed page is the spec's page component and comes in
 * through the default slot; every other item must be in the panel registry.
 * NavRail / BottomNav stay in AppShell and are always rendered.
 */
// While a switch waits for the user, check this often whether they paused
// (removing a focused field fires no focus event, so events alone miss it).
const IDLE_POLL_MS = 500;

const route = useRoute();
const router = useRouter();
const layout = useLayoutStore();
// Shared reactive clock: the same tick drives Next up, the review window and the day.
const now = useLayoutNow();
const observer = useContextObserver(now);
provide(LAYOUT_CONTEXT, observer);

const frameEl = ref<HTMLElement | null>(null);
const tracker = createInteractionTracker(onInteractionChange);
const displayed = shallowRef<LayoutSpec | null>(null);
let expectedPath: string | null = null;
let applying = 0;
let holdTimer: ReturnType<typeof setTimeout> | null = null;
let idleTimer: ReturnType<typeof setTimeout> | null = null;

function input(): LayoutInput {
  return {
    now: refreshLayoutNow(),
    signals: observer.signals.value,
    prefs: layout.prefs,
    interaction: tracker.snapshot(frameEl.value),
  };
}

function valid(spec: LayoutSpec | null): LayoutSpec | null {
  if (spec === null) return null;
  return validateLayoutSpec(spec).ok ? spec : null;
}

// Attach during setup so the first render already has a layout: the routed
// page then mounts once, in its final place.
layout.attach(input);
displayed.value = valid(layout.current);
// Today's data that was still loading when the user navigated belongs to
// that navigation: when it arrives it applies quietly, without a toast.
let awaitingFirstData = observer.today.value === null;

async function apply(spec: LayoutSpec | null): Promise<void> {
  // Any newer call (also a reset to null after an owner change) cancels an
  // older one that is still waiting for its navigation.
  const run = ++applying;
  // 07 §2.1: an invalid spec is never rendered; the previous layout stays.
  const next = valid(spec);
  if (next === null) return;
  // ADR-023: a continuation that resumes after a user switch shows nothing.
  const owner = captureOwnerBinding();
  const snapshot = captureFocus(frameEl.value);
  const target = workspacePathFor(next, routeKindOf(route));
  if (target !== null && target !== route.path) {
    expectedPath = target;
    try {
      await router.replace(target);
    } catch {
      expectedPath = null;
    }
    if (run !== applying || !isOwnerBindingCurrent(owner)) return;
  }
  displayed.value = next;
  await nextTick();
  if (run !== applying || !isOwnerBindingCurrent(owner)) return;
  const restored = restoreFocus(snapshot, frameEl.value);
  const lost = document.activeElement === null || document.activeElement === document.body;
  if (layout.consumeFocusRequest() && restored === null && lost) {
    frameEl.value?.querySelector<HTMLElement>('[data-layout-region="primary"]')?.focus({ preventScroll: true });
  }
}

watch(
  () => layout.current,
  (spec) => void apply(spec),
);

// A route change is the user's own navigation unless the frame caused it.
watch(
  () => route.fullPath,
  () => {
    if (expectedPath !== null && route.path === expectedPath) {
      expectedPath = null;
      layout.step();
      return;
    }
    expectedPath = null;
    awaitingFirstData = observer.today.value === null;
    layout.intent();
  },
);

// Registered before the context watcher so a first load wins the same flush.
watch(
  () => observer.today.value !== null,
  (loaded) => {
    if (!loaded || !awaitingFirstData) return;
    awaitingFirstData = false;
    layout.intent();
  },
);

// Everything else the observer sees is a context change: re-evaluate.
const contextKey = computed(() => {
  const s = observer.signals.value;
  return [s.activeSessionId, s.riskTaskCount, s.riskAcknowledged, s.inReviewWindow, s.unreviewedSessionCount, s.day].join('|');
});
watch(contextKey, () => {
  if (awaitingFirstData && observer.today.value !== null) {
    awaitingFirstData = false;
    layout.intent();
    return;
  }
  layout.step();
});

function clearTimer(timer: ReturnType<typeof setTimeout> | null): null {
  if (timer !== null) clearTimeout(timer);
  return null;
}

watch(
  () => layout.lastOutcome,
  (outcome) => {
    holdTimer = clearTimer(holdTimer);
    idleTimer = clearTimer(idleTimer);
    // `page`: only the user's own navigation ends it, and that is an intent.
    if (outcome?.kind !== 'deferred' || outcome.because === 'page') return;
    if (outcome.because === 'hold' && outcome.retryAt !== null) {
      const wait = Math.max(0, outcome.retryAt - layoutClock().now());
      holdTimer = setTimeout(() => layout.step(), wait + 50);
    } else {
      // Typing / dragging / working in a panel: try again once they pause.
      idleTimer = setTimeout(retryWhenIdle, IDLE_POLL_MS);
    }
  },
);

function retryWhenIdle(): void {
  idleTimer = null;
  const interaction = tracker.snapshot(frameEl.value);
  const idle = !interaction.typing && !interaction.dragging && interaction.activeComponents.length === 0;
  if (idle) layout.step();
  else idleTimer = setTimeout(retryWhenIdle, IDLE_POLL_MS);
}

function onInteractionChange(): void {
  if (layout.machine?.pending !== null && layout.machine?.pending !== undefined) {
    void nextTick(() => layout.step());
  }
}

onMounted(() => {
  tracker.start();
  void apply(layout.current);
});

onBeforeUnmount(() => {
  tracker.stop();
  layout.detach(input);
  holdTimer = clearTimer(holdTimer);
  idleTimer = clearTimer(idleTimer);
});

const spec = computed(() => displayed.value);
// Planning and notes pages own wide grids (plan candidates; the notes list
// beside the editor), so their context panels go below the page.
const variant = computed(() =>
  typeof route.name === 'string' && (PLANNING_ROUTES.has(route.name) || routeKindOf(route) === 'notes')
    ? 'stacked'
    : 'columns',
);
const frameClasses = computed(() => {
  const current = spec.value;
  return [
    `adaptive-frame--${variant.value}`,
    current === null ? null : `adaptive-frame--mode-${current.mode}`,
    current !== null && current.regions.secondary.length === 0 ? 'adaptive-frame--no-secondary' : null,
    current !== null && current.regions.tertiary.length === 0 ? 'adaptive-frame--no-tertiary' : null,
  ];
});

/** The page keeps one key whatever it is, so it is never remounted by a switch. */
function itemKey(item: LayoutItem): string {
  return isPageComponent(item.component) ? 'page' : item.component;
}

function panelFor(item: LayoutItem) {
  return PANEL_REGISTRY[item.component as PanelComponentId];
}

function propsOf(item: LayoutItem): Record<string, unknown> {
  return 'props' in item && item.props !== undefined ? { ...item.props } : {};
}
</script>

<template>
  <div
    ref="frameEl"
    class="adaptive-frame"
    :class="frameClasses"
    :data-layout-mode="spec?.mode"
    :data-layout-reason="spec?.reason"
    :data-layout-pinned="spec?.pinned.join(' ')"
    :data-policy-version="spec?.policyVersion"
  >
    <p class="visually-hidden" role="status" aria-live="polite" aria-atomic="true" data-layout-announcer>
      {{ layout.announcement }}
    </p>
    <template v-if="spec">
      <template v-for="region in LAYOUT_REGIONS" :key="region">
        <div
          v-if="region === 'primary' || spec.regions[region].length > 0"
          class="adaptive-region"
          :class="`adaptive-region--${region}`"
          :data-layout-region="region"
          role="region"
          :aria-label="t(`layout.region.${region}`)"
          :tabindex="region === 'primary' ? -1 : undefined"
        >
          <div
            v-for="item in spec.regions[region]"
            :key="itemKey(item)"
            class="adaptive-item"
            :class="`adaptive-item--${item.component}`"
            :data-layout-item="item.component"
          >
            <slot v-if="isPageComponent(item.component)" />
            <component :is="panelFor(item)" v-else-if="panelFor(item)" v-bind="propsOf(item)" />
          </div>
        </div>
      </template>
    </template>
    <div
      v-else
      class="adaptive-region adaptive-region--primary"
      data-layout-region="primary"
      role="region"
      :aria-label="t('layout.region.primary')"
      tabindex="-1"
    >
      <div class="adaptive-item" data-layout-item="page"><slot /></div>
    </div>
  </div>
</template>
