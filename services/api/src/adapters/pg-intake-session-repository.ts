import type {
  IntakeAnswer as ContractIntakeAnswer,
  IntakeDetectedType,
  IntakeError,
  IntakeInput,
} from '@ohmydate/contracts';
import type { Clock, Id, IdGenerator, Instant, IntakeState } from '@ohmydate/domain';
import { NotFoundError, VersionConflictError } from '@ohmydate/domain';
import { sql, type Kysely, type Selectable } from 'kysely';
import type { Database, IntakeAnswerTable, IntakeSessionTable, JsonValue } from '../db/types.js';
import { jsonb } from '../db/types.js';
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

function mapSession(row: SessionRow): IntakeSessionRecord {
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
    ...(row.error === null ? {} : { error: row.error as unknown as IntakeError }),
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

    const updated = await this.#db
      .updateTable('intake_session')
      .set(set as never)
      .where('id', '=', id)
      .where('owner_id', '=', ownerId)
      .where('version', '=', expectedVersion)
      .returningAll()
      .executeTakeFirst();

    if (updated !== undefined) return mapSession(updated);

    const current = await this.get(ownerId, id);
    if (current === null) throw new NotFoundError('intake session', id);
    throw new VersionConflictError(expectedVersion as never, current.version as never);
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
      .values(
        answers.map((answer) => ({
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
        })),
      )
      .execute();
  }
}
