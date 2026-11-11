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

export {
  EXPLANATION_CODES,
  INPUT_ISSUE_MESSAGE_CODES,
  VIOLATION_MESSAGE_CODES,
  itemFromMessage,
  type CodedItem,
  type ExplanationCode,
  type ExplanationItem,
  type ExplanationParamMap,
  type ExplanationParamValue,
  type GeneratorExplanationCode,
  type InputIssueMessageCode,
  type InputIssueParamMap,
  type PreferenceMinuteField,
  type ViolationMessageCode,
  type ViolationParamMap,
} from './codes.js';
export { computeAvailableSlots, maxContiguousMin, slotTotalMin } from './slots.js';
export {
  MAX_HORIZON_DAYS,
  MAX_INPUT_MINUTES,
  validate,
  validateInput,
} from './validate.js';
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
