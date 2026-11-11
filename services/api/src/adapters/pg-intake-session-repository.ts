import type {
  DecompositionDraftDto,
  IntakeAnswer as ContractIntakeAnswer,
  IntakeDetectedType,
  IntakeError as IntakeErrorDto,
  IntakeInput,
} from '@ohmydate/contracts';
import type { Clock, Id, IdGenerator, Instant, IntakeState } from '@ohmydate/domain';
import { NotFoundError, VersionConflictError } from '@ohmydate/domain';
import { sql, type Kysely, type Selectable } from 'kysely';
import type { Database, IntakeAnswerTable, IntakeSessionTable, JsonValue } from '../db/types.js';
import { draftKind } from '../application/intake/ports.js';
import { jsonb } from '../db/types.js';
import { requireIntakeSessionXactLock } from './intake-session-advisory.js';
import type {
  IntakeAnswerRecord,
  IntakeSessionRecord,
  IntakeSessionRepository,
  IntakeSessionUpdate,
} from '../application/intake/ports.js';

type SessionRow = Selectable<IntakeSessionTable>;
type AnswerRow = Selectable<IntakeAnswerTable>;

function toInstant(value: Date | string): Instant {
  return (value instanceof Date ? value.toISOString() : value) as Instant;
}

export function mapSession(row: SessionRow): IntakeSessionRecord {
  return {
    id: row.id as Id,
    ownerId: row.owner_id as Id,
    ...(row.goal_id === null ? {} : { goalId: row.goal_id as Id }),
    state: row.state as IntakeState,
    input: row.input as unknown as IntakeInput,
    ...(row.detected_type === null
      ? {}
      : { detectedType: row.detected_type as unknown as IntakeDetectedType }),
    ...(row.template_id === null ? {} : { templateId: row.template_id as Id }),
    round: row.round,
    manual: row.manual,
    ...(row.error === null ? {} : { error: row.error as unknown as IntakeErrorDto }),
    version: row.version,
    createdAt: toInstant(row.created_at),
    updatedAt: toInstant(row.updated_at),
  };
}

interface StoredAnswer {
  readonly action: ContractIntakeAnswer['action'];
  readonly value?: unknown;
}

function mapAnswer(row: AnswerRow): IntakeAnswerRecord {
  const stored = (row.answer ?? { action: 'skip' }) as unknown as StoredAnswer;
  return {
    field: row.question_key,
    action: stored.action,
    ...(stored.value === undefined ? {} : { value: stored.value }),
    questionText: row.question_text,
    skipped: row.skipped,
    createdAt: toInstant(row.created_at),
  };
}

export class PgIntakeSessionRepository implements IntakeSessionRepository {
  readonly #db: Kysely<Database>;
  readonly #clock: Clock;
  readonly #ids: IdGenerator;

  constructor(db: Kysely<Database>, clock: Clock, ids: IdGenerator) {
    this.#db = db;
    this.#clock = clock;
    this.#ids = ids;
  }

