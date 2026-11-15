import { computed, ref, watch } from 'vue';
import { defineStore } from 'pinia';
import { captureOwnerBinding } from '../session/ownerEpoch';
import { ownerSlot } from '../session/ownerStorage';
import { useAuthStore } from './auth';

const DISMISSED = '1';

/**
 * When the AI consent dialog (LlmConsentDialog, mounted by AppShell) opens (FU-91).
 *
 * - On its own while consent is not granted, at most once per browser session
 *   and owner: closing it without granting is remembered in the owner's
 *   session slot (session/ownerStorage.ts `llmConsentPrompt`), so a reload does
 *   not reopen it. The slot is cleared on any owner change, so a new sign-in
 *   asks again.
 * - When the user starts an AI action while consent is undecided (no record:
 *   the dialog was only dismissed, never answered), `askBeforeAi()` opens it
 *   even after a dismissal and resolves once it closes, so the request goes out
 *   with the user's answer. An explicit "직접 작성 모드" answer is not asked again.
 * - 설정 › AI always shows the same disclosure and the enable button; this
 *   store does not gate it.
 * - `ask()` opens it because the owner pressed "여기서 AI 켜기" somewhere (HOLO-04).
 */
export const useLlmConsentStore = defineStore('llmConsent', () => {
  const auth = useAuthStore();
  const slot = ownerSlot('llmConsentPrompt');
  /** Browser storage is not reactive: bumped on every write so `dismissed` re-reads. */
  const revision = ref(0);
  /** The owner whose dismissal could not be stored (private mode); same page only. */
  const dismissedInMemory = ref<string | null>(null);
  const requested = ref(false);
  const hosts = ref(0);
  let waiters: Array<() => void> = [];

  const needed = computed(
    () => auth.user?.llmProvider === 'deepseek' && auth.user.llm?.consent?.granted !== true,
  );
  const undecided = computed(() => needed.value && auth.user?.llm?.consent === undefined);
  const dismissed = computed(() => {
    void revision.value;
    const owner = auth.ownerId;
    if (owner === null) return false;
    return dismissedInMemory.value === owner || slot.read(owner) === DISMISSED;
  });
  const open = computed(() => needed.value && (requested.value || !dismissed.value));

  function settle(): void {
    requested.value = false;
    const pending = waiters;
    waiters = [];
    for (const resolve of pending) resolve();
  }

  /** The dialog closed without consent being granted (or right after it was granted). */
  function closed(): void {
    const binding = captureOwnerBinding();
    if (binding.ownerId !== null && slot.write(binding, DISMISSED) !== 'ok') {
      dismissedInMemory.value = binding.ownerId;
    }
    revision.value += 1;
    settle();
  }

  /**
   * Before an AI action: open the dialog if consent is undecided and wait until
   * it closes. Resolves at once when there is nothing to ask or no dialog host
   * is mounted, and on an owner change (the caller re-checks its binding).
   */
  function askBeforeAi(): Promise<void> {
    if (!undecided.value || hosts.value === 0) return Promise.resolve();
    requested.value = true;
    return new Promise((resolve) => {
      waiters.push(resolve);
    });
  }

  /**
   * HOLO-04 (FLOW.md §1): the owner asked for AI where they are — a "여기서 AI
   * 켜기" beside something the AI would do — whatever was answered before (also
   * after 직접 작성 모드). The same dialog opens in place, with the same
   * disclosure; nobody is sent to 설정 to become ready. Resolves once it closes
   * (granted or not), at once when there is nothing to grant or no host.
   */
  function ask(): Promise<void> {
    if (!needed.value || hosts.value === 0) return Promise.resolve();
    requested.value = true;
    return new Promise((resolve) => {
      waiters.push(resolve);
    });
  }

  /** AppShell renders the dialog; returns the detach function for unmount. */
  function attachHost(): () => void {
    hosts.value += 1;
    let attached = true;
    return () => {
      if (!attached) return;
      attached = false;
      hosts.value -= 1;
      if (hosts.value === 0) settle();
    };
  }

  // Granted (here or in AI 설정): nothing left to ask.
  watch(needed, (value) => {
    if (!value) settle();
  });

  // A new owner starts with nothing requested; their own slot answers `dismissed`.
  watch(
    () => auth.ownerId,
    () => {
      dismissedInMemory.value = null;
      revision.value += 1;
      settle();
    },
  );

  return { open, needed, undecided, dismissed, requested, closed, askBeforeAi, ask, attachHost };
});
