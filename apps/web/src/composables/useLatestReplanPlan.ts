import { computed } from 'vue';
import { useQuery } from '@tanstack/vue-query';
import { plannerClient } from '../api';
import { captureOwnerBinding } from '../session/ownerEpoch';
import { useOfflineStore } from '../stores/offline';
import { useSessionStore } from '../stores/session';

/**
 * Plan id for "다시 맞추기 요청" on screens that have no plan of their own (Today,
 * the replan list): the `planId` the server put on the owner's newest replan
 * proposal (FU-70). Nothing is remembered on the device; without any proposal
 * the request stays on the plan page, which knows its own id.
 */
export function useLatestReplanPlan() {
  const offline = useOfflineStore();
  const sessionStore = useSessionStore();
  const query = useQuery({
    queryKey: computed(() => ['replan-proposals', 'latest', sessionStore.ownerId ?? 'anonymous']),
    queryFn: () => {
      const binding = captureOwnerBinding();
      return plannerClient.listReplanProposals({ limit: 1, signal: binding.signal });
    },
    enabled: computed(() => offline.online),
  });
  const planId = computed(() => query.data.value?.items[0]?.planId ?? null);
  return { planId, query };
}
