import type { Id } from '@ohmydate/domain';
import { sql, type Kysely } from 'kysely';
import type { Database, JsonValue } from '../db/types.js';
import { jsonb } from '../db/types.js';
import {
  draftKind,
  type AgentProposalInput,
  type AgentRunInput,
  type AgentRunRepository,
  type StoredDraft,
} from '../application/intake/ports.js';

interface DraftPayload {
  readonly draft?: unknown;
  readonly issues?: readonly { readonly code: string; readonly message: string }[];
}

function parsePayload(value: JsonValue): DraftPayload {
  return (value ?? {}) as unknown as DraftPayload;
}

export class PgAgentRunRepository implements AgentRunRepository {
  readonly #db: Kysely<Database>;

  constructor(db: Kysely<Database>) {
    this.#db = db;
  }

  async recordRun(input: AgentRunInput): Promise<void> {
    await this.#db
      .insertInto('agent_run')
      .values({
        id: input.id,
        owner_id: input.ownerId,
        purpose: input.purpose,
        prompt_id_version: input.promptIdVersion,
        model: input.model,
        provider: input.provider,
        tokens_in: input.tokensIn,
        tokens_out: input.tokensOut,
        cost_usd: input.costUsd.toFixed(6),
        latency_ms: input.latencyMs,
        status: input.status,
        redaction_report: jsonb(input.redactionReport as unknown as JsonValue),
      })
      .execute();
  }

  async saveDraft(input: AgentProposalInput): Promise<void> {
    await this.#db
      .insertInto('agent_proposal')
      .values({
        id: input.id,
        owner_id: input.ownerId,
        run_id: input.runId,
        kind: input.kind,
        payload: jsonb(input.payload),
        schema_ok: input.schemaOk,
        policy_ok: input.policyOk,
        constraint_ok: input.constraintOk,
        decision: input.decision,
      })
      .execute();
  }

  async updateDraft(
    ownerId: Id,
    sessionId: Id,
    input: {
      readonly draft: unknown;
      readonly schemaOk: boolean;
      readonly policyOk: boolean;
      readonly constraintOk: boolean;
      readonly issues: readonly { readonly code: string; readonly message: string }[];
    },
  ): Promise<void> {
    const latest = await this.#latest(ownerId, sessionId);
    if (latest === undefined) return;
    await this.#db
      .updateTable('agent_proposal')
      .set({
        payload: jsonb({
          draft: input.draft,
          issues: input.issues,
        } as unknown as JsonValue),
        schema_ok: input.schemaOk,
        policy_ok: input.policyOk,
        constraint_ok: input.constraintOk,
        updated_at: sql<Date>`now()`,
        version: sql<number>`version + 1`,
      })
      .where('id', '=', latest.id)
      .where('owner_id', '=', ownerId)
      .execute();
  }

  async loadDraft(ownerId: Id, sessionId: Id): Promise<StoredDraft | null> {
    const latest = await this.#latest(ownerId, sessionId);
    if (latest === undefined) return null;
    const payload = parsePayload(latest.payload);
    if (payload.draft === undefined || payload.draft === null) return null;
    return {
      draft: payload.draft as StoredDraft['draft'],
      proposalId: latest.id as Id,
      runId: latest.run_id as Id,
      version: latest.version,
      constraintOk: latest.constraint_ok,
      policyOk: latest.policy_ok,
      issues: payload.issues ?? [],
    };
  }

  async markDraftDecision(
    ownerId: Id,
    sessionId: Id,
    decision: 'approved' | 'rejected' | 'expired',
  ): Promise<void> {
    const latest = await this.#latest(ownerId, sessionId);
    if (latest === undefined) return;
    await this.#db
      .updateTable('agent_proposal')
      .set({
        decision,
        updated_at: sql<Date>`now()`,
        version: sql<number>`version + 1`,
      })
      .where('id', '=', latest.id)
      .where('owner_id', '=', ownerId)
      .execute();
  }

  async #latest(
    ownerId: Id,
    sessionId: Id,
  ): Promise<
    | {
        readonly id: string;
        readonly run_id: string;
        readonly version: number;
        readonly constraint_ok: boolean;
        readonly policy_ok: boolean;
        readonly payload: JsonValue;
      }
    | undefined
  > {
    return this.#db
      .selectFrom('agent_proposal')
      .select(['id', 'run_id', 'version', 'constraint_ok', 'policy_ok', 'payload'])
      .where('owner_id', '=', ownerId)
      .where('kind', '=', draftKind(sessionId))
      .orderBy('created_at', 'desc')
      .orderBy('id', 'desc')
      .limit(1)
      .executeTakeFirst();
  }
}
