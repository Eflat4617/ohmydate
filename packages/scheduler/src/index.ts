export const packageName = '@ohmydate/scheduler' as const;

export type {
  AvailabilityKind,
  AvailabilityRule,
  Block,
  Commitment,
  DeficitReport,
  ExceptionKind,
  ExceptionRule,
  Horizon,
  IanaTz,
  Id,
  InputIssue,
  Instant,
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
export { validate, validateInput } from './validate.js';
export { deficit } from './explain.js';
export { taskRequiredMinutes } from './requirements.js';
