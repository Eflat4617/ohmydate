import type { Id } from '@ohmydate/domain';
import { BudgetExceeded, type LlmSpendLedger } from '@ohmydate/llm';
import { sql, type Kysely, type Transaction } from 'kysely';
import type { Database } from '../db/types.js';

/**
 * The per-owner spend lock. Every ledger write and every agent_run cost write
 * derived from it (FU-76R-1 H1) takes it, so they are serialized per owner and
 * each sees the other's committed rows.
 */
export async function lockOwnerSpend(
  executor: Kysely<Database> | Transaction<Database>,
  ownerId: string,
): Promise<void> {
  await sql`select pg_advisory_xact_lock(hashtextextended(${ownerId}, 0))`.execute(executor);
}

/** What one ledger row costs right now: settled -> actual, open -> its reservation. */
export const LEDGER_ROW_COST = sql<string>`case when state = 'settled' then coalesce(actual_usd, reserved_usd) else reserved_usd end`;

/**
 * FU-76R-1 H1: the ledger is the single source of truth for a linked run's
 * cost and tokens. Rewrites agent_run from the sum of its (non-released)
 * ledger rows; a run with no linked rows is left as it is. Call inside a
 * transaction that holds `lockOwnerSpend(ownerId)`.
 */
export async function syncRunUsageFromLedger(
  trx: Transaction<Database>,
  ownerId: string,
  runId: string,
): Promise<void> {
  const rows = trx
    .selectFrom('llm_spend')
    .where('llm_spend.owner_id', '=', ownerId as Id)
    .where('llm_spend.agent_run_id', '=', runId as Id)
    .where('llm_spend.state', '!=', 'released');
  const summary = await rows
    .select([
      sql<string | null>`sum(${LEDGER_ROW_COST})`.as('cost'),
      sql<string | null>`sum(input_tokens)`.as('tokens_in'),
      sql<string | null>`sum(output_tokens)`.as('tokens_out'),
      sql<string>`count(*)`.as('n'),
    ])
    .executeTakeFirst();
  if (summary === undefined || Number(summary.n) === 0) return;
  await trx
    .updateTable('agent_run')
    .set({
      cost_usd: Number(summary.cost ?? 0).toFixed(6),
      tokens_in: Number(summary.tokens_in ?? 0),
      tokens_out: Number(summary.tokens_out ?? 0),
      updated_at: sql`now()`,
      version: sql<number>`version + 1`,
    } as never)
    .where('id', '=', runId as Id)
    .where('owner_id', '=', ownerId as Id)
    .execute();
}

/**
 * PostgreSQL spend ledger: one advisory-locked transaction reserves against
 * settled actual + open reserved rows, and settlement returns fresh totals so
 * an actual overrun blocks the next call while keeping the charge.
 */
export function createPgSpendLedger(db: Kysely<Database>): LlmSpendLedger {
  const totalsQuery = async (
    trx: Transaction<Database>,
    ownerId: string,
    dayStart: string,
    monthStart: string,
  ): Promise<{ dayUsd: number; monthUsd: number }> => {
    const row = await trx
      .selectFrom('llm_spend')
      .select([
        sql<string>`coalesce(sum(
          case when created_at >= ${dayStart}
            then case when state = 'settled' then coalesce(actual_usd, reserved_usd) else reserved_usd end
            else 0 end
        ), 0)`.as('day'),
        sql<string>`coalesce(sum(
          case when state = 'settled' then coalesce(actual_usd, reserved_usd) else reserved_usd end
        ), 0)`.as('month'),
      ])
      .where('owner_id', '=', ownerId as Id)
      .where('state', '!=', 'released')
      .where('created_at', '>=', new Date(monthStart))
      .executeTakeFirst();
    return { dayUsd: Number(row?.day ?? 0), monthUsd: Number(row?.month ?? 0) };
  };

  return {
    async reserve(input) {
      // FU-54: a budget rejection must not roll back the stale recovery done
      // under the same lock. The rejection is decided inside the transaction
      // (consistent totals) but thrown only after it has committed.
      let rejection: BudgetExceeded | undefined;
      await db.transaction().execute(async (trx) => {
        await lockOwnerSpend(trx, input.ownerId);
        // On-demand stale recovery: settle abandoned reservations at their
        // reserved amount inside the same lock. Never release them, because the
        // provider may already have billed the attempt.
        const staleCutoff = new Date(
          Date.parse(input.createdAt) - input.staleAfterMs,
        );
        const recovered = await trx
          .updateTable('llm_spend')
          .set({
            state: 'settled',
            actual_usd: sql`reserved_usd`,
            input_tokens: 0,
            output_tokens: 0,
            cached_tokens: 0,
            settled_at: new Date(input.createdAt),
            settle_reason: 'recovered',
          })
          .where('owner_id', '=', input.ownerId as Id)
          .where('state', '=', 'reserved')
          .where('created_at', '<', staleCutoff)
          .returning('agent_run_id')
          .execute();
        for (const runId of new Set(recovered.map((row) => row.agent_run_id))) {
          if (runId !== null) await syncRunUsageFromLedger(trx, input.ownerId, runId);
        }
        const spent = await totalsQuery(trx, input.ownerId, input.dayStart, input.monthStart);
        if (spent.dayUsd + input.estimateUsd > input.dailyLimitUsd) {
          rejection = new BudgetExceeded(
            'daily',
            input.dailyLimitUsd,
            spent.dayUsd,
            'projected_limit',
          );
          return;
        }
        if (spent.monthUsd + input.estimateUsd > input.monthlyLimitUsd) {
          rejection = new BudgetExceeded(
            'monthly',
            input.monthlyLimitUsd,
            spent.monthUsd,
            'projected_limit',
          );
          return;
        }
        await trx
          .insertInto('llm_spend')
          .values({
            id: input.id as Id,
            owner_id: input.ownerId as Id,
            purpose: input.purpose,
            state: 'reserved',
            reserved_usd: input.estimateUsd.toFixed(6),
            input_tokens: 0,
            output_tokens: 0,
            cached_tokens: 0,
            created_at: new Date(input.createdAt),
            ...(input.agentRunId === undefined ? {} : { agent_run_id: input.agentRunId as Id }),
          })
          .execute();
      });
      if (rejection !== undefined) throw rejection;
    },
    async settle(input) {
      let totals = { dayUsd: 0, monthUsd: 0 };
      await db.transaction().execute(async (trx) => {
        const existing = await trx
          .selectFrom('llm_spend')
          .select(['owner_id', 'agent_run_id'])
          .where('id', '=', input.id as Id)
          .executeTakeFirst();
        const ownerId = existing?.owner_id;
        if (ownerId === undefined) return;
        await lockOwnerSpend(trx, ownerId);
        await trx
          .updateTable('llm_spend')
          .set({
            state: 'settled',
            actual_usd: input.actualUsd.toFixed(6),
            input_tokens: input.inputTokens,
            output_tokens: input.outputTokens,
            cached_tokens: input.cachedTokens,
            settled_at: input.settledAt,
            settle_reason: input.reason ?? 'actual',
          })
          .where('id', '=', input.id as Id)
          .where('state', '=', 'reserved')
          .execute();
        // FU-76R-1 H1: the linked run's cost follows this settlement in the same
        // transaction, however late it lands after the caller stopped waiting.
        if (existing?.agent_run_id !== null && existing?.agent_run_id !== undefined) {
          await syncRunUsageFromLedger(trx, ownerId, existing.agent_run_id);
        }
        totals = await totalsQuery(trx, ownerId, input.dayStart, input.monthStart);
      });
      return totals;
    },
  };
}
