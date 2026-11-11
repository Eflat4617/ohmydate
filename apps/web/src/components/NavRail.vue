<script setup lang="ts">
import { nextTick } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useAuthStore } from '../stores/auth';
import { useUiStore } from '../stores/ui';

const ui = useUiStore();
const auth = useAuthStore();
const router = useRouter();
const route = useRoute();

function signOut(): void {
  void auth.logout();
}

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
        <RouterLink to="/plan/new">Plan</RouterLink>
      </li>
      <li>
        <RouterLink to="/today">Today <kbd>t</kbd></RouterLink>
      </li>
      <li>
        <RouterLink to="/plans/new">New plan</RouterLink>
      </li>
      <li>
        <RouterLink to="/commitments">Commitments</RouterLink>
      </li>
      <li>
        <RouterLink to="/settings/availability">Availability</RouterLink>
      </li>
      <li>
        <button type="button" class="link-button nav-link-button" @click="ui.openNotifications">
          Notifications
        </button>
      </li>
      <li>
        <RouterLink to="/settings/ai">AI settings</RouterLink>
      </li>
    </ul>
    <div class="nav-secondary">
      <button type="button" class="link-button" @click="ui.openSearch">
        Search <kbd>/</kbd>
      </button>
      <button type="button" class="link-button" @click="ui.openHelp">
        Help <kbd>?</kbd>
      </button>
      <button type="button" class="link-button" @click="signOut">Sign out</button>
    </div>
  </nav>
</template>
