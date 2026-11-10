import type { PolicyName } from './types.js';

/**
 * Published objective weights (06 §4). The version string is part of every
 * candidate's explanation so stored plans can be traced to a policy revision.
 *
 * Weights are ordered (S1, S2, S3, S4, S5, S6):
 *   S1 early completion, S2 daily spread, S3 preferred windows,
 *   S4 context switches, S5 retain existing blocks, S6 minimum slack.
 */
export const POLICY_VERSION = '1.0.0';

export interface PolicyWeights {
  s1EarlyCompletion: number;
  s2DailySpread: number;
  s3PreferredWindows: number;
  s4ContextSwitches: number;
  s5RetainExisting: number;
  s6MinSlack: number;
}

export type PolicyOrdering = 'edf' | 'priority_then_length' | 'longest_first';

export interface PolicyProfile {
  name: PolicyName;
  version: string;
  weights: PolicyWeights;
  ordering: PolicyOrdering;
  summary: string;
}

export const POLICIES: Readonly<Record<PolicyName, PolicyProfile>> = {
  front_loaded: {
    name: 'front_loaded',
    version: POLICY_VERSION,
    weights: {
      s1EarlyCompletion: 1.0,
      s2DailySpread: 0.1,
      s3PreferredWindows: 0.2,
      s4ContextSwitches: 0.3,
      s5RetainExisting: 0.5,
      s6MinSlack: 0.6,
    },
    ordering: 'edf',
    summary: 'Finish work as early as possible and maximise due-date slack.',
  },
  balanced: {
    name: 'balanced',
    version: POLICY_VERSION,
    weights: {
      s1EarlyCompletion: 0.2,
      s2DailySpread: 1.0,
      s3PreferredWindows: 0.3,
      s4ContextSwitches: 0.3,
      s5RetainExisting: 0.5,
      s6MinSlack: 0.4,
    },
    ordering: 'priority_then_length',
    summary: 'Spread work evenly across days.',
  },
  focus_blocked: {
    name: 'focus_blocked',
    version: POLICY_VERSION,
    weights: {
      s1EarlyCompletion: 0.3,
      s2DailySpread: 0.3,
      s3PreferredWindows: 0.8,
      s4ContextSwitches: 1.0,
      s5RetainExisting: 0.5,
      s6MinSlack: 0.4,
    },
    ordering: 'longest_first',
    summary: 'Prefer long contiguous focus blocks and few context switches.',
  },
};

export const POLICY_NAMES: readonly PolicyName[] = [
  'front_loaded',
  'balanced',
  'focus_blocked',
];
