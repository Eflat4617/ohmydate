import {
  FakeLlm,
  LlmUnavailable,
  type LlmCompleteRequest,
  type LlmCompleteResponse,
  type LlmPort,
} from '@ohmydate/llm';

/**
 * E2E-only fake LLM scenarios (M6-03 scope amendment, coordinator-approved).
 *
 * `LLM_FAKE_SCENARIO=e2e-grounded` (+ `LLM_FAKE_SCENARIO_OWNERS`) is a fake-only
 * knob of the shared `assertFakeKnobsAllowed` guard (config.ts): honoured only
 * with `LLM_PROVIDER=fake`, rejected under `NODE_ENV=production`, for env and
 * programmatic configs alike. `createBaseFakeLlm` is the base LlmPort that
 * FU-76's `ScriptedFakeLlm` wraps (app.ts `fakeLlmFor`). It lets the real-API E2E suite drive the note-grounded intake
 * pipeline end to end without a provider:
 *
 * - `type_detection@v1` answers a schema-valid "new" classification so the
 *   session is not forced into manual mode before decomposition (no reasons:
 *   the deterministic detection keeps deciding);
 * - `decomposition@v2` (note-grounded) builds a schema-valid draft from the
 *   REQUEST INPUT: steps from the intake title, one `fact` evidence item that
 *   cites the first `<untrusted_document>` note block actually sent, one
 *   `inference` item that carries a planted link, and one item with a forged
 *   (never sent) reference. The real grounded sanitiser then strips the forged
 *   reference (`hallucinated_ref`) and the link (`[link removed]`).
 *
 * Every other prompt (including the ungrounded `decomposition@v1`) keeps the
 * default `FakeLlm` behaviour: no fixture, `LlmUnavailable`, manual draft.
 * With `LLM_FAKE_SCENARIO_OWNERS` the scenario answers only those owners, so
 * every other E2E suite keeps exactly the plain fake. Nothing here retains
 * prompt input.
 */

export const LLM_FAKE_SCENARIOS = ['e2e-grounded'] as const;
export type LlmFakeScenario = (typeof LLM_FAKE_SCENARIOS)[number];

export function isLlmFakeScenario(value: string): value is LlmFakeScenario {
  return (LLM_FAKE_SCENARIOS as readonly string[]).includes(value);
}

/** A reference the model "invents": never part of the sent sections. */
export const FORGED_DOC_ID = '01900000-0000-7000-8000-00000000f0f0';
export const FORGED_SECTION_HASH = 'f0f0f0f0f0f0f0f0';
/** A link the model copies into its output; the sanitiser must neutralise it. */
export const PLANTED_LINK = 'https://example.invalid/e2e-grounded-planted';

const SCENARIO_MODEL = 'fake-llm';
const NOTE_BLOCK =
  /<untrusted_document id="([A-Za-z0-9._:-]{1,128})" section="(\d{1,6})" hash="([0-9a-f]{16})">\n([\s\S]*?)\n<\/untrusted_document>/u;
const TASK_BLOCK = /<untrusted_document id="([A-Za-z0-9._:-]{1,128})">\n([\s\S]*?)\n<\/untrusted_document>/gu;

