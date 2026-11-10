<script setup lang="ts">
import { ref } from 'vue';
import { useRouter } from 'vue-router';
import { useAuthStore } from '../stores/auth';

const email = ref('');
const password = ref('');
const auth = useAuthStore();
const router = useRouter();

async function submit(): Promise<void> {
  try {
    await auth.login(email.value, password.value);
    await router.push({ name: 'inbox' });
  } catch {
    // `auth.error` carries the user-facing message.
  }
}
</script>

<template>
  <main class="auth-page">
    <section class="auth-card">
      <h1 id="login-heading">Sign in to OhMyDate</h1>
      <p class="muted">One next action, easy to find.</p>
      <form aria-labelledby="login-heading" @submit.prevent="submit">
        <label for="login-email">Email</label>
        <input
          id="login-email"
          v-model="email"
          type="email"
          autocomplete="username"
          required
          :disabled="auth.loading"
        />

        <label for="login-password">Password</label>
        <input
          id="login-password"
          v-model="password"
          type="password"
          autocomplete="current-password"
          required
          :disabled="auth.loading"
        />

        <p v-if="auth.error" class="error-text" role="alert">{{ auth.error }}</p>

        <button type="submit" class="primary-action" :disabled="auth.loading">
          {{ auth.loading ? 'Signing in…' : 'Sign in' }}
        </button>
      </form>
    </section>
  </main>
</template>
