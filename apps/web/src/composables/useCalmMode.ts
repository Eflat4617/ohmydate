import { ref } from 'vue';

/**
 * Presentational flag for Focus "calm mode": the shell hides (and makes inert)
 * its navigation so only the timer remains. Not persisted; FocusView resets it
 * when it unmounts.
 */
export const calmMode = ref(false);

export function setCalmMode(value: boolean): void {
  calmMode.value = value;
}
