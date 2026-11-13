<script setup lang="ts">
import { ref } from 'vue';
import { useRouter } from 'vue-router';
import { useAuthStore } from '../stores/auth';
import BrandMark from '../components/BrandMark.vue';
import GlassOrb from '../components/ui/GlassOrb.vue';
import UiBanner from '../components/ui/UiBanner.vue';
import UiButton from '../components/ui/UiButton.vue';
import UiField from '../components/ui/UiField.vue';
import { t } from '../i18n';

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
    <GlassOrb class="auth-visual" :size="232" />
    <section class="auth-card" aria-labelledby="login-heading">
      <header class="auth-header">
        <BrandMark :size="44" />
        <h1 id="login-heading">{{ t('login.title') }}</h1>
        <p class="muted">{{ t('login.lede') }}</p>
      </header>
      <form class="auth-form" aria-labelledby="login-heading" @submit.prevent="submit">
        <UiField id="login-email" :label="t('login.email')">
          <input
            id="login-email"
            v-model="email"
            type="email"
            autocomplete="username"
            required
            :disabled="auth.loading"
          />
        </UiField>

        <UiField id="login-password" :label="t('login.password')">
          <input
            id="login-password"
            v-model="password"
            type="password"
            autocomplete="current-password"
            required
            :disabled="auth.loading"
          />
        </UiField>

        <UiBanner v-if="auth.error" tone="error" role="alert">{{ auth.error }}</UiBanner>

        <UiButton type="submit" variant="primary" size="lg" block :disabled="auth.loading" :busy="auth.loading">
          {{ auth.loading ? t('login.submitting') : t('login.submit') }}
        </UiButton>
      </form>
    </section>
  </main>
</template>
