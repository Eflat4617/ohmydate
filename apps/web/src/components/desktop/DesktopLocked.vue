<script setup lang="ts">
import BrandMark from '../BrandMark.vue';
import { t } from '../../i18n';

/**
 * The desktop bundle's only "signed out" screen (15 §7.3 item 2): the core
 * answered `/me` with 401, so this page has no launch cookie — it was opened
 * by its address instead of by the app, or the app has been restarted since.
 * There is nothing to sign in to and nothing to fill in: the way back is to
 * open the app. No form, no button, no link to a login. A plain card: the
 * airy glass is the sign-in card's (DESIGN.md), and this is not one.
 */
</script>

<template>
  <main class="auth-page" data-desktop-locked>
    <div class="ambient" aria-hidden="true" data-ambient></div>
    <section class="auth-card card" aria-labelledby="desktop-locked-title">
      <header class="auth-header">
        <BrandMark :size="44" />
        <h1 id="desktop-locked-title">{{ t('desktop.locked.title') }}</h1>
        <p>{{ t('desktop.locked.body') }}</p>
        <p class="muted">{{ t('desktop.locked.note') }}</p>
      </header>
    </section>
  </main>
</template>
