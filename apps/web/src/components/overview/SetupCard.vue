<script setup lang="ts">
import { computed } from 'vue';
import { FIRST_RUN_STEPS, type FirstRun } from '../../composables/firstRun';
import { t, tp } from '../../i18n';
import UiButton from '../ui/UiButton.vue';
import UiCard from '../ui/UiCard.vue';
import UiIcon from '../ui/UiIcon.vue';

/**
 * 시작 마무리 (HOLO-04, FLOW.md §3): on 개요 only while the start guide is not
 * over. It says which of the three steps are still open and resumes the
 * guide at the first of them; "나중에 할게요" ends it for good (each open step
 * is asked again where it is needed). It is never the page's filled button.
 */
const props = defineProps<{ guide: FirstRun }>();

const left = computed(() => props.guide.remaining.value.length);
</script>

<template>
  <UiCard v-if="!guide.finished.value && left > 0" class="setup-card" aria-labelledby="setup-card-title" data-setup-card>
    <div class="setup-card-text">
      <h2 id="setup-card-title" class="card-title"><UiIcon name="flag" :size="18" />{{ t('firstRun.card.title') }}</h2>
      <p class="setup-card-lede">{{ tp('firstRun.card.left', left) }}</p>
      <ul class="setup-card-steps">
        <li
          v-for="step in FIRST_RUN_STEPS"
          :key="step"
          class="setup-card-step"
          :class="`setup-card-step--${guide.states.value[step]}`"
          :data-setup-step="step"
          :data-setup-state="guide.states.value[step]"
        >
          <UiIcon :name="guide.states.value[step] === 'done' ? 'check-circle' : 'ring'" :size="16" class="setup-card-mark" />
          <span>{{ t(`firstRun.${step}.short`) }}</span>
          <span class="setup-card-state">{{ t(`firstRun.state.${guide.states.value[step]}`) }}</span>
        </li>
      </ul>
    </div>
    <div class="setup-card-actions">
      <UiButton icon="arrow-right" data-setup-resume @click="guide.start()">{{ t('firstRun.card.resume') }}</UiButton>
      <button type="button" class="first-run-skip" data-setup-later @click="guide.end()">{{ t('firstRun.card.later') }}</button>
    </div>
  </UiCard>
</template>
