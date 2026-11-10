import type {
  Clock,
  Id,
  IdGenerator,
  InboxProjectLookup,
  Instant,
  Project,
  ProjectKind,
  Version,
} from '@ohmydate/domain';
import type { Kysely, Selectable } from 'kysely';
import type { Database, ProjectTable } from '../db/types.js';

type ProjectRow = Selectable<ProjectTable>;

function toInstant(value: Date | string): Instant {
  return (value instanceof Date ? value.toISOString() : value) as Instant;
}

function mapProject(row: ProjectRow): Project {
  return {
    id: row.id as Id,
    ownerId: row.owner_id as Id,
    title: row.title,
    kind: row.kind as ProjectKind,
    archived: row.archived,
    version: row.version as Version,
    createdAt: toInstant(row.created_at),
    updatedAt: toInstant(row.updated_at),
  };
}

/**
 * ADR-018 Inbox lookup for PostgreSQL. The partial unique index
 * project_owner_inbox_unique makes INSERT ... ON CONFLICT DO NOTHING safe for
 * concurrent first calls; the follow-up read returns the single live Inbox.
 */
export class PgInboxRepository implements InboxProjectLookup {
  readonly #db: Kysely<Database>;
  readonly #clock: Clock;
  readonly #ids: IdGenerator;

  constructor(options: { db: Kysely<Database>; clock: Clock; ids: IdGenerator }) {
    this.#db = options.db;
    this.#clock = options.clock;
    this.#ids = options.ids;
  }

  async getInbox(ownerId: Id): Promise<Project> {
    const now = new Date(this.#clock.now());
    const inserted = await this.#db
      .insertInto('project')
      .values({
        id: this.#ids.next(),
        owner_id: ownerId,
        title: 'Inbox',
        kind: 'inbox',
        created_at: now,
        updated_at: now,
      })
      .onConflict((oc) =>
        oc
          .columns(['owner_id'])
          .where('kind', '=', 'inbox')
          .where('deleted_at', 'is', null)
          .doNothing(),
      )
      .returningAll()
      .executeTakeFirst();
    if (inserted !== undefined) return mapProject(inserted);

    const existing = await this.#db
      .selectFrom('project')
      .selectAll()
      .where('owner_id', '=', ownerId)
      .where('kind', '=', 'inbox')
      .where('deleted_at', 'is', null)
      .executeTakeFirstOrThrow();
    return mapProject(existing);
  }
}
