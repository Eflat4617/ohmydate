export const packageName = '@ohmydate/contracts' as const;

export {
  CursorSchema,
  IdSchema,
  IANA_TIME_ZONE_FORMAT,
  IanaTimeZoneSchema,
  IdempotencyKeyHeaderSchema,
  IfMatchHeaderSchema,
  IfMatchPattern,
  IfNoneMatchHeaderSchema,
  InstantSchema,
  UUID_V7_PATTERN,
  VersionSchema,
  pageSchema,
  registerIanaTimeZoneFormat,
  type FormatRegistrar,
  type PageSchemaOptions,
} from './common.js';

export {
  LoginRequestSchema,
  UserSchema,
  UserSettingsPatchSchema,
  type LoginRequest,
  type User,
  type UserSettingsPatch,
} from './auth.js';

export {
  PROBLEM_CODES,
  ProblemCodeSchema,
  ProblemErrorSchema,
  ProblemSchema,
  type Problem,
  type ProblemCode,
} from './problem.js';

export {
  PageProjectSchema,
  ProjectCreateSchema,
  ProjectPatchSchema,
  ProjectSchema,
  type Project,
  type ProjectCreate,
  type ProjectPatch,
} from './project.js';

export {
  ExternalProviderRefSchema,
  PageTaskSchema,
  SessionWindowSchema,
  TASK_STATUSES,
  TaskCreateSchema,
  TaskDependencyCreateSchema,
  TaskDependencySchema,
  TaskIdParamsSchema,
  TaskListQuerySchema,
  TaskPatchSchema,
  TaskPrioritySchema,
  TaskSchema,
  TaskStatusSchema,
  type Task,
  type TaskCreate,
  type TaskDependency,
  type TaskDependencyCreate,
  type TaskIdParams,
  type TaskListQuery,
  type TaskPatch,
  type TaskStatus,
} from './task.js';

export {
  routes,
  schemaRegistry,
  type HttpMethod,
  type RouteDefinition,
  type RouteResponse,
  type SchemaRegistry,
} from './routes.js';
