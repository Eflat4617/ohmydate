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
  type GatewayClassification,
  type LlmErrorCode,
} from './errors.js';

export {
  FakeLlm,
  fixtureKey,
  hashInput,
  type FakeLlmCall,
  type FakeLlmFixture,
  type FakeLlmOptions,
  type FakeLlmResponse,
} from './fake-llm.js';

export {
  DEFAULT_NOTE_CONTEXT_LIMITS,
  NOTE_CONTEXT_BUILDER_VERSION,
  bodyHashOf,
  buildNoteBlock,
  buildNoteContext,
  escapeUntrustedContent,
  groundingIndexOf,
  neutralizeLinks,
  noteTerms,
  partitionGroundedRefs,
  sanitizeUntrustedText,
  sectionHashOf,
  splitNoteSections,
  type GroundedRefCandidate,
  type GroundedRefPartition,
  type GroundingIndex,
  type HallucinatedRefReason,
  type NoteContextDocument,
  type NoteContextDocumentUsage,
  type NoteContextLimits,
  type NoteContextRequest,
  type NoteContextResult,
  type NoteContextSection,
  type NoteExclusionReason,
  type NoteSection,
} from './note-context.js';

export {
  sanitizeGroundedDecomposition,
  type GroundedDecompositionOutput,
  type GroundedEvidenceOutput,
  type GroundedRefIssue,
  type GroundedRefIssueReason,
  type GroundedSanitizeResult,
  type GroundedStepOutput,
} from './grounded-output.js';

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

export {
  DEFAULT_LLM_MAX_RETRIES,
  DEFAULT_LLM_REQUEST_TIMEOUT_MS,
  DEFAULT_STALE_RESERVATION_MARGIN_MS,
  InMemorySpendLedger,
  LLM_ATTEMPT_CHAINS_WITH_FALLBACK,
  estimateInputTokensFromChars,
  estimateInputTokensUpperBound,
  estimateReservationUsd,
  roundUpToMicroUsd,
  staleReservationThresholdMs,
  staleReservationThresholdWithFallbackMs,
  type LlmSpendLedger,
  type LlmSpendReserveInput,
  type LlmSpendRow,
  type LlmSpendSettleInput,
  type LlmSpendSettleReason,
  type LlmSpendTotals,
} from './spend-ledger.js';

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
  exampleForPattern,
  exampleForSchema,
  renderOutputContract,
  schemaIdForPrompt,
  structuredSystemPrompt,
} from './output-contract.js';

export {
  DEFAULT_DECOMPOSITION_MAX_OUTPUT_TOKENS,
  DEFAULT_DECOMPOSITION_TIMEOUT_MS,
  DEFAULT_PROMPT_LIMIT_OVERRIDES,
  DEFAULT_STRUCTURED_TIMEOUT_MS,
  MAX_OUTPUT_TOKENS_CEILING,
  effectiveMaxOutputTokens,
  maxPromptTimeoutMs,
  promptLimitsFor,
  type PromptLimitOverrides,
  type PromptLimits,
} from './prompt-limits.js';

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
  STRICT_JSON_INSTRUCTION,
  buildStructuredMessages,
  structuredContentBytes,
  withStrictJsonInstruction,
  type StructuredChatMessage,
  type StructuredMessageRequest,
} from './structured-messages.js';

export {
  DEFAULT_ABORT_SETTLE_GRACE_MS,
  appendValidationErrors,
  runStructured,
  type RunStructuredOptions,
  type RunStructuredResult,
  type StructuredLlmRequest,
} from './run-structured.js';
