<script setup lang="ts">
import { computed } from 'vue';
import { useRoute } from 'vue-router';
import PlannerDay from '../components/planner/PlannerDay.vue';
import PlannerWeek from '../components/planner/PlannerWeek.vue';
import { plannerViewOf } from '../domain/plannerRoute';
import MonthView from './MonthView.vue';

/**
 * 플래너 (HOLO-02): the calendar screen with its three views. The address
 * says which one (`/planner?view=day|week|month`, 주 by default; `/month` is
 * the month view, as it was in CAL-01). Each view is a page of its own with
 * the shared head (components/planner/PlannerHeader.vue): the dates on show,
 * back / 오늘 / forward, the view switch and the one primary button.
 */
const route = useRoute();
const view = computed(() => plannerViewOf(route.name, route.query));
</script>

<template>
  <MonthView v-if="view === 'month'" />
  <PlannerDay v-else-if="view === 'day'" />
  <PlannerWeek v-else />
</template>
