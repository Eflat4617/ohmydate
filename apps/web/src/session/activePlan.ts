import { ref } from 'vue';
import { ownerStorageSuffix } from './owner';

/**
 * The plan the owner last approved or opened as active, per owner.
 *
 * `POST /replan-proposals:request` needs a plan id, but neither Today nor a
 * replan proposal carries one (contract gap reported with M5-03). The web
 * remembers the id it learns from `PlanVersion.planId` (plan, Today and replan
 * approvals) and from an active plan page, and forgets it when the server says
 * the plan is gone. Only an id is stored — no plan content.
 */

const PREFIX = 'ohmydate.plan.active';

/** Bumped on every change so computed refs re-read storage. */
export const activePlanRevision = ref(0);

function storageKey(ownerId: string | null): string {
  return `${PREFIX}:${ownerStorageSuffix(ownerId)}`;
}

export function rememberedActivePlan(ownerId: string | null): string | null {
  if (typeof localStorage === 'undefined') return null;
  try {
    const value = localStorage.getItem(storageKey(ownerId));
    return value !== null && /^[0-9a-f-]{36}$/i.test(value) ? value : null;
  } catch {
    return null;
  }
}

export function rememberActivePlan(ownerId: string | null, planId: string): void {
  if (typeof localStorage === 'undefined' || !/^[0-9a-f-]{36}$/i.test(planId)) return;
  try {
    if (localStorage.getItem(storageKey(ownerId)) === planId) return;
    localStorage.setItem(storageKey(ownerId), planId);
    activePlanRevision.value += 1;
  } catch {
    // Storage can be unavailable (private mode); the request button just stays hidden.
  }
}

export function forgetActivePlan(ownerId: string | null, planId?: string): void {
  if (typeof localStorage === 'undefined') return;
  try {
    const key = storageKey(ownerId);
    if (planId !== undefined && localStorage.getItem(key) !== planId) return;
    localStorage.removeItem(key);
    activePlanRevision.value += 1;
  } catch {
    // Nothing to forget.
  }
}
