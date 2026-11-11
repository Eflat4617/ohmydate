import { computed, nextTick, ref, shallowRef, watch } from 'vue';
import { defineStore } from 'pinia';
import {
  applyUserIntent,
  canUndo,
  pageItemOf,
  proposeLayout,
  stepLayout,
  undoLayout,
  type LayoutInput,
  type LayoutMode,
  type LayoutPreferences,
  type LayoutSpec,
  type LayoutState,
  type StepOutcome,
} from '@ohmydate/ui-policy';
import { t } from '../i18n';
import { layoutClock } from '../layout/clock';
import { readLayoutPrefs, writeLayoutPrefs } from '../layout/prefs';
import { useSessionStore } from './session';
import { useToastStore } from './toast';

/** The layout toast stays long enough to reach "되돌리기" comfortably. */
export const LAYOUT_TOAST_MS = 10_000;

export type InputSource = () => LayoutInput;

/**
 * Glue between the pure ui-policy state machine and the app: persisted
 * preferences, the undo toast and the polite announcement. The frame on the
 * screen attaches an input source; without one (tests that mount a single
 * view, or screens without the adaptive frame) the store stays passive.
 */
export const useLayoutStore = defineStore('layout', () => {
  const sessions = useSessionStore();
  const toast = useToastStore();

  const prefs = ref<LayoutPreferences>(readLayoutPrefs(sessions.ownerId));
  const machine = shallowRef<LayoutState | null>(null);
  const lastOutcome = shallowRef<StepOutcome | null>(null);
  const announcement = ref('');
  let source: InputSource | null = null;
  let toastId: string | null = null;
  // Set by an automatic switch or an undo: if focus ended up on <body> (the
  // toast button or the start button is gone), it must land in the layout.
  let focusRequest = false;

  const current = computed<LayoutSpec | null>(() => machine.value?.current ?? null);
  const undoAvailable = computed(() => machine.value !== null && canUndo(machine.value));
  const attached = ref(false);

  watch(
    () => sessions.ownerId,
    (owner, previous) => {
      if (owner === previous) return;
      prefs.value = readLayoutPrefs(owner);
      machine.value = null;
      dismissToast();
      if (source !== null) intent();
    },
  );

  function modeName(mode: LayoutMode): string {
    return t(`layout.mode.${mode}`);
  }

  function announce(text: string): void {
    // Clear first so the same sentence is announced again.
    announcement.value = '';
    void nextTick(() => {
      announcement.value = text;
    });
  }

  function dismissToast(): void {
    if (toastId !== null) toast.dismiss(toastId);
    toastId = null;
  }

  function setPrefs(next: LayoutPreferences): void {
    prefs.value = next;
    writeLayoutPrefs(sessions.ownerId, next);
  }

  function attach(next: InputSource): void {
    source = next;
    attached.value = true;
    intent();
  }

  function detach(previous: InputSource): void {
    if (source !== previous) return;
    source = null;
    attached.value = false;
  }

  /** The user navigated or acknowledged something: apply at once, quietly. */
  function intent(options: { announce?: boolean } = {}): boolean {
    if (source === null) return false;
    const result = applyUserIntent(machine.value, source());
    machine.value = result.state;
    lastOutcome.value = null;
    if (result.relock !== null) setPrefs({ ...prefs.value, locked: result.relock });
    if (result.changed) dismissToast();
    if (result.changed && options.announce === true) {
      announce(t('layout.announce.changed', { mode: modeName(result.state.current.mode) }));
    }
    return result.changed;
  }

  /** Re-evaluate after a context change the user did not ask for directly. */
  function step(): StepOutcome | null {
    if (source === null || machine.value === null) return null;
    const result = stepLayout(machine.value, source());
    if (result.state !== machine.value) machine.value = result.state;
    lastOutcome.value = result.outcome;
    if (result.outcome.kind === 'switched') onSwitched(result.outcome.to);
    return result.outcome;
  }

  function onSwitched(to: LayoutSpec): void {
    // If focus was lost (the control that triggered this is gone or disabled),
    // the frame puts it on the new primary region.
    focusRequest = true;
    announce(t('layout.announce.switched', { mode: modeName(to.mode) }));
    dismissToast();
    toastId = toast.show(t('layout.toast.changed'), {
      action: { label: t('layout.toast.undo'), handler: () => void undo() },
      secondaryAction: { label: t('layout.toast.disableAuto'), handler: disableAutoSwitch },
      duration: LAYOUT_TOAST_MS,
    });
  }

  function undo(): boolean {
    if (machine.value === null) return false;
    const result = undoLayout(machine.value, layoutClock().now());
    if (!result.undone) return false;
    machine.value = result.state;
    lastOutcome.value = null;
    focusRequest = true;
    dismissToast();
    announce(t('layout.announce.undone', { mode: modeName(result.state.current.mode) }));
    return true;
  }

  function setAutoSwitch(value: boolean): void {
    if (prefs.value.autoSwitch === value) return;
    setPrefs({ ...prefs.value, autoSwitch: value });
    announce(value ? t('layout.announce.autoOn') : t('layout.announce.autoOff'));
    if (value) step();
  }

  function disableAutoSwitch(): void {
    setAutoSwitch(false);
    toast.show(t('layout.toast.autoOff'));
  }

  function lockCurrent(): boolean {
    const spec = current.value;
    if (spec === null) return false;
    setPrefs({ ...prefs.value, locked: spec.mode });
    step();
    announce(t('layout.announce.locked', { mode: modeName(spec.mode) }));
    return true;
  }

  function unlock(): void {
    if (prefs.value.locked === null) return;
    setPrefs({ ...prefs.value, locked: null });
    announce(t('layout.announce.unlocked'));
    step();
  }

  /**
   * TodayView started a session. Returns true when the layout took over
   * (switched to this session's focus page); otherwise the caller navigates.
   */
  function sessionStarted(sessionId: string): boolean {
    if (source === null) return false;
    step();
    const page = current.value === null ? null : pageItemOf(current.value);
    return page?.component === 'FocusTimer' && page.props.sessionId === sessionId;
  }

  function consumeFocusRequest(): boolean {
    const requested = focusRequest;
    focusRequest = false;
    return requested;
  }

  /** Apply an externally supplied spec only if it validates (07 §2.1). */
  function propose(candidate: unknown): boolean {
    if (machine.value === null) return false;
    const result = proposeLayout(machine.value, candidate);
    machine.value = result.state;
    return result.accepted;
  }

  return {
    prefs,
    machine,
    current,
    lastOutcome,
    announcement,
    undoAvailable,
    attached,
    modeName,
    attach,
    detach,
    intent,
    step,
    undo,
    setAutoSwitch,
    disableAutoSwitch,
    lockCurrent,
    unlock,
    sessionStarted,
    propose,
    consumeFocusRequest,
  };
});
