import { ref } from 'vue';
import {
  ActionStore,
  ApiError,
  plannerClient,
  type ReplanProposal,
  type ReplanReasonCode,
  type ReplanRequest,
} from '../api';
import { t } from '../i18n';
import { browserTimeZone } from '../i18n/format';
import { errorMessage } from '../i18n/problem';
import { suppressedText } from '../i18n/replan';
import { forgetActivePlan } from '../session/activePlan';
import { captureOwnerBinding, isOwnerBindingCurrent } from '../session/ownerEpoch';
import { useAuthStore } from '../stores/auth';
import { useOfflineStore } from '../stores/offline';

export interface ReplanRequestOptions {
  /** Overrides the suppression key (e.g. recompute a stale detected proposal). */
  readonly reason?: ReplanReasonCode;
  readonly affectedTaskIds?: readonly string[];
}

/**
 * `POST /replan-proposals:request` (user_request) with the 08 §1 rules: one
 * Idempotency-Key per logical submission, reused only for a network retry. A
 * 409 replan_suppressed is a *stored* domain result, so the key is dropped on
 * any API answer — otherwise a later retry would replay the old 409.
 */
export function useReplanRequest() {
  const auth = useAuthStore();
  const offline = useOfflineStore();
  const actions = new ActionStore();
  const busy = ref(false);
  const error = ref<string | null>(null);
  const hint = ref<string | null>(null);

  function reset(): void {
    error.value = null;
    hint.value = null;
  }

  async function request(planId: string, options: ReplanRequestOptions = {}): Promise<ReplanProposal | null> {
    if (busy.value || !offline.mutationsEnabled) return null;
    const binding = captureOwnerBinding();
    busy.value = true;
    reset();
    const payload: ReplanRequest = {
      planId,
      ...(options.reason === undefined ? {} : { reason: options.reason }),
      ...(options.affectedTaskIds === undefined || options.affectedTaskIds.length === 0
        ? {}
        : { affectedTaskIds: [...options.affectedTaskIds] }),
    };
    const scope = `replan:request:${planId}`;
    const action = actions.begin(scope, payload, (left, right) => JSON.stringify(left) === JSON.stringify(right));
    try {
      const created = await plannerClient.requestReplanProposal(action.payload, action.key, binding.signal);
      actions.settle(scope, action);
      return isOwnerBindingCurrent(binding) ? created : null;
    } catch (cause) {
      if (cause instanceof ApiError) actions.settle(scope, action);
      if (!isOwnerBindingCurrent(binding)) return null;
      if (cause instanceof ApiError && cause.code === 'replan_suppressed') {
        error.value = suppressedText(cause.retryAfterSeconds, Date.now(), auth.user?.timeZone ?? browserTimeZone());
        hint.value = t('replan.suppressedWhy');
      } else if (cause instanceof ApiError && cause.code === 'proposal_state_conflict') {
        error.value = t('replan.noActivePlan');
      } else if (cause instanceof ApiError && cause.status === 404) {
        forgetActivePlan(binding.ownerId, planId);
        error.value = t('replan.planMissing');
      } else {
        error.value = errorMessage(cause, t('replan.requestError'));
      }
      return null;
    } finally {
      busy.value = false;
    }
  }

  return { busy, error, hint, request, reset };
}
