/**
 * 계획 세우기 (HOLO-03A): the stages of the one flow, and which of them a
 * planning session is at. Pure.
 *
 *   목표 → 질문 → 단계 → 일정안 → 확정
 */
export type PlanStage = 'goal' | 'questions' | 'steps' | 'schedule' | 'confirmed';

export const PLAN_STAGES: readonly PlanStage[] = ['goal', 'questions', 'steps', 'schedule', 'confirmed'];

/** The fields of a planning session that say how far it got (the API's `IntakeSession`). */
export interface StagedSession {
  readonly state: string;
  readonly draft?: unknown;
}

/**
 * Where a session is: `questions` while the AI asks (its type check included),
 * `steps` once there is a draft to look at, `schedule` once the steps were
 * approved — and `ended` when it was cancelled or failed.
 *
 * A session that was set aside (`needs_input`) is where it was when it stopped.
 */
export function sessionStage(session: StagedSession): PlanStage | 'ended' {
  switch (session.state) {
    case 'cancelled':
    case 'failed':
      return 'ended';
    case 'created':
    case 'type_detection':
    case 'clarification':
      return 'questions';
    case 'needs_input':
      return session.draft === undefined ? 'questions' : 'steps';
    case 'decomposition':
      return 'steps';
    case 'scheduled':
      return 'confirmed';
    default:
      // feasibility_check, plan_proposals, awaiting_approval: the steps are tasks now.
      return 'schedule';
  }
}
