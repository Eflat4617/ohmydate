import { ref } from 'vue';
import { defineStore } from 'pinia';
import { ApiError, plannerClient, type User } from '../api';
import { uuidV7Key } from '../api/idempotency';
import {
  adoptActiveOwner,
  captureOwnerBinding,
  clearOwnerResetPending,
  invalidateOwnerEpoch,
  isOwnerBindingCurrent,
  isOwnerResetPending,
  onActiveOwnerChange,
  ownerChanged,
  ownerState,
} from '../session/ownerEpoch';
import { sessionJournal } from '../session/journal';
import { t } from '../i18n';
import { apiErrorMessage, UserFacingError } from '../i18n/problem';

export type AuthBootstrapState = 'pending' | 'ready' | 'anonymous' | 'error';

/**
 * How long a focus/visibility identity revalidation may hold its answer (FU-56).
 * A hanging `/me` must not leave the tab believing the next focus check is
 * still in flight: the wait is bounded and the confirmed owner is kept.
 */
export const IDENTITY_REVALIDATION_TIMEOUT_MS = 10_000;

/** Why a revalidation that started from a confirmed session ended badly. */
export type IdentityRevalidationState = 'idle' | 'pending' | 'failed';

export interface LoadCurrentOptions {
  /** Abort the `/me` confirmation after this many milliseconds. */
  readonly timeoutMs?: number;
}

function ownerChangedError(): Error {
  return new UserFacingError(t('errors.ownerChanged'));
}

function loginErrorMessage(cause: unknown): string {
  if (cause instanceof ApiError) {
    if (cause.status === 401 || cause.code === 'unauthenticated') return t('login.invalidCredentials');
    return apiErrorMessage(cause);
  }
  if (cause instanceof UserFacingError) return cause.message;
  if (cause instanceof TypeError) return t('errors.network');
  return t('login.failed');
}

function combinedSignal(first: AbortSignal, second: AbortSignal): AbortSignal {
  if (typeof AbortSignal.any === 'function') return AbortSignal.any([first, second]);
  const controller = new AbortController();
  for (const signal of [first, second]) {
    if (signal.aborted) {
      controller.abort(signal.reason);
      break;
    }
    signal.addEventListener('abort', () => controller.abort(signal.reason), { once: true });
  }
  return controller.signal;
}

/** Bound a confirmation request without ending the owner's session (FU-56). */
function boundedSignal(
  ownerSignal: AbortSignal,
  timeoutMs: number,
): { signal: AbortSignal; dispose: () => void } {
  const timeout = new AbortController();
  const timer = setTimeout(() => {
    timeout.abort(new DOMException('identity revalidation timed out', 'TimeoutError'));
  }, timeoutMs);
  (timer as unknown as { unref?: () => void }).unref?.();
  return {
    signal: combinedSignal(ownerSignal, timeout.signal),
    dispose: () => {
      clearTimeout(timer);
    },
  };
}

