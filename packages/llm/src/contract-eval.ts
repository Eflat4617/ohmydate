/**
 * Live output-contract smoke core (M6-01 fix round 1 addendum).
 *
 * Used by the coordinator-only script scripts/eval/contract-live.mts and unit-tested
 * with FakeLlm. For every registered prompt it sends N benign synthetic inputs through
 * `runStructured` (generated contract in the system prompt, per-prompt limits, one
 * repair) and reports metadata only: schema-valid rate, attempts/repairs, tokens and
 * latency per prompt. Never prompt text, model output or provider error text.
 *
 * Verdict: `pass` (exit 0) when every planned call was answered schema-valid (after
 * at most the single repair); `invalid` (exit 1) when any answered call stayed
 * schema-invalid; otherwise `inconclusive` (exit 3) for operational errors or a
 * budget stop (the remaining calls are `not_run`).
 */

import type { BudgetGuard } from './budget.js';
import { LlmError } from './errors.js';
import { classifyFailure } from './injection-eval.js';
import { buildNoteContext } from './note-context.js';
import { schemaIdForPrompt } from './output-contract.js';
import type { LlmPort } from './port.js';
import type { PromptLimitOverrides } from './prompt-limits.js';
import { buildUntrustedBlock } from './privacy.js';
import { listPromptKeys } from './prompt-registry.js';
import { runStructured } from './run-structured.js';

const OWNER = '0193a8f2-6c1e-7b41-9a2e-1f1d6a0b0f11';
const NOTE_ID = '0193a8f2-6c1e-7b41-9a2e-1f1d6a0b0d11';

const TASKS: readonly { readonly title: string; readonly deliverable: string; readonly note: string }[] = [
  {
    title: 'Write the quarterly report',
    deliverable: 'A ten-page report with charts for the Q3 review',
    note: 'Finance sends the Q3 numbers on Monday. The review meeting is on the 20th.',
  },
  {
    title: '학회 발표 준비',
    deliverable: '15분 발표 슬라이드와 발표 원고',
    note: '발표는 15분, 질의응답 5분. 지도교수 검토를 한 번 받아야 한다.',
  },
  {
    title: 'Plan the kitchen renovation',
    deliverable: 'A budget and a contractor shortlist',
    note: 'Budget limit is 8,000. Two contractors already sent quotes.',
  },
  {
    title: '통계 시험 공부',
    deliverable: '기출 문제 3회분 풀이와 오답 노트',
    note: '시험 범위는 회귀 분석과 가설 검정. 하루 두 시간 공부 가능.',
  },
  {
    title: 'Organise the team offsite',
    deliverable: 'Venue booking, agenda and travel plan',
    note: 'Twelve people, two days, budget approved last week.',
  },
];

function task(index: number): (typeof TASKS)[number] {
  return TASKS[index % TASKS.length] as (typeof TASKS)[number];
}

function taskDocuments(index: number): string[] {
  const entry = task(index);
  return [
    buildUntrustedBlock('intake-title', entry.title),
    buildUntrustedBlock('intake-deliverable', entry.deliverable),
  ];
}

/**
 * Benign synthetic input per registered prompt key, shaped like the production
 * inputs (services/api intake builders) where a production caller exists.
 */
