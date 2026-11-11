<script setup lang="ts">
import { nextTick } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useAuthStore } from '../stores/auth';
import { useUiStore } from '../stores/ui';
import BrandMark from './BrandMark.vue';
import UiButton from './ui/UiButton.vue';
import UiIcon from './ui/UiIcon.vue';
import { t } from '../i18n';

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
  <nav class="nav-rail" :aria-label="t('nav.primary')">
    <RouterLink class="nav-brand" to="/inbox" :aria-label="t('nav.home')">
      <BrandMark :size="30" />
      <span class="nav-brand-name">{{ t('app.name') }}</span>
    </RouterLink>

    <UiButton variant="primary" block icon="plus" class="nav-new-task" @click="newTask">
      {{ t('nav.newTask') }} <kbd>n</kbd>
    </UiButton>

    <div class="nav-groups">
      <div class="nav-group">
        <p class="nav-group-label" aria-hidden="true">{{ t('nav.groupDaily') }}</p>
        <ul class="nav-links">
          <li>
            <RouterLink to="/today" class="nav-link">
              <UiIcon name="today" class="nav-link-icon" />
              <span class="nav-link-label">{{ t('nav.today') }}</span>
              <kbd>t</kbd>
            </RouterLink>
          </li>
          <li>
            <RouterLink to="/inbox" class="nav-link">
              <UiIcon name="inbox" class="nav-link-icon" />
              <span class="nav-link-label">{{ t('nav.inbox') }}</span>
            </RouterLink>
          </li>
          <li>
            <RouterLink to="/projects" class="nav-link">
              <UiIcon name="projects" class="nav-link-icon" />
              <span class="nav-link-label">{{ t('nav.projects') }}</span>
            </RouterLink>
          </li>
          <li>
            <button type="button" class="nav-link nav-link-button" @click="ui.openNotifications">
              <UiIcon name="bell" class="nav-link-icon" />
              <span class="nav-link-label">{{ t('nav.notifications') }}</span>
            </button>
          </li>
        </ul>
      </div>

      <div class="nav-group">
        <p class="nav-group-label" aria-hidden="true">{{ t('nav.groupPlanning') }}</p>
        <ul class="nav-links">
          <li>
            <RouterLink to="/plan/new" class="nav-link">
              <UiIcon name="plan" class="nav-link-icon" />
              <span class="nav-link-label">{{ t('nav.plan') }}</span>
            </RouterLink>
          </li>
          <li>
            <RouterLink to="/plans/new" class="nav-link">
              <UiIcon name="compare" class="nav-link-icon" />
              <span class="nav-link-label">{{ t('nav.newPlan') }}</span>
            </RouterLink>
          </li>
          <li>
            <RouterLink to="/replan" class="nav-link">
              <UiIcon name="reschedule" class="nav-link-icon" />
              <span class="nav-link-label">{{ t('nav.replan') }}</span>
            </RouterLink>
          </li>
          <li>
            <RouterLink to="/patterns" class="nav-link">
              <UiIcon name="pattern" class="nav-link-icon" />
              <span class="nav-link-label">{{ t('nav.patterns') }}</span>
            </RouterLink>
          </li>
          <li>
            <RouterLink to="/commitments" class="nav-link">
              <UiIcon name="commitment" class="nav-link-icon" />
              <span class="nav-link-label">{{ t('nav.commitments') }}</span>
            </RouterLink>
          </li>
          <li>
            <RouterLink to="/settings/availability" class="nav-link">
              <UiIcon name="availability" class="nav-link-icon" />
              <span class="nav-link-label">{{ t('nav.availability') }}</span>
            </RouterLink>
          </li>
        </ul>
      </div>

      <div class="nav-group">
        <p class="nav-group-label" aria-hidden="true">{{ t('nav.groupSettings') }}</p>
        <ul class="nav-links">
          <li>
            <RouterLink to="/settings/ai" class="nav-link">
              <UiIcon name="ai" class="nav-link-icon" />
              <span class="nav-link-label">{{ t('nav.aiSettings') }}</span>
            </RouterLink>
          </li>
        </ul>
      </div>
    </div>

    <div class="nav-secondary">
      <button type="button" class="nav-link nav-link--quiet" @click="ui.openSearch">
        <UiIcon name="search" class="nav-link-icon" />
        <span class="nav-link-label">{{ t('nav.search') }}</span>
        <kbd>/</kbd>
      </button>
      <button type="button" class="nav-link nav-link--quiet" @click="ui.openHelp">
        <UiIcon name="help" class="nav-link-icon" />
        <span class="nav-link-label">{{ t('nav.help') }}</span>
        <kbd>?</kbd>
      </button>
      <button type="button" class="nav-link nav-link--quiet" @click="signOut">
        <UiIcon name="logout" class="nav-link-icon" />
        <span class="nav-link-label">{{ t('nav.signOut') }}</span>
      </button>
    </div>
  </nav>
</template>
