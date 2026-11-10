<script setup lang="ts">
import { useRoute, useRouter } from 'vue-router';
import { useUiStore } from '../stores/ui';

const ui = useUiStore();
const router = useRouter();
const route = useRoute();

function newTask(): void {
  ui.requestNewTask();
  if (route.name !== 'inbox') void router.push({ name: 'inbox' });
}
</script>

<template>
  <nav class="bottom-nav" aria-label="Primary">
    <RouterLink to="/inbox">Inbox</RouterLink>
    <RouterLink to="/projects">Projects</RouterLink>
    <button type="button" class="bottom-add" aria-label="New task" @click="newTask">+</button>
    <RouterLink to="/today">Today</RouterLink>
    <button type="button" aria-label="Help" @click="ui.openHelp">?</button>
  </nav>
</template>
