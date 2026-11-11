<script setup lang="ts">
import UiEmptyState from '../components/ui/UiEmptyState.vue';
import { t } from '../i18n';

// Placeholder notes route so the `notes` layout mode has a page (07 §2.2
// rule 6). M6-03 replaces this view with the real notes screen.
</script>

<template>
  <section class="page" aria-labelledby="notes-title">
    <header class="page-header">
      <div class="page-heading">
        <h1 id="notes-title">{{ t('layout.notesPage.title') }}</h1>
      </div>
    </header>
    <UiEmptyState icon="leaf" :title="t('layout.notesPage.emptyTitle')">
      <p>{{ t('layout.notesPage.emptyBody') }}</p>
    </UiEmptyState>
  </section>
</template>
