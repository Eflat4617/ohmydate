import { ref } from 'vue';
import { ActionStore, plannerClient, type Plan, type PlanCreate } from '../api';
import { defaultHorizonDates } from '../domain/planDraft';
import { zonedWallClockToInstant } from '../domain/time';
import { t } from '../i18n';
import { errorMessage } from '../i18n/problem';
import { waitStep, type OwnerSteps } from '../session/ownerBound';

/** The three ways a schedule can be laid out; a plan asks for all of them unless told otherwise. */
export const PLAN_POLICIES = ['front_loaded', 'balanced', 'focus_blocked'] as const;
export type PlanPolicy = (typeof PLAN_POLICIES)[number];

/** `[start 00:00, end 24:00)` of two civil dates in the owner's zone. */
export function horizonOf(startDate: string, endDate: string, timeZone: string): PlanCreate['horizon'] {
  return {
    start: zonedWallClockToInstant(startDate, 0, timeZone),
    end: zonedWallClockToInstant(endDate, 24 * 60, timeZone),
  };
}

/** What a plan is made with when nothing else was chosen: a fortnight (or up to the due day), all three ways. */
export function defaultPlanInput(
  scope: PlanCreate['scope'],
  options: { readonly today: string; readonly dueDate: string | null; readonly timeZone: string },
): PlanCreate {
  const dates = defaultHorizonDates(options.today, options.dueDate);
  return { scope, horizon: horizonOf(dates.start, dates.end, options.timeZone), policies: [...PLAN_POLICIES] };
}

/**
 * `POST /plans`: three candidate schedules for a set of tasks (HOLO-03A).
 * One Idempotency-Key per logical request — a retry of the same input replays
 * it instead of making a second plan.
 *
 * `createSteps` is a generator: the caller runs it inside its own owner-bound
 * task (`yield* create.createSteps(input)`), so making the plan and whatever
 * the screen does with it belong to the owner who asked (ADR-023).
 */
export function usePlanCreate() {
  const actions = new ActionStore();
  const busy = ref(false);
  const error = ref<string | null>(null);

  /** The new plan, or null when it could not be made (`error` says why). */
  function* createSteps(input: PlanCreate): OwnerSteps<Plan | null> {
    const scope = 'plan:create';
    const action = actions.begin(scope, input, (left, right) => JSON.stringify(left) === JSON.stringify(right));
    busy.value = true;
    error.value = null;
    try {
      const plan = yield* waitStep(plannerClient.createPlan(action.payload, action.key));
      actions.settle(scope, action);
      return plan;
    } catch (cause) {
      error.value = errorMessage(cause, t('planScope.createError'));
      return null;
    } finally {
      busy.value = false;
    }
  }

  return { busy, error, createSteps };
}
