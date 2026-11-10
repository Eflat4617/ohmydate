export const packageName = '@ohmydate/llm' as const;

export {
  BudgetGuard,
  type BudgetGuardInit,
  type BudgetRecordOptions,
  type BudgetSnapshot,
} from './budget.js';

export {
  BudgetExceeded,
  LlmError,
  LlmTimeoutError,
  LlmUnavailable,
  PromptNotFoundError,
  SchemaViolation,
  UnknownSchemaError,
  type BudgetBlockReason,
  type BudgetLimitKind,
  type LlmErrorCode,
} from './errors.js';

export {
  FakeLlm,
  fixtureKey,
  hashInput,
  type FakeLlmCall,
  type FakeLlmFixture,
  type FakeLlmResponse,
} from './fake-llm.js';

export type {
  LlmBudget,
  LlmCompleteRequest,
  LlmCompleteResponse,
  LlmPort,
  LlmUsage,
} from './port.js';

export {
  buildUntrustedBlock,
  redact,
  type RedactionCount,
  type RedactionKind,
  type RedactionResult,
} from './privacy.js';

export {
  getPrompt,
  hasPrompt,
  listPromptKeys,
  promptKey,
} from './prompt-registry.js';

export {
  SCHEMA_IDS,
  formatIssues,
  getValidator,
  hasSchema,
  validateOutput,
  type SchemaIssue,
  type SchemaValidation,
} from './schema-registry.js';

export {
  appendValidationErrors,
  runStructured,
  type RunStructuredOptions,
  type RunStructuredResult,
  type StructuredLlmRequest,
} from './run-structured.js';
