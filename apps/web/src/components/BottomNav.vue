<script setup lang="ts">
import { nextTick } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useUiStore } from '../stores/ui';

const ui = useUiStore();
const router = useRouter();
const route = useRoute();

function newTask(): void {
  if (route.name === 'inbox') {
    ui.requestNewTask();
    return;
  }
  void router.push({ name: 'inbox' }).then(async () => {
    await nextTick();
    ui.requestNewTask();
  });
}
</script>

<template>
  <nav class="bottom-nav" aria-label="Primary">
    <RouterLink to="/inbox">Inbox</RouterLink>
    <RouterLink to="/projects">Projects</RouterLink>
    <button type="button" class="bottom-add" aria-label="New task" @click="newTask">+</button>
    <RouterLink to="/plan/new">Plan</RouterLink>
    <RouterLink to="/today">Today</RouterLink>
    <RouterLink to="/commitments">Commitments</RouterLink>
    <RouterLink to="/settings/availability">Availability</RouterLink>
    <button type="button" aria-label="Help" @click="ui.openHelp">?</button>
  </nav>
</template>