  async create(record: IntakeSessionRecord): Promise<IntakeSessionRecord> {
    const row = await this.#db
      .insertInto('intake_session')
      .values({
        id: record.id,
        owner_id: record.ownerId,
        goal_id: record.goalId ?? null,
        state: record.state,
        input: jsonb(record.input as unknown as JsonValue),
        detected_type:
          record.detectedType === undefined
            ? null
            : jsonb(record.detectedType as unknown as JsonValue),
        template_id: record.templateId ?? null,
        round: record.round,
        manual: record.manual,
        error: record.error === undefined ? null : jsonb(record.error as unknown as JsonValue),
        version: record.version,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    return mapSession(row);
  }

  async get(ownerId: Id, id: Id): Promise<IntakeSessionRecord | null> {
    const row = await this.#db
      .selectFrom('intake_session')
      .selectAll()
      .where('id', '=', id)
      .where('owner_id', '=', ownerId)
      .executeTakeFirst();
    return row === undefined ? null : mapSession(row);
  }

  async update(
    ownerId: Id,
    id: Id,
    patch: IntakeSessionUpdate,
    expectedVersion: number,
  ): Promise<IntakeSessionRecord> {
    return this.#db.transaction().execute(async (trx) => {
      await requireIntakeSessionXactLock(trx, id);
      const set: Record<string, unknown> = {
        updated_at: new Date(this.#clock.now()),
        version: sql<number>`version + 1`,
      };
      if (patch.state !== undefined) set['state'] = patch.state;
      if (patch.input !== undefined) set['input'] = jsonb(patch.input as unknown as JsonValue);
      if ('detectedType' in patch) {
        set['detected_type'] =
          patch.detectedType === null || patch.detectedType === undefined
            ? null
            : jsonb(patch.detectedType as unknown as JsonValue);
      }
      if ('templateId' in patch) set['template_id'] = patch.templateId ?? null;
      if (patch.round !== undefined) set['round'] = patch.round;
      if (patch.manual !== undefined) set['manual'] = patch.manual;
      if ('error' in patch) {
        set['error'] =
          patch.error === null || patch.error === undefined
            ? null
            : jsonb(patch.error as unknown as JsonValue);
      }

      const updated = await trx
        .updateTable('intake_session')
        .set(set as never)
        .where('id', '=', id)
        .where('owner_id', '=', ownerId)
        .where('version', '=', expectedVersion)
        .returningAll()
        .executeTakeFirst();

      if (updated !== undefined) return mapSession(updated);

      const current = await trx
        .selectFrom('intake_session')
        .select('version')
        .where('id', '=', id)
        .where('owner_id', '=', ownerId)
        .executeTakeFirst();
      if (current === undefined) throw new NotFoundError('intake session', id);
      throw new VersionConflictError(expectedVersion as never, current.version as never);
    });
  }

  async markStaleAiRuns(cutoff: Instant, error: IntakeErrorDto): Promise<number> {
    const result = await this.#db
      .updateTable('intake_session')
      .set({
        error: jsonb(error as unknown as JsonValue),
        // An interrupted type detection keeps its deterministic result path in
        // manual mode; a decomposition stays AI-recoverable (POST :resume).
        manual: sql<boolean>`case when state = 'type_detection' then true else manual end`,
        updated_at: new Date(this.#clock.now()),
        version: sql<number>`version + 1`,
      } as never)
      .where('updated_at', '<', new Date(cutoff))
      .where('error', 'is', null)
      .where((eb) =>
        eb.or([
          eb.and([
            eb('state', '=', 'decomposition'),
            eb('manual', '=', false),
            eb.not(
              eb.exists(
                eb
                  .selectFrom('agent_proposal')
                  .select(sql`1`.as('one'))
                  .whereRef('agent_proposal.owner_id', '=', 'intake_session.owner_id')
                  .where(
                    'agent_proposal.kind',
                    '=',
                    sql<string>`${draftKind('' as Id)} || intake_session.id::text`,
                  ),
              ),
            ),
          ]),
          eb.and([eb('state', '=', 'type_detection'), eb('detected_type', 'is', null)]),
        ]),
      )
      .executeTakeFirst();
    return Number(result.numUpdatedRows);
  }

  async createGoal(ownerId: Id, goalId: Id, title: string): Promise<void> {
    await this.#db
      .insertInto('goal')
      .values({ id: goalId, owner_id: ownerId, title })
      .execute();
  }

  async goalExists(ownerId: Id, goalId: Id): Promise<boolean> {
    const row = await this.#db
      .selectFrom('goal')
      .select('id')
      .where('id', '=', goalId)
      .where('owner_id', '=', ownerId)
      .executeTakeFirst();
    return row !== undefined;
  }

  #answerValues(
    ownerId: Id,
    sessionId: Id,
    answers: readonly IntakeAnswerRecord[],
  ): {
    id: Id;
    owner_id: Id;
    session_id: Id;
    question_key: string;
    question_text: string;
    answer: ReturnType<typeof jsonb>;
    skipped: boolean;
  }[] {
    return answers.map((answer) => ({
      id: this.#ids.next(),
      owner_id: ownerId,
      session_id: sessionId,
      question_key: answer.field,
      question_text: answer.questionText,
      answer: jsonb({
        action: answer.action,
        ...(answer.value === undefined ? {} : { value: answer.value as JsonValue }),
      } as unknown as JsonValue),
      skipped: answer.skipped,
    }));
  }

  async listAnswers(ownerId: Id, sessionId: Id): Promise<readonly IntakeAnswerRecord[]> {
    const rows = await this.#db
      .selectFrom('intake_answer')
      .selectAll()
      .where('owner_id', '=', ownerId)
      .where('session_id', '=', sessionId)
      .orderBy('created_at', 'asc')
      .orderBy('id', 'asc')
      .execute();
    return rows.map(mapAnswer);
  }

  async appendAnswers(
    ownerId: Id,
    sessionId: Id,
    answers: readonly IntakeAnswerRecord[],
  ): Promise<void> {
    if (answers.length === 0) return;
    await this.#db
      .insertInto('intake_answer')
      .values(this.#answerValues(ownerId, sessionId, answers))
      .execute();
  }

  async appendAnswersAndUpdate(
    ownerId: Id,
    sessionId: Id,
    answers: readonly IntakeAnswerRecord[],
    patch: IntakeSessionUpdate,
    expectedVersion: number,
  ): Promise<IntakeSessionRecord> {
    return this.#db.transaction().execute(async (trx) => {
      await requireIntakeSessionXactLock(trx, sessionId);
      const session = await trx
        .selectFrom('intake_session')
        .selectAll()
        .where('id', '=', sessionId)
        .where('owner_id', '=', ownerId)
        .forUpdate()
        .executeTakeFirst();
      if (session === undefined) throw new NotFoundError('intake session', sessionId);
      if (session.version !== expectedVersion) {
        throw new VersionConflictError(expectedVersion as never, session.version as never);
      }
      if (answers.length > 0) {
        await trx
          .insertInto('intake_answer')
          .values(this.#answerValues(ownerId, sessionId, answers))
          .execute();
      }
      const set: Record<string, unknown> = {
        updated_at: new Date(this.#clock.now()),
        version: sql<number>`version + 1`,
      };
      if (patch.state !== undefined) set['state'] = patch.state;
      if (patch.input !== undefined) set['input'] = jsonb(patch.input as unknown as JsonValue);
      if ('detectedType' in patch) {
        set['detected_type'] =
          patch.detectedType === null || patch.detectedType === undefined
            ? null
            : jsonb(patch.detectedType as unknown as JsonValue);
      }
      if ('templateId' in patch) set['template_id'] = patch.templateId ?? null;
      if (patch.round !== undefined) set['round'] = patch.round;
      if (patch.manual !== undefined) set['manual'] = patch.manual;
      if ('error' in patch) {
        set['error'] =
          patch.error === null || patch.error === undefined
            ? null
            : jsonb(patch.error as unknown as JsonValue);
      }
      const updated = await trx
        .updateTable('intake_session')
        .set(set as never)
        .where('id', '=', sessionId)
        .where('owner_id', '=', ownerId)
        .where('version', '=', expectedVersion)
        .returningAll()
        .executeTakeFirst();
      if (updated === undefined) {
        throw new VersionConflictError(expectedVersion as never, expectedVersion as never);
      }
      return mapSession(updated);
    });
  }

  async patchDraftAndUpdate(
    ownerId: Id,
    sessionId: Id,
    input: {
      readonly draft: DecompositionDraftDto;
      readonly schemaOk: boolean;
      readonly policyOk: boolean;
      readonly constraintOk: boolean;
      readonly issues: readonly { readonly code: string; readonly message: string }[];
      readonly editedEstimateKeys: readonly string[];
    },
    expectedVersion: number,
  ): Promise<IntakeSessionRecord> {
    return this.#db.transaction().execute(async (trx) => {
      await requireIntakeSessionXactLock(trx, sessionId);
      const session = await trx
        .selectFrom('intake_session')
        .selectAll()
        .where('id', '=', sessionId)
        .where('owner_id', '=', ownerId)
        .forUpdate()
        .executeTakeFirst();
      if (session === undefined) throw new NotFoundError('intake session', sessionId);
      if (session.version !== expectedVersion) {
        throw new VersionConflictError(expectedVersion as never, session.version as never);
      }
      const proposal = await trx
        .selectFrom('agent_proposal')
        .select('id')
        .where('owner_id', '=', ownerId)
        .where('kind', '=', draftKind(sessionId))
        .orderBy('created_at', 'desc')
        .orderBy('id', 'desc')
        .limit(1)
        .executeTakeFirst();
      if (proposal === undefined) throw new NotFoundError('decomposition draft', sessionId);
      await trx
        .updateTable('agent_proposal')
        .set({
          payload: jsonb({
            draft: input.draft,
            issues: input.issues,
            editedEstimateKeys: [...input.editedEstimateKeys],
          } as unknown as JsonValue),
          schema_ok: input.schemaOk,
          policy_ok: input.policyOk,
          constraint_ok: input.constraintOk,
          updated_at: new Date(this.#clock.now()),
          version: sql<number>`version + 1`,
        })
        .where('id', '=', proposal.id)
        .where('owner_id', '=', ownerId)
        .execute();
      const updated = await trx
        .updateTable('intake_session')
        .set({ updated_at: new Date(this.#clock.now()), version: sql<number>`version + 1` })
        .where('id', '=', sessionId)
        .where('owner_id', '=', ownerId)
        .where('version', '=', expectedVersion)
        .returningAll()
        .executeTakeFirst();
      if (updated === undefined) {
        throw new VersionConflictError(expectedVersion as never, expectedVersion as never);
      }
      return mapSession(updated);
    });
  }
}
