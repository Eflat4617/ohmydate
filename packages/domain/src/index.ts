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
  InboxProjectLookup,
  InboxProjectRepository,
  Page,
  ProjectQuery,
  ProjectRepository,
  RepositoryCapabilities,
  TaskChange,
  TaskChangePage,
  TaskQuery,
  TaskRepository,
} from './ports.js';

export { supportsInbox } from './ports.js';

export { epochMsToInstant, instantToEpochMs } from './time.js';

export {
  createUuidV7Generator,
  uuidV7,
  type RandomBytes,
  type UuidV7GeneratorOptions,
} from './uuid.js';