export const CONTRACT_SMOKE_INPUTS: Readonly<Record<string, (index: number) => unknown>> = {
  'type_detection@v1': (index) => ({
    configVersion: 'intake-agent-config@1',
    knownFields: ['deliverable', 'title'],
    task: { estimatedScope: 'medium' },
    candidates: [],
    documents: taskDocuments(index),
  }),
  'decomposition@v1': (index) => ({
    configVersion: 'intake-agent-config@1',
    task: { estimatedScope: 'medium', dueAt: '2026-12-01T00:00:00.000Z', currentProgress: 0 },
    template: null,
    documents: taskDocuments(index),
  }),
  'decomposition@v2': (index) => {
    const entry = task(index);
    const context = buildNoteContext({
      ownerId: OWNER,
      query: `${entry.title} ${entry.deliverable}`,
      documents: [
        {
          id: NOTE_ID,
          ownerId: OWNER,
          title: 'Background',
          bodyMd: entry.note,
          llmAllowed: true,
          version: 1,
          updatedAt: '2026-11-12T00:00:00.000Z',
        },
      ],
    });
    return {
      configVersion: 'intake-agent-config@1',
      task: { estimatedScope: 'medium', dueAt: '2026-12-01T00:00:00.000Z', currentProgress: 0 },
      template: null,
      documents: taskDocuments(index),
      notes: context.blocks,
    };
  },
  'questions@v1': (index) => ({
    configVersion: 'intake-agent-config@1',
    knownFields: ['title', 'deliverable'],
    missingRequired: ['dueAt', 'estimatedScope', 'currentProgress'],
    documents: taskDocuments(index),
  }),
  'replan_explanation@v1': (index) => ({
    trigger: { kind: 'deadline_risk', reason: 'deadline_slack_negative' },
    task: { titleRef: `task-${index}` },
    before: { slackMinutes: -90, plannedFocusMinutes: 300 },
    after: { slackMinutes: 120, plannedFocusMinutes: 330, changedBlocks: 2 },
  }),
  'layout_suggestion@v1': (index) => ({
    policyVersion: 'ui-policy@1',
    context: {
      route: index % 2 === 0 ? 'today' : 'planning',
      activeSession: index % 2 === 0,
      deadlineRiskCount: index % 3,
      viewport: 'desktop',
    },
  }),
};

export type ContractCallOutcome =
  | {
      readonly status: 'valid';
      readonly prompt: string;
      readonly attempts: number;
      readonly repairs: number;
      readonly inputTokens: number;
      readonly outputTokens: number;
      readonly latencyMs: number;
    }
  | {
      readonly status: 'invalid';
      readonly prompt: string;
      readonly attempts: number;
      readonly inputTokens: number;
      readonly outputTokens: number;
      readonly latencyMs: number;
    }
  | { readonly status: 'error'; readonly prompt: string; readonly errorCode: string; readonly latencyMs: number }
  | { readonly status: 'not_run'; readonly prompt: string; readonly reason: 'budget_stop' };

export interface PromptContractStats {
  readonly prompt: string;
  readonly schemaId: string;
  readonly planned: number;
  readonly valid: number;
  readonly invalid: number;
  readonly errored: number;
  readonly notRun: number;
  /** valid / (valid + invalid); null when nothing was answered. */
  readonly validRate: number | null;
  readonly attempts: number;
  readonly repairs: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly latencyMsP50: number | null;
  readonly latencyMsMax: number | null;
  readonly errorCodes: Readonly<Record<string, number>>;
}

export type ContractVerdict = 'pass' | 'invalid' | 'inconclusive';

export interface ContractSmokeSummary {
  readonly prompts: readonly PromptContractStats[];
  readonly planned: number;
  readonly valid: number;
  readonly invalid: number;
  readonly errored: number;
  readonly notRun: number;
  readonly verdict: ContractVerdict;
  readonly exitCode: 0 | 1 | 3;
}

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor((sorted.length - 1) / 2)] as number;
}

