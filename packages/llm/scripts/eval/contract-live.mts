/**
 * COORDINATOR-ONLY live output-contract smoke (M6-01 fix round 1 addendum).
 *
 * Sends N benign synthetic inputs per registered prompt through the REAL gateway with
 * the production structured-call path (generated output contract in the system prompt,
 * per-prompt limits such as decomposition 8000 tokens / 120 s, one repair) and reports
 * the schema-valid rate, attempts/repairs, tokens and latency per prompt. The core
 * (inputs, runner, verdict) is src/contract-eval.ts, unit-tested with FakeLlm in
 * test/contract-eval.test.ts; this file only does configuration and I/O.
 *
 * - Never run in CI and never by workers: refuses when `CI` is set or when
 *   `CONTRACT_LIVE_CONFIRM=1` is missing. Not a test file, so Vitest never loads it.
 * - The key is read only from `LLM_API_KEY_FILE` (absolute path, mode 600) and is never
 *   printed. The report is metadata only: prompt keys, counts, rates, error codes,
 *   tokens and latency — no prompts, no model output, no provider error text.
 * - Spend is capped by a BudgetGuard (`CONTRACT_LIVE_MAX_USD`, default 0.25); a budget
 *   stop marks the remaining calls `not_run`.
 *
 * Usage (from the repo root, coordinator shell):
 *   CONTRACT_LIVE_CONFIRM=1 LLM_API_KEY_FILE=/abs/path/to/key.txt \
 *     corepack pnpm --filter @ohmydate/api exec tsx ../../packages/llm/scripts/eval/contract-live.mts \
 *     [--out /abs/path/report.json]
 * Optional env: LLM_BASE_URL, LLM_MODEL, LLM_REASONING_EFFORT, CONTRACT_LIVE_MAX_USD,
 *   CONTRACT_LIVE_RUNS (calls per prompt, 1..10, default 3),
 *   CONTRACT_LIVE_PROMPTS (comma-separated prompt keys, default: every registered prompt),
 *   LLM_DECOMPOSITION_MAX_OUTPUT_TOKENS / LLM_DECOMPOSITION_TIMEOUT_MS (defaults 8000 / 120000).
 *
 * Exit codes: 0 pass (every call schema-valid), 1 invalid (an answered call stayed
 * schema-invalid after the repair), 3 inconclusive (operational errors or budget stop),
 * 2 setup error.
 */

import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import {
  BudgetGuard,
  DEFAULT_DECOMPOSITION_MAX_OUTPUT_TOKENS,
  DEFAULT_DECOMPOSITION_TIMEOUT_MS,
  OpenAICompatibleLlm,
  listPromptKeys,
} from '../../src/index.js';
import { runContractSmoke } from '../../src/contract-eval.js';

function fail(message: string): never {
  console.error(`contract-live: ${message}`);
  process.exit(2);
}

function readKey(): string {
  const path = process.env['LLM_API_KEY_FILE'];
  if (path === undefined || !isAbsolute(path)) fail('LLM_API_KEY_FILE must be an absolute path');
  const stat = statSync(path);
  if ((stat.mode & 0o077) !== 0) fail('LLM_API_KEY_FILE must not be group- or world-accessible');
  const key = readFileSync(path, 'utf8').trim();
  if (key.length === 0) fail('LLM_API_KEY_FILE is empty');
  return key;
}

function positiveInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isInteger(value) || value <= 0) fail(`${name} must be a positive integer`);
  return value;
}

async function main(): Promise<void> {
  if (process.env['CI'] !== undefined && process.env['CI'] !== '') fail('refusing to run under CI');
  if (process.env['CONTRACT_LIVE_CONFIRM'] !== '1') fail('set CONTRACT_LIVE_CONFIRM=1 (coordinator only)');

  const maxUsd = Number(process.env['CONTRACT_LIVE_MAX_USD'] ?? '0.25');
  if (!Number.isFinite(maxUsd) || maxUsd <= 0) fail('CONTRACT_LIVE_MAX_USD must be a positive number');
  const runsPerPrompt = positiveInt('CONTRACT_LIVE_RUNS', 3);
  if (runsPerPrompt > 10) fail('CONTRACT_LIVE_RUNS must be at most 10');
  const registered = listPromptKeys();
  const requested = process.env['CONTRACT_LIVE_PROMPTS'];
  const promptKeys =
    requested === undefined || requested.trim() === ''
      ? registered
      : requested.split(',').map((key) => key.trim());
  for (const key of promptKeys) if (!registered.includes(key)) fail(`unknown prompt ${key}`);

  const model = process.env['LLM_MODEL'] ?? 'deepseek-v4.1-flash';
  const port = new OpenAICompatibleLlm({
    baseUrl: process.env['LLM_BASE_URL'] ?? 'https://opencode.ai/inference/go/openai/v1',
    apiKey: readKey(),
    model,
    provider: 'deepseek',
    reasoningEffort: process.env['LLM_REASONING_EFFORT'] ?? 'medium',
  });
  const summary = await runContractSmoke({
    port,
    guard: new BudgetGuard({ dailyUsd: maxUsd, monthlyUsd: maxUsd }),
    runsPerPrompt,
    promptKeys,
    promptLimits: {
      decomposition: {
        maxOutputTokens: positiveInt('LLM_DECOMPOSITION_MAX_OUTPUT_TOKENS', DEFAULT_DECOMPOSITION_MAX_OUTPUT_TOKENS),
        timeoutMs: positiveInt('LLM_DECOMPOSITION_TIMEOUT_MS', DEFAULT_DECOMPOSITION_TIMEOUT_MS),
      },
    },
  });
  const report = { eval: 'm6-01-contract-live', model, runsPerPrompt, ...summary };
  const outIndex = process.argv.indexOf('--out');
  const out = outIndex >= 0 ? process.argv[outIndex + 1] : undefined;
  if (out !== undefined) {
    if (!isAbsolute(out)) fail('--out must be an absolute path');
    writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  }
  console.log(JSON.stringify(report, null, 2));
  process.exit(summary.exitCode);
}

try {
  await main();
} catch (error) {
  fail(error instanceof Error ? error.name : 'unexpected setup error');
}