export const useAuthStore = defineStore('auth', () => {
  const ownerId = ownerState.ownerId;
  const epoch = ownerState.epoch;
  const resetPending = ownerState.resetPending;
  const user = ref<User | null>(null);
  const confirmed = ref(false);
  const bootstrapState = ref<AuthBootstrapState>('pending');
  const revalidationState = ref<IdentityRevalidationState>('idle');
  const loading = ref(false);
  const error = ref<string | null>(null);
  let bootstrapPromise: Promise<User | null> | null = null;

  onActiveOwnerChange(() => {
    user.value = null;
    confirmed.value = false;
    bootstrapState.value = 'pending';
    revalidationState.value = 'idle';
    error.value = null;
  });

  function confirmOwner(current: User): void {
    user.value = current;
    confirmed.value = true;
    bootstrapState.value = 'ready';
    clearOwnerResetPending();
    sessionJournal.setOwner(current.id);
  }

  async function loadCurrent(options: LoadCurrentOptions = {}): Promise<User | null> {
    const binding = captureOwnerBinding();
    const wasConfirmed = confirmed.value;
    bootstrapState.value = 'pending';
    if (wasConfirmed) revalidationState.value = 'pending';
    const bounded =
      options.timeoutMs === undefined ? null : boundedSignal(binding.signal, options.timeoutMs);
    try {
      const current = await plannerClient.getMe(bounded?.signal ?? binding.signal);
      if (!isOwnerBindingCurrent(binding)) return null;
      const stored = ownerState.ownerId.value;
      if (stored !== null && stored !== current.id) {
        ownerChanged(stored, current.id, 'me-mismatch');
        confirmOwner(current);
        revalidationState.value = 'idle';
        return current;
      }
      if (stored === null) adoptActiveOwner(current.id, 'bootstrap');
      confirmOwner(current);
      revalidationState.value = 'idle';
      return current;
    } catch (cause) {
      if (!isOwnerBindingCurrent(binding)) return null;
      const unauthenticated =
        cause instanceof ApiError && (cause.status === 401 || cause.status === 403);
      if (wasConfirmed && !unauthenticated) {
        // A network error, a timeout or a 5xx from the identity check is not an
        // owner change: keep the confirmed owner and its data, and surface a
        // retry notice instead of wiping the screen (FU-56).
        bootstrapState.value = 'ready';
        revalidationState.value = 'failed';
        return user.value;
      }
      revalidationState.value = 'idle';
      confirmed.value = false;
      bootstrapState.value = unauthenticated ? 'anonymous' : 'error';
      return null;
    } finally {
      bounded?.dispose();
    }
  }

  async function ensureOwnerConfirmed(): Promise<User | null> {
    if (confirmed.value) return user.value;
    if (bootstrapPromise !== null) return bootstrapPromise;
    bootstrapPromise = loadCurrent().finally(() => {
      bootstrapPromise = null;
    });
    return bootstrapPromise;
  }

  async function login(email: string, password: string): Promise<User> {
    loading.value = true;
    error.value = null;
    revalidationState.value = 'idle';
    invalidateOwnerEpoch();
    try {
      await plannerClient.login(email, password);
      const binding = captureOwnerBinding();
      const current = await plannerClient.getMe(binding.signal);
      if (!isOwnerBindingCurrent(binding)) throw ownerChangedError();
      ownerChanged(ownerState.ownerId.value, current.id, 'login');
      confirmOwner(current);
      return current;
    } catch (cause) {
      error.value = loginErrorMessage(cause);
      throw cause;
    } finally {
      loading.value = false;
    }
  }

  async function logout(): Promise<void> {
    invalidateOwnerEpoch();
    try {
      await plannerClient.logout();
    } finally {
      revalidationState.value = 'idle';
      ownerChanged(ownerState.ownerId.value, null, 'logout');
      user.value = null;
      confirmed.value = false;
      bootstrapState.value = 'anonymous';
    }
  }

  function boundUser() {
    const binding = captureOwnerBinding();
    const current = user.value;
    if (
      current === null ||
      !confirmed.value ||
      isOwnerResetPending() ||
      !isOwnerBindingCurrent(binding) ||
      binding.ownerId !== current.id
    ) {
      throw ownerChangedError();
    }
    return { binding, current };
  }

  async function setLlmConsent(granted: boolean): Promise<void> {
    const { binding, current } = boundUser();
    const updated = await plannerClient.updateMySettings(
      { llm: { consent: { granted } } },
      uuidV7Key(),
      current.version,
      binding.signal,
    );
    if (!isOwnerBindingCurrent(binding) || updated.id !== ownerState.ownerId.value) return;
    user.value = updated;
  }

  async function setLlmBudget(dailyUsd: number, monthlyUsd: number): Promise<void> {
    const { binding, current } = boundUser();
    const updated = await plannerClient.updateMySettings(
      { llm: { budget: { dailyUsd, monthlyUsd } } },
      uuidV7Key(),
      current.version,
      binding.signal,
    );
    if (!isOwnerBindingCurrent(binding) || updated.id !== ownerState.ownerId.value) return;
    user.value = updated;
  }

  return {
    user,
    ownerId,
    epoch,
    resetPending,
    confirmed,
    bootstrapState,
    revalidationState,
    loading,
    error,
    loadCurrent,
    ensureOwnerConfirmed,
    login,
    logout,
    setLlmConsent,
    setLlmBudget,
  };
});