/** Pure: per-prompt statistics and the overall verdict. */
export function summarizeContractOutcomes(outcomes: readonly ContractCallOutcome[]): ContractSmokeSummary {
  const byPrompt = new Map<string, ContractCallOutcome[]>();
  for (const outcome of outcomes) byPrompt.set(outcome.prompt, [...(byPrompt.get(outcome.prompt) ?? []), outcome]);
  const prompts: PromptContractStats[] = [...byPrompt.entries()].map(([prompt, calls]) => {
    const [promptId, version] = prompt.split('@') as [string, string];
    const answered = calls.filter((call) => call.status === 'valid' || call.status === 'invalid');
    const errorCodes: Record<string, number> = {};
    for (const call of calls) if (call.status === 'error') errorCodes[call.errorCode] = (errorCodes[call.errorCode] ?? 0) + 1;
    const valid = calls.filter((call) => call.status === 'valid').length;
    const latencies = calls.flatMap((call) => ('latencyMs' in call ? [call.latencyMs] : []));
    return {
      prompt,
      schemaId: schemaIdForPrompt(promptId, version),
      planned: calls.length,
      valid,
      invalid: calls.filter((call) => call.status === 'invalid').length,
      errored: calls.filter((call) => call.status === 'error').length,
      notRun: calls.filter((call) => call.status === 'not_run').length,
      validRate: answered.length === 0 ? null : valid / answered.length,
      attempts: answered.reduce((sum, call) => sum + call.attempts, 0),
      repairs: calls.reduce((sum, call) => sum + (call.status === 'valid' ? call.repairs : call.status === 'invalid' ? 1 : 0), 0),
      inputTokens: answered.reduce((sum, call) => sum + call.inputTokens, 0),
      outputTokens: answered.reduce((sum, call) => sum + call.outputTokens, 0),
      latencyMsP50: median(latencies),
      latencyMsMax: latencies.length === 0 ? null : Math.max(...latencies),
      errorCodes,
    };
  });
  const total = (key: 'valid' | 'invalid' | 'errored' | 'notRun'): number =>
    prompts.reduce((sum, stats) => sum + stats[key], 0);
  const valid = total('valid');
  const invalid = total('invalid');
  const errored = total('errored');
  const notRun = total('notRun');
  const verdict: ContractVerdict =
    invalid > 0 ? 'invalid' : outcomes.length > 0 && errored === 0 && notRun === 0 ? 'pass' : 'inconclusive';
  return {
    prompts,
    planned: outcomes.length,
    valid,
    invalid,
    errored,
    notRun,
    verdict,
    exitCode: verdict === 'pass' ? 0 : verdict === 'invalid' ? 1 : 3,
  };
}

export async function runContractSmoke(input: {
  readonly port: LlmPort;
  readonly guard: BudgetGuard;
  /** Calls per prompt (1..10). */
  readonly runsPerPrompt: number;
  /** Defaults to every registered prompt. */
  readonly promptKeys?: readonly string[];
  readonly promptLimits?: PromptLimitOverrides;
  readonly now?: () => number;
}): Promise<ContractSmokeSummary> {
  if (!Number.isInteger(input.runsPerPrompt) || input.runsPerPrompt < 1 || input.runsPerPrompt > 10) {
    throw new RangeError('runsPerPrompt must be an integer in 1..10');
  }
  const now = input.now ?? Date.now;
  const keys = input.promptKeys ?? listPromptKeys();
  const outcomes: ContractCallOutcome[] = [];
  let stopped = false;
  for (const prompt of keys) {
    const build = CONTRACT_SMOKE_INPUTS[prompt];
    if (build === undefined) throw new Error(`no synthetic contract input for ${prompt}`);
    const [promptId, version] = prompt.split('@') as [string, string];
    for (let index = 0; index < input.runsPerPrompt; index += 1) {
      if (stopped) {
        outcomes.push({ status: 'not_run', prompt, reason: 'budget_stop' });
        continue;
      }
      const started = now();
      try {
        const result = await runStructured(
          input.port,
          {
            promptId,
            version,
            input: build(index),
            schemaId: schemaIdForPrompt(promptId, version),
            ownerId: OWNER,
            sessionKey: `contract-${prompt}-${index}`,
          },
          { budgetGuard: input.guard, ...(input.promptLimits === undefined ? {} : { promptLimits: input.promptLimits }) },
        );
        outcomes.push({
          status: 'valid',
          prompt,
          attempts: result.attempts,
          repairs: result.repairs,
          inputTokens: result.usage.inputTokens,
          outputTokens: result.usage.outputTokens,
          latencyMs: Math.max(0, now() - started),
        });
      } catch (error) {
        const failure = classifyFailure(error);
        const latencyMs = Math.max(0, now() - started);
        if (failure.kind === 'answered_invalid') {
          const usage = error instanceof LlmError ? error.usage : undefined;
          outcomes.push({
            status: 'invalid',
            prompt,
            attempts: 2,
            inputTokens: usage?.inputTokens ?? 0,
            outputTokens: usage?.outputTokens ?? 0,
            latencyMs,
          });
        } else {
          outcomes.push({ status: 'error', prompt, errorCode: failure.errorCode, latencyMs });
          stopped = failure.stop;
        }
      }
    }
  }
  return summarizeContractOutcomes(outcomes);
}
