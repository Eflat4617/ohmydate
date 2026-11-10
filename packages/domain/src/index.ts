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

export { epochMsToInstant, instantToEpochMs } from './time.js';

export {
  createUuidV7Generator,
  uuidV7,
  type RandomBytes,
  type UuidV7GeneratorOptions,
} from './uuid.js';
