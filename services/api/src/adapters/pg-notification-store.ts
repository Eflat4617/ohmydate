import type { Notification, NotificationPage, NotificationQuery } from '@ohmydate/contracts';
import {
  NotFoundError,
  VersionConflictError,
  instantToEpochMs,
  type Id,
  type Instant,
} from '@ohmydate/domain';
import { sql, type Kysely } from 'kysely';
import type { Database } from '../db/types.js';
import type { NotificationStore } from '../application/notification-service.js';

type Db = Kysely<Database>;

const NOTIFICATION_WINDOW_MS = 10 * 60_000;

function toInstant(value: Date | string): Instant {
  return (value instanceof Date ? value.toISOString() : value) as Instant;
}

function toDate(value: string): Date {
  return new Date(instantToEpochMs(value as Instant));
}

export class PgNotificationStore implements NotificationStore {
  readonly #db: Db;
  readonly #ids: import('@ohmydate/domain').IdGenerator;

  constructor(options: { db: Db; ids: import('@ohmydate/domain').IdGenerator }) {
    this.#db = options.db;
    this.#ids = options.ids;
  }

  async runUpcoming(now: Instant): Promise<number> {
    const nowDate = toDate(now);
    const windowEnd = new Date(nowDate.getTime() + NOTIFICATION_WINDOW_MS);
    const blocks = await this.#db
      .selectFrom('schedule_block')
      .innerJoin('plan_version', 'plan_version.id', 'schedule_block.plan_version_id')
      .innerJoin('plan', 'plan.id', 'plan_version.plan_id')
      .select([
        'schedule_block.id',
        'schedule_block.owner_id',
        'schedule_block.start_at',
      ])
      .where('plan.deleted_at', 'is', null)
      .where('schedule_block.status', '<>', 'superseded')
      .where('schedule_block.start_at', '>', nowDate)
      .where('schedule_block.start_at', '<=', windowEnd)
      .orderBy('schedule_block.start_at', 'asc')
      .execute();
    let created = 0;
    for (const block of blocks) {
      const startAt = toInstant(block.start_at);
      const scheduledAt = new Date(Date.parse(startAt) - NOTIFICATION_WINDOW_MS);
      const inserted = await this.#db
        .insertInto('notification')
        .values({
          id: this.#ids.next(),
          owner_id: block.owner_id,
          kind: 'session_reminder',
          dedupe_key: `session_reminder:${block.id}:${startAt}`,
          scheduled_at: scheduledAt,
          sent_at: nowDate,
          channel: 'in_app',
          state: 'sent',
          created_at: nowDate,
          updated_at: nowDate,
        })
        .onConflict((oc) => oc.columns(['owner_id', 'dedupe_key']).doNothing())
        .returning('id')
        .executeTakeFirst();
      if (inserted !== undefined) created += 1;
    }
    return created;
  }

  async list(ownerId: Id, query: NotificationQuery): Promise<NotificationPage> {
    const limit = query.limit ?? 20;
    let builder = this.#db
      .selectFrom('notification')
      .selectAll()
      .where('owner_id', '=', ownerId);
    if (query.state !== undefined) builder = builder.where('state', '=', query.state);
    if (query.cursor !== undefined) builder = builder.where('id', '<', query.cursor);
    const rows = await builder
      .orderBy('id', 'desc')
      .limit(limit + 1)
      .execute();
    const pageRows = rows.slice(0, limit);
    return {
      items: pageRows.map((row) => this.#map(row)),
      nextCursor: rows.length > limit ? (pageRows[pageRows.length - 1]?.id ?? null) : null,
    };
  }

  async get(ownerId: Id, id: Id): Promise<Notification | null> {
    const row = await this.#db
      .selectFrom('notification')
      .selectAll()
      .where('id', '=', id)
      .where('owner_id', '=', ownerId)
      .executeTakeFirst();
    return row === undefined ? null : this.#map(row);
  }

  async dismiss(
    ownerId: Id,
    id: Id,
    expectedVersion: number,
    now: Instant,
  ): Promise<Notification> {
    const nowDate = toDate(now);
    const row = await this.#db
      .updateTable('notification')
      .set({
        state: 'dismissed',
        sent_at: null,
        version: sql<number>`version + 1`,
        updated_at: nowDate,
      })
      .where('id', '=', id)
      .where('owner_id', '=', ownerId)
      .where('version', '=', expectedVersion)
      .returningAll()
      .executeTakeFirst();
    if (row === undefined) {
      const current = await this.#db
        .selectFrom('notification')
        .select(['version'])
        .where('id', '=', id)
        .where('owner_id', '=', ownerId)
        .executeTakeFirst();
      if (current === undefined) throw new NotFoundError('notification', id);
      throw new VersionConflictError(expectedVersion as never, current.version as never);
    }
    return this.#map(row);
  }

  #map(row: {
    id: string;
    kind: string;
    dedupe_key: string;
    scheduled_at: Date | string;
    sent_at: Date | string | null;
    channel: string;
    state: string;
    version: number;
  }): Notification {
    return {
      id: row.id as Id,
      kind: row.kind as Notification['kind'],
      dedupeKey: row.dedupe_key,
      scheduledAt: toInstant(row.scheduled_at),
      ...(row.sent_at === null ? {} : { sentAt: toInstant(row.sent_at) }),
      channel: row.channel as Notification['channel'],
      state: row.state as Notification['state'],
      version: row.version,
    };
  }
}
