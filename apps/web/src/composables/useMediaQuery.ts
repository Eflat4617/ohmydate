import { onBeforeUnmount, ref, type Ref } from 'vue';

/** Reactive `matchMedia` (false where it is unavailable, e.g. jsdom). */
export function useMediaQuery(query: string): Readonly<Ref<boolean>> {
  const matches = ref(false);
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return matches;
  const list = window.matchMedia(query);
  matches.value = list.matches;
  const onChange = (event: MediaQueryListEvent): void => {
    matches.value = event.matches;
  };
  list.addEventListener('change', onChange);
  onBeforeUnmount(() => list.removeEventListener('change', onChange));
  return matches;
}
