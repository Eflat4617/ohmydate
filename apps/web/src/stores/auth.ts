import { ref } from 'vue';
import { defineStore } from 'pinia';
import { ApiError, plannerClient, type User } from '../api';
import { sessionJournal } from '../session/journal';
import { useSessionStore } from './session';

export const useAuthStore = defineStore('auth', () => {
  const sessions = useSessionStore();
  const user = ref<User | null>(null);
  const loading = ref(false);
  const error = ref<string | null>(null);

  async function login(email: string, password: string): Promise<User> {
    loading.value = true;
    error.value = null;
    try {
      await plannerClient.login(email, password);
      const current = await plannerClient.getMe();
      user.value = current;
      sessions.setOwner(current.id);
      sessionJournal.setOwner(current.id);
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
    try {
      await plannerClient.logout();
    } finally {
      user.value = null;
      sessions.setOwner(null);
      sessionJournal.setOwner(null);
    }
  }

  return { user, loading, error, login, logout };
});
