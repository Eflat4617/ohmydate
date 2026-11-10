import { ref } from 'vue';
import { defineStore } from 'pinia';
import { ApiError, plannerClient, type User } from '../api';

export const useAuthStore = defineStore('auth', () => {
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
    await plannerClient.logout();
    user.value = null;
  }

  return { user, loading, error, login, logout };
});
