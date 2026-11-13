import { watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { plannerQueryFix } from '../domain/plannerRoute';

/**
 * 플래너 (HOLO-02): an address whose query cannot mean what it says (a view
 * that is none, a date that does not exist, a week given by a Wednesday) is
 * corrected once, with a replace, so it does not stay in the bar. Each view
 * calls this; the rule is domain/plannerRoute.ts.
 */
export function usePlannerQueryFix(): void {
  const route = useRoute();
  const router = useRouter();
  watch(
    () => [route.name, route.query] as const,
    ([name, query]) => {
      if (name !== 'planner' && name !== 'month') return;
      const fix = plannerQueryFix(name, query);
      if (fix === null) return;
      const next: Record<string, string> = {};
      for (const [key, value] of Object.entries(query)) {
        if (fix.drop.includes(key) || typeof value !== 'string') continue;
        next[key] = value;
      }
      void router.replace({ name, query: { ...next, ...fix.set } });
    },
    { immediate: true },
  );
}
