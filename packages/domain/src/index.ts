export const packageName = '@ohmydate/domain' as const;

export {
  assertIanaTimeZone,
  assertInstant,
  assertUuidV7,
  assertVersion,
  isIanaTimeZone,
  isInstant,
  isUuidV7,
  isVersion,
  MAX_INSTANT_MS,
  MIN_INSTANT_MS,
  type Brand,
  type IanaTimeZone,
  type Id,
  type Instant,
  type Version,
} from './brand.js';

export {
  assertAcyclic,
  type DependencyEdge,
} from './dag.js';

export {
  DomainError,
  CursorInvalidatedError,
  DependencyCycleError,
  IdempotencyMismatchError,
  NotFoundError,
  ProviderUnavailableError,
  ValidationFailedError,
  VersionConflictError,
  type DomainErrorCode,
  type ValidationIssue,
} from './errors.js';

export type {
  ExternalProviderRef,
  Project,
  ProjectCreate,
  ProjectKind,
  ProjectPatch,
  SessionWindow,
  Task,
  TaskCreate,
  TaskPatch,
  TaskPriority,
  TaskStatus,
} from './entities.js';

export type {
  Clock,
  IdGenerator,
  Page,
  ProjectQuery,
  ProjectRepository,
  RepositoryCapabilities,
  TaskChange,
  TaskChangePage,
  TaskQuery,
  TaskRepository,
} from './ports.js';

export {
  MAX_DECOMPOSITION_STEPS,
  MAX_STEP_P50_MINUTES,
  MIN_DECOMPOSITION_STEPS,
  validateDecomposition,
  type DecompositionDraft,
  type DecompositionEstimate,
  type DecompositionIssue,
  type DecompositionIssueCode,
  type DecompositionStep,
  type DecompositionStepKind,
  type DecompositionValidationResult,
} from './intake/decomposition.js';

export {
  CONSERVATIVE_DEFAULTS,
  MAX_QUESTIONS_PER_ROUND,
  MAX_QUESTION_ROUNDS,
  OPTIONAL_INTAKE_FIELDS,
  QUESTION_PROMPTS,
  REQUIRED_INTAKE_FIELDS,
  conservativeAssumptions,
  isFieldKnown,
  planQuestions,
  type IntakeAnswer,
  type IntakeAnswerAction,
  type IntakeAssumption,
  type IntakeField,
  type OptionalIntakeField,
  type PlannedQuestion,
  type QuestionPlan,
  type QuestionPlannerInput,
  type RequiredIntakeField,
} from './intake/questions.js';

export {
  INTAKE_STATES,
  TERMINAL_INTAKE_STATES,
  IntakeTransitionError,
  canTransition,
  isIntakeState,
  isTerminalIntakeState,
  transition,
  type IntakeEffect,
  type IntakeEvent,
  type IntakeEventType,
  type IntakeState,
  type IntakeTransitionResult,
  type TerminalIntakeState,
} from './intake/state-machine.js';

export { epochMsToInstant, instantToEpochMs } from './time.js';

export {
  createUuidV7Generator,
  uuidV7,
  type RandomBytes,
  type UuidV7GeneratorOptions,
} from './uuid.js';
