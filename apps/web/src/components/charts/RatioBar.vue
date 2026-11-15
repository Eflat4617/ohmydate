<script setup lang="ts">
import { computed } from 'vue';
import { ratioSpan } from './geometry';

/**
 * One ratio against "as estimated" (1): a track with a mark at 1 and a bar
 * from the mark toward the ratio. It is a picture of a number written beside
 * it, so it is hidden from assistive technology.
 */
const props = withDefaults(
  defineProps<{
    ratio: number | null;
    /** The top of the scale; every bar of one list shares it. */
    max?: number;
  }>(),
  { max: 2 },
);

const span = computed(() => ratioSpan(props.ratio, props.max));
</script>

<template>
  <span class="ratio-bar" aria-hidden="true" data-chart="ratio" :data-side="span === null ? 'none' : (ratio ?? 1) >= 1 ? 'over' : 'under'">
    <span
      v-if="span && span.width > 0"
      class="ratio-bar-fill"
      :style="{ left: `${span.left}%`, width: `${span.width}%` }"
    ></span>
    <span v-if="span" class="ratio-bar-tick" :style="{ left: `${span.tick}%` }"></span>
  </span>
</template>
