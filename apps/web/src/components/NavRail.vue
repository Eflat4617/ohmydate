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
  <nav class="nav-rail" aria-label="Primary">
    <RouterLink class="brand" to="/inbox" aria-label="OhMyDate home">OhMyDate</RouterLink>
    <button type="button" class="primary-action" @click="newTask">
      New task <kbd>n</kbd>
    </button>
    <ul class="nav-links">
      <li>
        <RouterLink to="/inbox">Inbox</RouterLink>
      </li>
      <li>
        <RouterLink to="/projects">Projects</RouterLink>
      </li>
      <li>
        <RouterLink to="/today">Today <kbd>t</kbd></RouterLink>
      </li>
    </ul>
    <div class="nav-secondary">
      <button type="button" class="link-button" @click="ui.openSearch">
        Search <kbd>/</kbd>
      </button>
      <button type="button" class="link-button" @click="ui.openHelp">
        Help <kbd>?</kbd>
      </button>
    </div>
  </nav>
</template>
