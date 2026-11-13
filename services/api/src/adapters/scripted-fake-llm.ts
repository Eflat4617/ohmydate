import {
  LlmUnavailable,
  type LlmCompleteRequest,
  type LlmCompleteResponse,
  type LlmPort,
} from '@ohmydate/llm';
import { fakeCommitmentParseOutput } from './fake-commitment-parse.js';
import { fakeTaskParseOutput } from './fake-task-parse.js';

/**
 * FU-76 E2E support for `LLM_PROVIDER=fake` only: for the configured owners
 * every structured call waits `latencyMs` (abort-aware, like a real slow
 * provider) and then answers with a fixed, schema-valid output, so the web
 * wizard's AI wait state, cancel and reload-resume can be driven end to end
 * without a real gateway. Every other owner keeps the plain fixture-less
 * `FakeLlm` behaviour (immediate `llm_unavailable` -> manual mode).
 *
 * The outputs are deliberately generic and carry no user content.
 */

const SCRIPTED_STEPS = [
  {
    key: 's1',
    title: '자료 모으기',
    deliverable: '필요한 자료 목록',
    doneCriteria: '모든 자료를 찾았다',
    kind: 'prep',
    estimate: { p50Minutes: 30, p90Minutes: 60 },
    dependsOn: [],
    splittable: false,
  },
  {
    key: 's2',
    title: '초안 작성하기',
    deliverable: '첫 번째 초안',
    doneCriteria: '초안을 끝까지 썼다',
    kind: 'work',
    estimate: { p50Minutes: 120, p90Minutes: 180 },
    dependsOn: ['s1'],
    splittable: true,
  },
  {
    key: 's3',
    title: '검토하고 다듬기',
    deliverable: '검토를 마친 결과물',
    doneCriteria: '검토 의견을 반영했다',
    kind: 'review',
    estimate: { p50Minutes: 30, p90Minutes: 60 },
    dependsOn: ['s2'],
    splittable: false,
  },
] as const;

/** `input` is read only for CAL-02 commitment_parse and CAL-05 task_parse (the fixed-phrase readers). */
export function scriptedFakeOutput(schemaId: string, input?: unknown): unknown {
  switch (schemaId) {
    case 'llm.commitment_parse.v1':
      return fakeCommitmentParseOutput(input);
    case 'llm.task_parse.v1':
      return fakeTaskParseOutput(input);
    case 'llm.type_detection.v1':
      return { classification: 'new', confidence: 0.4, reasons: ['scripted_fake'] };
    case 'llm.decomposition.v1':
      return { steps: SCRIPTED_STEPS, assumptions: ['scripted fake draft'], questionsRemaining: [] };
    case 'llm.decomposition.v2':
      return {
        steps: SCRIPTED_STEPS,
        assumptions: ['scripted fake draft'],
        questionsRemaining: [],
        evidence: [],
      };
    default:
      return {};
  }
}

function abortableDelay(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const aborted = (): LlmUnavailable =>
      new LlmUnavailable('llm call aborted by caller', 'aborted', false);
    if (signal?.aborted === true) {
      reject(aborted());
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, Math.max(0, ms));
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(aborted());
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export interface ScriptedFakeLlmOptions {
  readonly inner: LlmPort;
  readonly latencyMs: number;
  /** Owner ids that get the slow scripted answers; empty -> nobody. */
  readonly owners: readonly string[];
}

export class ScriptedFakeLlm implements LlmPort {
  readonly #inner: LlmPort;
  readonly #latencyMs: number;
  readonly #owners: ReadonlySet<string>;

  constructor(options: ScriptedFakeLlmOptions) {
    this.#inner = options.inner;
    this.#latencyMs = Math.max(0, options.latencyMs);
    this.#owners = new Set(options.owners);
  }

  async complete(request: LlmCompleteRequest): Promise<LlmCompleteResponse> {
    if (request.ownerId === undefined || !this.#owners.has(request.ownerId)) {
      return this.#inner.complete(request);
    }
    request.onDispatch?.();
    await abortableDelay(this.#latencyMs, request.signal);
    return {
      output: scriptedFakeOutput(request.schemaId, request.input),
      usage: { inputTokens: 0, outputTokens: 0 },
      model: 'fake-llm',
      provider: 'fake',
      latencyMs: this.#latencyMs,
    };
  }
}
