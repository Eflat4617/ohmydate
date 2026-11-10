export const packageName = '@ohmydate/provider-vikunja' as const;

export {
  VIKUNJA_ERROR_CODES,
  VikunjaClient,
  mapVikunjaError,
  toValidationIssues,
  type CreateTokenInput,
  type CreatedToken,
  type FetchLike,
  type Paginated,
  type RequestOptions,
  type ResponseEnvelope,
  type VikunjaClientOptions,
  type VikunjaProblem,
  type VikunjaProject,
  type VikunjaTask,
  type VikunjaUser,
} from './client.js';
export {
  EMPTY_CHANGE_CURSOR,
  compareListPosition,
  decodeChangeCursor,
  decodeListCursor,
  encodeChangeCursor,
  encodeListCursor,
  epochSeconds,
  isChangeAfterCursor,
  type ChangeCursor,
  type ListCursor,
} from './cursor.js';
export {
  InMemoryMappingStore,
  type ExternalMapping,
  type MappingEntityType,
  type MappingStore,
} from './mapping-store.js';
export { appendMarker, extractMarker, stripMarker } from './marker.js';
export {
  InMemoryPlannerFieldStore,
  defaultPlannerTaskFields,
  type PlannerFieldStore,
  type PlannerTaskFields,
} from './planner-field-store.js';
export {
  VikunjaProjectRepository,
  type VikunjaProjectRepositoryOptions,
} from './project-repository.js';
export {
  VikunjaTaskRepository,
  createVikunjaTaskRepository,
  type VikunjaTaskRepositoryOptions,
} from './task-repository.js';
export { normalizeRemoteInstant } from './time.js';
export {
  validateDependsOn,
  validateDescription,
  validateInstant,
  validatePriority,
  validateSession,
  validateStatus,
  validateTaskCreate,
  validateTaskPatch,
  validateTitle,
  type NormalizedTaskCreate,
  type NormalizedTaskPatch,
} from './validation.js';
