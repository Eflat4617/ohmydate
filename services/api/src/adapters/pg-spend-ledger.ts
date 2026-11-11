import type { Id } from '@ohmydate/domain';
import { BudgetExceeded, type LlmSpendLedger } from '@ohmydate/llm';
import { sql, type Kysely, type Transaction } from 'kysely';
import type { Database } from '../db/types.js';

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
        await sql`select pg_advisory_xact_lock(hashtextextended(${input.ownerId}, 0))`.execute(
          trx,
        );
        // On-demand stale recovery: settle abandoned reservations at their
        // reserved amount inside the same lock. Never release them, because the
        // provider may already have billed the attempt.
        const staleCutoff = new Date(
          Date.parse(input.createdAt) - input.staleAfterMs,
        );
        await trx
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
          .execute();
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
          .select('owner_id')
          .where('id', '=', input.id as Id)
          .executeTakeFirst();
        const ownerId = existing?.owner_id;
        if (ownerId === undefined) return;
        await sql`select pg_advisory_xact_lock(hashtextextended(${ownerId}, 0))`.execute(
          trx,
        );
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
        totals = await totalsQuery(trx, ownerId, input.dayStart, input.monthStart);
      });
      return totals;
    },
  };
}