interface NoteBlock {
  readonly docId: string;
  readonly sectionHash: string;
  readonly content: string;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Undo the XML escaping of fenced content (a model quotes the note's words). */
function unescapeFenced(text: string): string {
  return text.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

function cut(text: string, max: number): string {
  const chars = Array.from(text.replace(/\s+/g, ' ').trim());
  return chars.length <= max ? chars.join('') : chars.slice(0, max).join('');
}

/** First note block of a grounded decomposition input (the order the builder sent). */
export function firstNoteBlock(input: unknown): NoteBlock | null {
  const notes = record(input)?.['notes'];
  if (!Array.isArray(notes)) return null;
  for (const block of notes) {
    if (typeof block !== 'string') continue;
    const match = NOTE_BLOCK.exec(block);
    if (match === null) continue;
    return { docId: match[1] as string, sectionHash: match[3] as string, content: match[4] as string };
  }
  return null;
}

function intakeTitle(input: unknown): string {
  const documents = record(input)?.['documents'];
  if (Array.isArray(documents)) {
    for (const block of documents) {
      if (typeof block !== 'string') continue;
      for (const match of block.matchAll(TASK_BLOCK)) {
        if (match[1] === 'intake-title') return cut(unescapeFenced(match[2] as string), 60);
      }
    }
  }
  return '과제';
}

/** The note's words without the `title: …\n---\n` header the context builder adds. */
function sectionText(content: string): string {
  const separator = content.indexOf('\n---\n');
  const body = separator === -1 ? content : content.slice(separator + 5);
  return unescapeFenced(body);
}

/** Schema-valid `llm.decomposition.v2` output built only from the request input. */
export function groundedDecompositionOutput(input: unknown): unknown {
  const note = firstNoteBlock(input);
  if (note === null) throw new LlmUnavailable('e2e-grounded scenario: no note block in the input');
  const title = intakeTitle(input);
  const quoted = cut(sectionText(note.content), 150);
  return {
    steps: [
      {
        key: 's1',
        title: cut(`${title} 자료 정리`, 120),
        deliverable: '참고 노트를 정리한 메모',
        doneCriteria: '노트의 핵심 내용을 목록으로 정리함',
        kind: 'prep',
        estimate: { p50Minutes: 30, p90Minutes: 45 },
        dependsOn: [],
        splittable: true,
      },
      {
        key: 's2',
        title: cut(`${title} 초안 작성`, 120),
        deliverable: '초안',
        doneCriteria: '정리한 내용을 모두 반영함',
        kind: 'work',
        estimate: { p50Minutes: 60, p90Minutes: 90 },
        dependsOn: ['s1'],
        splittable: true,
      },
      {
        key: 's3',
        title: cut(`${title} 검토`, 120),
        deliverable: '검토를 마친 결과물',
        doneCriteria: '빠진 부분이 없는지 확인함',
        kind: 'review',
        estimate: { p50Minutes: 20, p90Minutes: 30 },
        dependsOn: ['s2'],
        splittable: false,
      },
    ],
    assumptions: [],
    questionsRemaining: [],
    evidence: [
      {
        kind: 'fact',
        docId: note.docId,
        sectionHash: note.sectionHash,
        statement: cut(`노트에 적힌 내용: ${quoted}`, 200),
        stepKeys: ['s1', 's2'],
      },
      {
        kind: 'inference',
        docId: note.docId,
        sectionHash: note.sectionHash,
        statement: `노트 내용으로 보아 초안 전에 자료를 먼저 정리하는 편이 좋아요. 참고: ${PLANTED_LINK}`,
        stepKeys: ['s2'],
      },
      {
        kind: 'inference',
        docId: FORGED_DOC_ID,
        sectionHash: FORGED_SECTION_HASH,
        statement: '보내지 않은 노트를 근거로 한 추론',
        stepKeys: ['s3'],
      },
    ],
  };
}

const TYPE_DETECTION_OUTPUT = { classification: 'new', confidence: 0.5, reasons: [] } as const;

function respond(output: unknown): LlmCompleteResponse {
  return {
    output,
    usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
    model: SCENARIO_MODEL,
    latencyMs: 0,
  };
}

export interface FakeScenarioOptions {
  /** Owners the scenario answers; empty = every owner. Others get the fallback. */
  readonly owners?: readonly string[];
  /** What everything outside the scenario gets; default: a fixture-less `FakeLlm`. */
  readonly fallback?: LlmPort;
}

/** Deterministic responder for `LLM_FAKE_SCENARIO=e2e-grounded`. */
export class E2eGroundedFakeLlm implements LlmPort {
  readonly #fallback: LlmPort;
  readonly #owners: ReadonlySet<string>;

  constructor(options: FakeScenarioOptions = {}) {
    this.#owners = new Set(options.owners ?? []);
    this.#fallback = options.fallback ?? new FakeLlm();
  }

  #inScope(request: LlmCompleteRequest): boolean {
    return this.#owners.size === 0 || (request.ownerId !== undefined && this.#owners.has(request.ownerId));
  }

  async complete(request: LlmCompleteRequest): Promise<LlmCompleteResponse> {
    if (!this.#inScope(request)) return this.#fallback.complete(request);
    if (request.promptId === 'type_detection' && request.version === 'v1') {
      request.onDispatch?.();
      return respond({ ...TYPE_DETECTION_OUTPUT, reasons: [] });
    }
    if (request.promptId === 'decomposition' && request.version === 'v2') {
      // Simulated provider boundary: the note sections "leave" here.
      request.onDispatch?.();
      return respond(groundedDecompositionOutput(request.input));
    }
    return this.#fallback.complete(request);
  }
}

export function createFakeScenarioLlm(scenario: LlmFakeScenario, options: FakeScenarioOptions = {}): LlmPort {
  switch (scenario) {
    case 'e2e-grounded':
      return new E2eGroundedFakeLlm(options);
  }
}

/**
 * The fake provider's base LlmPort (`LLM_PROVIDER=fake`): the plain
 * fixture-less `FakeLlm`, or the configured scenario scoped to its owners.
 * Self-contained so other fake layers (e.g. FU-76's scripted owners) can wrap
 * this base instead of replacing it.
 */
export function createBaseFakeLlm(options: {
  readonly scenario: LlmFakeScenario | null;
  readonly owners?: readonly string[];
  readonly fallback?: LlmPort;
}): LlmPort {
  const fallback = options.fallback ?? new FakeLlm();
  if (options.scenario === null) return fallback;
  return createFakeScenarioLlm(options.scenario, { owners: options.owners ?? [], fallback });
}
