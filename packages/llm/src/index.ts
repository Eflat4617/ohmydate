export const packageName = '@ohmydate/llm' as const;

export {
  BudgetGuard,
  type BudgetGuardInit,
  type BudgetRecordOptions,
  type BudgetSnapshot,
} from './budget.js';

export {
  BudgetExceeded,
  GatewayError,
  LlmError,
  LlmTimeoutError,
  LlmUnavailable,
  MissingSessionIdError,
  PromptNotFoundError,
  ResponseFormatUnsupportedError,
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

export {
  DEFAULT_DEEPSEEK_PRICING,
  OpenAICompatibleLlm,
  type LlmPricingPerMillion,
  type OpenAICompatibleLlmOptions,
} from './openai-compatible-llm.js';

export {
  PolicyLlm,
  type LlmConsentRecord,
  type PolicyLlmOptions,
  type ResolvedLlmAccess,
} from './policy-llm.js';

export type {
  LlmBudget,
  LlmCompleteRequest,
  LlmCompleteResponse,
  LlmPort,
  LlmUsage,
} from './port.js';

export {
  MAX_REDACT_INPUT,
  assertRedactInputSize,
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
