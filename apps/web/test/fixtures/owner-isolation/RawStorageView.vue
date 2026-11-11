<script setup lang="ts">
// Lint fixture (owner-guardrail.spec.ts): a screen that keeps something in
// browser storage by hand. Linted as if it lived in src/, it must FAIL.
import { ref } from 'vue';

const draft = ref(localStorage.getItem('ohmydate.draft') ?? '');

function remember(value: string): void {
  window.sessionStorage.setItem('ohmydate.draft', value);
}
</script>

<template>
  <input v-model="draft" @change="remember(draft)" />
</template>
