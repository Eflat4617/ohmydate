<script setup lang="ts">
import { computed } from 'vue';
import { durationParts } from '../../domain/overview';
import { t } from '../../i18n';

/** A duration set as a card's big number: light figures, small quiet units. */
const props = defineProps<{ minutes: number }>();

const parts = computed(() =>
  durationParts(props.minutes).map((part) => ({
    value: part.value,
    unit: part.unit === 'hour' ? t('overview.unitHour') : t('overview.unitMinute'),
  })),
);
</script>

<template>
  <span class="numeral duration-numeral">
    <template v-for="(part, index) in parts" :key="index">
      <span class="duration-numeral-part">{{ part.value }}<span class="numeral-unit">{{ part.unit }}</span></span>
    </template>
  </span>
</template>
