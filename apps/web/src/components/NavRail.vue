<script setup lang="ts">
import { nextTick } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useAuthStore } from '../stores/auth';
import { useUiStore } from '../stores/ui';
import BrandMark from './BrandMark.vue';
import UiButton from './ui/UiButton.vue';
import UiIcon from './ui/UiIcon.vue';

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
    <RouterLink class="nav-brand" to="/inbox" aria-label="OhMyDate home">
      <BrandMark :size="30" />
      <span class="nav-brand-name">OhMyDate</span>
    </RouterLink>

    <UiButton variant="primary" block icon="plus" class="nav-new-task" @click="newTask">
      New task <kbd>n</kbd>
    </UiButton>

    <div class="nav-groups">
      <div class="nav-group">
        <p class="nav-group-label" aria-hidden="true">Daily</p>
        <ul class="nav-links">
          <li>
            <RouterLink to="/today" class="nav-link">
              <UiIcon name="today" class="nav-link-icon" />
              <span class="nav-link-label">Today</span>
              <kbd>t</kbd>
            </RouterLink>
          </li>
          <li>
            <RouterLink to="/inbox" class="nav-link">
              <UiIcon name="inbox" class="nav-link-icon" />
              <span class="nav-link-label">Inbox</span>
            </RouterLink>
          </li>
          <li>
            <RouterLink to="/projects" class="nav-link">
              <UiIcon name="projects" class="nav-link-icon" />
              <span class="nav-link-label">Projects</span>
            </RouterLink>
          </li>
          <li>
            <button type="button" class="nav-link nav-link-button" @click="ui.openNotifications">
              <UiIcon name="bell" class="nav-link-icon" />
              <span class="nav-link-label">Notifications</span>
            </button>
          </li>
        </ul>
      </div>

      <div class="nav-group">
        <p class="nav-group-label" aria-hidden="true">Planning</p>
        <ul class="nav-links">
          <li>
            <RouterLink to="/plan/new" class="nav-link">
              <UiIcon name="plan" class="nav-link-icon" />
              <span class="nav-link-label">Plan</span>
            </RouterLink>
          </li>
          <li>
            <RouterLink to="/plans/new" class="nav-link">
              <UiIcon name="compare" class="nav-link-icon" />
              <span class="nav-link-label">New plan</span>
            </RouterLink>
          </li>
          <li>
            <RouterLink to="/commitments" class="nav-link">
              <UiIcon name="commitment" class="nav-link-icon" />
              <span class="nav-link-label">Commitments</span>
            </RouterLink>
          </li>
          <li>
            <RouterLink to="/settings/availability" class="nav-link">
              <UiIcon name="availability" class="nav-link-icon" />
              <span class="nav-link-label">Availability</span>
            </RouterLink>
          </li>
        </ul>
      </div>

      <div class="nav-group">
        <p class="nav-group-label" aria-hidden="true">Settings</p>
        <ul class="nav-links">
          <li>
            <RouterLink to="/settings/ai" class="nav-link">
              <UiIcon name="ai" class="nav-link-icon" />
              <span class="nav-link-label">AI settings</span>
            </RouterLink>
          </li>
        </ul>
      </div>
    </div>

    <div class="nav-secondary">
      <button type="button" class="nav-link nav-link--quiet" @click="ui.openSearch">
        <UiIcon name="search" class="nav-link-icon" />
        <span class="nav-link-label">Search</span>
        <kbd>/</kbd>
      </button>
      <button type="button" class="nav-link nav-link--quiet" @click="ui.openHelp">
        <UiIcon name="help" class="nav-link-icon" />
        <span class="nav-link-label">Help</span>
        <kbd>?</kbd>
      </button>
      <button type="button" class="nav-link nav-link--quiet" @click="signOut">
        <UiIcon name="logout" class="nav-link-icon" />
        <span class="nav-link-label">Sign out</span>
      </button>
    </div>
  </nav>
</template>
