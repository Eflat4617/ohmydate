<script setup lang="ts">
// Lint fixture (owner-lint.spec.ts, FU-77R-1 H2): the same aliases in a
// script-setup block. Linted as if it lived in src/, each numbered line must FAIL.
import { ref } from 'vue';

const browser = window;
const everything = globalThis;
const { sessionStorage: store } = everything; // 1
const draft = ref(browser.localStorage.getItem('ohmydate.draft') ?? ''); // 2

function remember(value: string): void {
  store.setItem('ohmydate.draft', value);
  window.window.localStorage.setItem('ohmydate.draft', value); // 3
  self.self.indexedDB.open('ohmydate-draft'); // 4
  document.defaultView?.sessionStorage.setItem('ohmydate.draft', value); // 5
  browser['localStorage'].setItem('ohmydate.draft', value); // 6
  Reflect.get(window, 'sessionStorage'); // 7
}
</script>

<template>
  <input v-model="draft" @change="remember(draft)" />
</template>
