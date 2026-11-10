export const packageName = '@ohmydate/scheduler' as const;

export type {
  AvailabilityKind,
  AvailabilityRule,
  Block,
  Commitment,
  DeficitReport,
  ExceptionKind,
  ExceptionRule,
  GenerateOptions,
  GenerateResult,
  Horizon,
  IanaTz,
  Id,
  InputIssue,
  Instant,
  PlanCandidate,
  PlanMetrics,
  PolicyName,
  Preferences,
  RiskLevel,
  ScheduleInput,
  Slot,
  Task,
  TaskDeficit,
  TaskEstimate,
  ValidateOptions,
  Violation,
  ViolationCode,
  Weekday,
  WindowKind,
} from './types.js';

export { computeAvailableSlots, maxContiguousMin, slotTotalMin } from './slots.js';
export { MAX_INPUT_MINUTES, validate, validateInput } from './validate.js';
export { deficit } from './explain.js';
export { taskRequiredMinutes } from './requirements.js';
export { generate, GENERATOR_VERSION } from './generate.js';
export {
  POLICIES,
  POLICY_NAMES,
  POLICY_VERSION,
  type PolicyOrdering,
  type PolicyProfile,
  type PolicySlotRule,
  type PolicyWeights,
} from './policies.js';
