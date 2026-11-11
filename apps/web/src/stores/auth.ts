import { ref } from 'vue';
import { defineStore } from 'pinia';
import { ApiError, plannerClient, type User } from '../api';
import { uuidV7Key } from '../api/idempotency';
import { invalidateOwnerEpoch, ownerState } from '../session/ownerEpoch';
import { useSessionStore } from './session';

export const useAuthStore = defineStore('auth', () => {
  const sessions = useSessionStore();
  const ownerId = ownerState.ownerId;
  const epoch = ownerState.epoch;
  const user = ref<User | null>(null);
  const loading = ref(false);
  const error = ref<string | null>(null);

  async function loadCurrent(): Promise<User | null> {
    try {
      const current = await plannerClient.getMe();
      user.value = current;
      return current;
    } catch {
      return null;
    }
  }

  async function login(email: string, password: string): Promise<User> {
    loading.value = true;
    error.value = null;
    invalidateOwnerEpoch();
    try {
      await plannerClient.login(email, password);
      const current = await plannerClient.getMe();
      user.value = current;
      sessions.setOwner(current.id);
      return current;
    } catch (cause) {
      error.value =
        cause instanceof ApiError ? cause.detail : 'Could not sign in. Please try again.';
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
      user.value = null;
      sessions.setOwner(null);
    }
  }

  async function setLlmConsent(granted: boolean): Promise<void> {
    if (user.value === null) return;
    user.value = await plannerClient.updateMySettings(
      { llm: { consent: { granted } } },
      uuidV7Key(),
      user.value.version,
    );
  }

  async function setLlmBudget(dailyUsd: number, monthlyUsd: number): Promise<void> {
    if (user.value === null) return;
    user.value = await plannerClient.updateMySettings(
      { llm: { budget: { dailyUsd, monthlyUsd } } },
      uuidV7Key(),
      user.value.version,
    );
  }

  return {
    user,
    ownerId,
    epoch,
    loading,
    error,
    loadCurrent,
    login,
    logout,
    setLlmConsent,
    setLlmBudget,
  };
});
