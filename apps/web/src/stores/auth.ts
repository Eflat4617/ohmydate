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

export const useAuthStore = defineStore('auth', () => {
  const ownerId = ownerState.ownerId;
  const epoch = ownerState.epoch;
  const resetPending = ownerState.resetPending;
  const user = ref<User | null>(null);
  const confirmed = ref(false);
  const bootstrapState = ref<AuthBootstrapState>('pending');
  const loading = ref(false);
  const error = ref<string | null>(null);
  let bootstrapPromise: Promise<User | null> | null = null;

  onActiveOwnerChange(() => {
    user.value = null;
    confirmed.value = false;
    bootstrapState.value = 'pending';
    error.value = null;
  });

  function confirmOwner(current: User): void {
    user.value = current;
    confirmed.value = true;
    bootstrapState.value = 'ready';
    clearOwnerResetPending();
    sessionJournal.setOwner(current.id);
  }

  async function loadCurrent(): Promise<User | null> {
    const binding = captureOwnerBinding();
    const wasConfirmed = confirmed.value;
    bootstrapState.value = 'pending';
    try {
      const current = await plannerClient.getMe(binding.signal);
      if (!isOwnerBindingCurrent(binding)) return null;
      const stored = ownerState.ownerId.value;
      if (stored !== null && stored !== current.id) {
        ownerChanged(stored, current.id, 'me-mismatch');
        confirmOwner(current);
        return current;
      }
      if (stored === null) adoptActiveOwner(current.id, 'bootstrap');
      confirmOwner(current);
      return current;
    } catch (cause) {
      if (!isOwnerBindingCurrent(binding)) return null;
      const unauthenticated =
        cause instanceof ApiError && (cause.status === 401 || cause.status === 403);
      if (wasConfirmed && !unauthenticated) {
        bootstrapState.value = 'ready';
        return user.value;
      }
      confirmed.value = false;
      bootstrapState.value = unauthenticated ? 'anonymous' : 'error';
      return null;
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
