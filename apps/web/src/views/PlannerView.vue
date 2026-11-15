<script setup lang="ts">
import { computed } from 'vue';
import { useRoute } from 'vue-router';
import PlannerDay from '../components/planner/PlannerDay.vue';
import PlannerList from '../components/planner/PlannerList.vue';
import PlannerWeek from '../components/planner/PlannerWeek.vue';
import { plannerViewOf } from '../domain/plannerRoute';
import MonthView from './MonthView.vue';

/**
 * 플래너 (HOLO-02, HOLO-04): the calendar screen with its views. The address
 * says which one (`/planner?view=day|week|month|list`, 주 by default; `/month`
 * is the month view, as it was in CAL-01; `list` is the week's 약속 as a
 * list — what the 약속 screen was). Each view is a page of its own with
 * the shared head (components/planner/PlannerHeader.vue): the dates on show,
 * back / 오늘 / forward, the view switch and the one primary button.
 */
const route = useRoute();
const view = computed(() => plannerViewOf(route.name, route.query));
</script>

<template>
  <MonthView v-if="view === 'month'" />
  <PlannerDay v-else-if="view === 'day'" />
  <PlannerList v-else-if="view === 'list'" />
  <PlannerWeek v-else />
</template>
