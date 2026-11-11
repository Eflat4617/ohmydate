import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { migrate, rollbackLatest } from '../../src/db/migrate.js';
import {
  connect,
  createSchema,
  dropSchema,
  hasDatabase,
  makeSchemaName,
  queryFailure,
  requireDatabaseUrl,
  type PgClient,
} from './helpers.js';

const migrationsDir = fileURLToPath(new URL('../../migrations/', import.meta.url));

const M4_TABLES = [
  'estimation_feedback',
  'export_job',
  'notification',
  'push_subscription',
  'task_completion_review',
  'work_session',
] as const;

describe.skipIf(!hasDatabase)('0009 today/session schema', () => {
  let schema: string;
  let client: PgClient;

  beforeEach(async () => {
    schema = makeSchemaName();
    await createSchema(schema);
    await migrate({ databaseUrl: requireDatabaseUrl(), schema, migrationsDir });
    client = await connect(schema);
  });

  afterEach(async () => {
    await client.end();
    await dropSchema(schema);
  });

  async function insertUser(): Promise<string> {
    const id = randomUUID();
    await client.query('INSERT INTO "user" (id, email, password_hash) VALUES ($1, $2, $3)', [
      id,
      `${id}@example.test`,
      'argon2id-placeholder',
    ]);
    return id;
  }

  async function insertTask(ownerId: string): Promise<string> {
    const projectId = randomUUID();
    await client.query(
      'INSERT INTO project (id, owner_id, title, kind) VALUES ($1, $2, $3, $4)',
      [projectId, ownerId, 'Project', 'normal'],
    );
    const taskId = randomUUID();
    await client.query(
      'INSERT INTO task (id, owner_id, project_id, title_cache) VALUES ($1, $2, $3, $4)',
      [taskId, ownerId, projectId, 'task'],
    );
    return taskId;
  }

  async function insertSession(
    ownerId: string,
    taskId: string,
    state = 'active',
    endedAt: string | null = null,
  ): Promise<string> {
    const id = randomUUID();
    await client.query(
      `INSERT INTO work_session
         (id, owner_id, task_id, state, started_at, ended_at, client_id)
       VALUES ($1, $2, $3, $4, $5, $6, 'web-test')`,
      [id, ownerId, taskId, state, '2026-11-11T09:00:00Z', endedAt],
    );
    return id;
  }

  async function insertScheduleBlock(ownerId: string, taskId: string): Promise<string> {
    const planId = randomUUID();
    await client.query(
      `INSERT INTO plan
         (id, owner_id, scope, status, availability_version,
          horizon_start, horizon_end, time_zone)
       VALUES ($1, $2, $3, 'active', 1, $4, $5, 'UTC')`,
      [
        planId,
        ownerId,
        { taskIds: [taskId] },
        '2026-11-11T00:00:00Z',
        '2026-11-12T00:00:00Z',
      ],
    );
    const versionId = randomUUID();
    await client.query(
      `INSERT INTO plan_version
         (id, owner_id, plan_id, seq, created_by, availability_version)
       VALUES ($1, $2, $3, 1, 'user', 1)`,
      [versionId, ownerId, planId],
    );
    const blockId = randomUUID();
    await client.query(
      `INSERT INTO schedule_block
         (id, owner_id, plan_version_id, task_id, start_at, end_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        blockId,
        ownerId,
        versionId,
        taskId,
        '2026-11-11T09:00:00Z',
        '2026-11-11T10:00:00Z',
      ],
    );
    return blockId;
  }

  test('creates the M4 tables with their documented columns', async () => {
    const result = await client.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = $1 AND table_type = 'BASE TABLE'`,
      [schema],
    );
    const names = result.rows.map((row) => row.table_name);
    for (const table of M4_TABLES) {
      expect({ table, present: names.includes(table) }).toEqual({ table, present: true });
    }

    const columns = await client.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = $1 AND table_name = 'push_subscription'
        ORDER BY ordinal_position`,
      [schema],
    );
    expect(columns.rows.map((row) => row.column_name)).toEqual([
      'id',
      'owner_id',
      'endpoint',
      'p256dh_ciphertext',
      'auth_ciphertext',
      'key_id',
      'device_label',
      'created_at',
      'updated_at',
      'version',
    ]);
    expect(columns.rows.map((row) => row.column_name)).not.toContain('auth');
    expect(columns.rows.map((row) => row.column_name)).not.toContain('p256dh');
  });

  test('one active session per owner is enforced by the partial unique index', async () => {
    const ownerId = await insertUser();
    const taskId = await insertTask(ownerId);
    const sessionId = await insertSession(ownerId, taskId, 'active');

    const duplicate = await queryFailure(insertSession(ownerId, taskId, 'active'));
    expect(duplicate.code).toBe('23505');
    expect(duplicate.constraint).toBe('work_session_one_active_per_owner');

    // A paused or completed session no longer occupies the active slot.
    await client.query('UPDATE work_session SET state = $1 WHERE id = $2', ['paused', sessionId]);
    const secondActive = await insertSession(ownerId, taskId, 'active');
    expect(secondActive).toBeDefined();

    // A different owner may have their own active session.
    const otherOwner = await insertUser();
    const otherTask = await insertTask(otherOwner);
    await expect(insertSession(otherOwner, otherTask, 'active')).resolves.toBeDefined();
  });

  test('session state, end time, cross-owner FK and review bounds are checked', async () => {
    const ownerA = await insertUser();
    const ownerB = await insertUser();
    const taskA = await insertTask(ownerA);
    const taskB = await insertTask(ownerB);

    const badState = await queryFailure(
      client.query(
        `INSERT INTO work_session (id, owner_id, task_id, state, started_at, client_id)
         VALUES ($1, $2, $3, 'running', $4, 'web')`,
        [randomUUID(), ownerA, taskA, '2026-11-11T09:00:00Z'],
      ),
    );
    expect(badState.code).toBe('23514');
    expect(badState.constraint).toBe('work_session_state_valid');

    const missingEnd = await queryFailure(
      client.query(
        `INSERT INTO work_session (id, owner_id, task_id, state, started_at, client_id)
         VALUES ($1, $2, $3, 'completed', $4, 'web')`,
        [randomUUID(), ownerA, taskA, '2026-11-11T09:00:00Z'],
      ),
    );
    expect(missingEnd.code).toBe('23514');
    expect(missingEnd.constraint).toBe('work_session_ended_consistent');

    const crossOwner = await queryFailure(
      client.query(
        `INSERT INTO work_session (id, owner_id, task_id, started_at, client_id)
         VALUES ($1, $2, $3, $4, 'web')`,
        [randomUUID(), ownerA, taskB, '2026-11-11T09:00:00Z'],
      ),
    );
    expect(crossOwner.code).toBe('23503');
    expect(crossOwner.constraint).toBe('work_session_task_fk');

    const sessionId = await insertSession(ownerA, taskA, 'completed', '2026-11-11T10:00:00Z');
    await client.query(
      `INSERT INTO task_completion_review
         (id, owner_id, session_id, outcome, reason_chips, note)
       VALUES ($1, $2, $3, 'partial', ARRAY['interrupted'], $4)`,
      [randomUUID(), ownerA, sessionId, 'x'.repeat(2000)],
    );

    const longNote = await queryFailure(
      client.query(
        `INSERT INTO task_completion_review
           (id, owner_id, session_id, outcome, note)
         VALUES ($1, $2, $3, 'done', $4)`,
        [randomUUID(), ownerA, sessionId, 'x'.repeat(2001)],
      ),
    );
    expect(longNote.code).toBe('23514');
    expect(longNote.constraint).toBe('task_completion_review_note_bounded');

    const badChip = await queryFailure(
      client.query(
        `INSERT INTO task_completion_review
           (id, owner_id, session_id, outcome, reason_chips)
         VALUES ($1, $2, $3, 'done', ARRAY['traffic'])`,
        [randomUUID(), ownerA, sessionId],
      ),
    );
    expect(badChip.code).toBe('23514');
    expect(badChip.constraint).toBe('task_completion_review_reason_chips_valid');

    // One review per session.
    const duplicateReview = await queryFailure(
      client.query(
        `INSERT INTO task_completion_review
           (id, owner_id, session_id, outcome)
         VALUES ($1, $2, $3, 'done')`,
        [randomUUID(), ownerA, sessionId],
      ),
    );
    expect(duplicateReview.code).toBe('23505');
    expect(duplicateReview.constraint).toBe('task_completion_review_session_unique');
  });

  test('cross-owner session block and review session FKs are rejected', async () => {
    const ownerA = await insertUser();
    const ownerB = await insertUser();
    const taskA = await insertTask(ownerA);
    const taskB = await insertTask(ownerB);
    const blockB = await insertScheduleBlock(ownerB, taskB);

    const crossBlock = await queryFailure(
      client.query(
        `INSERT INTO work_session (id, owner_id, task_id, block_id, started_at, client_id)
         VALUES ($1, $2, $3, $4, $5, 'web')`,
        [randomUUID(), ownerA, taskA, blockB, '2026-11-11T09:00:00Z'],
      ),
    );
    expect(crossBlock.code).toBe('23503');
    expect(crossBlock.constraint).toBe('work_session_block_fk');

    const sessionB = await insertSession(ownerB, taskB, 'completed', '2026-11-11T10:00:00Z');
    const crossReview = await queryFailure(
      client.query(
        `INSERT INTO task_completion_review
           (id, owner_id, session_id, outcome)
         VALUES ($1, $2, $3, 'done')`,
        [randomUUID(), ownerA, sessionB],
      ),
    );
    expect(crossReview.code).toBe('23503');
    expect(crossReview.constraint).toBe('task_completion_review_session_fk');
  });

  test('notifications dedupe per owner and enforce sent/state consistency', async () => {
    const ownerId = await insertUser();
    const insert = (dedupeKey: string) =>
      client.query(
        `INSERT INTO notification (id, owner_id, kind, dedupe_key, scheduled_at, channel, state)
         VALUES ($1, $2, 'deadline_risk', $3, $4, 'push', 'scheduled')`,
        [randomUUID(), ownerId, dedupeKey, '2026-11-11T09:00:00Z'],
      );

    await insert('deadline:1');
    const duplicate = await queryFailure(insert('deadline:1'));
    expect(duplicate.code).toBe('23505');
    expect(duplicate.constraint).toBe('notification_owner_dedupe_unique');

    const otherOwner = await insertUser();
    await client.query(
      `INSERT INTO notification (id, owner_id, kind, dedupe_key, scheduled_at)
       VALUES ($1, $2, 'deadline_risk', 'deadline:1', $3)`,
      [randomUUID(), otherOwner, '2026-11-11T09:00:00Z'],
    );

    const inconsistentSent = await queryFailure(
      client.query(
        `INSERT INTO notification (id, owner_id, kind, dedupe_key, scheduled_at, state)
         VALUES ($1, $2, 'daily_summary', 'daily:1', $3, 'sent')`,
        [randomUUID(), ownerId, '2026-11-11T09:00:00Z'],
      ),
    );
    expect(inconsistentSent.code).toBe('23514');
    expect(inconsistentSent.constraint).toBe('notification_sent_consistent');
  });

  test('sent -> dismissed preserves sent_at; unsent states reject sent_at', async () => {
    const ownerId = await insertUser();
    const sentAt = '2026-11-11T09:05:00Z';
    const notificationId = randomUUID();
    await client.query(
      `INSERT INTO notification
         (id, owner_id, kind, dedupe_key, scheduled_at, sent_at, channel, state)
       VALUES ($1, $2, 'deadline_risk', 'deadline:history', $3, $4, 'push', 'sent')`,
      [notificationId, ownerId, '2026-11-11T09:00:00Z', sentAt],
    );

    await client.query(
      'UPDATE notification SET state = $1, version = version + 1 WHERE id = $2',
      ['dismissed', notificationId],
    );
    const dismissed = await client.query<{ state: string; sent_at: Date }>(
      'SELECT state, sent_at FROM notification WHERE id = $1',
      [notificationId],
    );
    expect(dismissed.rows[0]?.state).toBe('dismissed');
    expect(dismissed.rows[0]?.sent_at.toISOString()).toBe(new Date(sentAt).toISOString());

    // A notification that was never sent may be dismissed without a timestamp.
    await client.query(
      `INSERT INTO notification (id, owner_id, kind, dedupe_key, scheduled_at, state)
       VALUES ($1, $2, 'daily_summary', 'daily:never-sent', $3, 'dismissed')`,
      [randomUUID(), ownerId, '2026-11-11T09:00:00Z'],
    );

    const scheduledWithSentAt = await queryFailure(
      client.query(
        `INSERT INTO notification
           (id, owner_id, kind, dedupe_key, scheduled_at, sent_at, state)
         VALUES ($1, $2, 'daily_summary', 'daily:scheduled-sent', $3, $4, 'scheduled')`,
        [randomUUID(), ownerId, '2026-11-11T09:00:00Z', sentAt],
      ),
    );
    expect(scheduledWithSentAt.code).toBe('23514');
    expect(scheduledWithSentAt.constraint).toBe('notification_sent_consistent');
  });

  test('push subscriptions are HTTPS-only, unique by endpoint and store ciphertext', async () => {
    const ownerId = await insertUser();
    const insert = (endpoint: string, auth: Buffer) =>
      client.query(
        `INSERT INTO push_subscription
           (id, owner_id, endpoint, p256dh_ciphertext, auth_ciphertext, key_id)
         VALUES ($1, $2, $3, $4, $5, 'kms:1')`,
        [randomUUID(), ownerId, endpoint, Buffer.from('ciphertext'), auth],
      );

    await insert('https://push.example.test/sub/abc', Buffer.from('auth-ciphertext'));

    const duplicate = await queryFailure(
      insert('https://push.example.test/sub/abc', Buffer.from('auth-ciphertext')),
    );
    expect(duplicate.code).toBe('23505');
    expect(duplicate.constraint).toBe('push_subscription_endpoint_unique');

    const http = await queryFailure(
      insert('http://push.example.test/sub/abc', Buffer.from('auth-ciphertext')),
    );
    expect(http.code).toBe('23514');
    expect(http.constraint).toBe('push_subscription_endpoint_https');

    const emptyCipher = await queryFailure(
      insert('https://push.example.test/sub/empty', Buffer.alloc(0)),
    );
    expect(emptyCipher.code).toBe('23514');
    expect(emptyCipher.constraint).toBe('push_subscription_auth_ciphertext_present');
  });

  test('export jobs require an artifact when ready and a code when failed', async () => {
    const ownerId = await insertUser();
    const insert = (state: string, artifactKey: string | null, failureCode: string | null) =>
      client.query(
        `INSERT INTO export_job (id, owner_id, state, artifact_key, failure_code)
         VALUES ($1, $2, $3, $4, $5)`,
        [randomUUID(), ownerId, state, artifactKey, failureCode],
      );

    await insert('queued', null, null);
    await insert('ready', 'exports/abc.zip', null);
    await insert('failed', null, 'render_failed');

    const readyWithoutArtifact = await queryFailure(insert('ready', null, null));
    expect(readyWithoutArtifact.code).toBe('23514');
    expect(readyWithoutArtifact.constraint).toBe('export_job_ready_has_artifact');

    const failedWithoutCode = await queryFailure(insert('failed', null, null));
    expect(failedWithoutCode.code).toBe('23514');
    expect(failedWithoutCode.constraint).toBe('export_job_failed_has_code');
  });

  test('rolls back 0009 with seeded rows and can reapply it', async () => {
    const ownerId = await insertUser();
    const taskId = await insertTask(ownerId);
    const sessionId = await insertSession(ownerId, taskId, 'completed', '2026-11-11T10:00:00Z');

    await client.query(
      `INSERT INTO task_completion_review (id, owner_id, session_id, outcome, note)
       VALUES ($1, $2, $3, 'done', 'seeded')`,
      [randomUUID(), ownerId, sessionId],
    );
    await client.query(
      `INSERT INTO estimation_feedback
         (id, owner_id, task_id, estimated_p50, actual_focus_min, quality)
       VALUES ($1, $2, $3, 120, 95, 'ok')`,
      [randomUUID(), ownerId, taskId],
    );
    await client.query(
      `INSERT INTO notification (id, owner_id, kind, dedupe_key, scheduled_at)
       VALUES ($1, $2, 'daily_summary', 'daily:seed', $3)`,
      [randomUUID(), ownerId, '2026-11-11T09:00:00Z'],
    );
    await client.query(
      `INSERT INTO push_subscription
         (id, owner_id, endpoint, p256dh_ciphertext, auth_ciphertext, key_id)
       VALUES ($1, $2, 'https://push.example.test/seed', $3, $4, 'kms:1')`,
      [randomUUID(), ownerId, Buffer.from('p256dh'), Buffer.from('auth')],
    );
    await client.query(
      `INSERT INTO export_job (id, owner_id, state, artifact_key)
       VALUES ($1, $2, 'ready', 'exports/seed.zip')`,
      [randomUUID(), ownerId],
    );
    await client.end();
    client = await connect(schema);

    const rolledBack = await rollbackLatest({
      databaseUrl: requireDatabaseUrl(),
      schema,
      migrationsDir,
    });
    expect(rolledBack).toBe('0010_daily_storage.sql');
    const proposalTable = await client.query<{ name: string | null }>(
      `SELECT to_regclass('today_proposal')::text AS name`,
    );
    expect(proposalTable.rows[0]?.name).toBeNull();

    const rolledBackAgain = await rollbackLatest({
      databaseUrl: requireDatabaseUrl(),
      schema,
      migrationsDir,
    });
    expect(rolledBackAgain).toBe('0009_today_sessions.sql');

    for (const table of M4_TABLES) {
      const gone = await client.query<{ name: string | null }>(
        'SELECT to_regclass($1)::text AS name',
        [table],
      );
      expect({ table, name: gone.rows[0]?.name }).toEqual({ table, name: null });
    }
    const userTable = await client.query<{ name: string | null }>(
      `SELECT to_regclass('"user"')::text AS name`,
    );
    expect(userTable.rows[0]?.name).not.toBeNull();

    const reapplied = await migrate({
      databaseUrl: requireDatabaseUrl(),
      schema,
      migrationsDir,
    });
    expect(reapplied.applied).toEqual(['0009_today_sessions.sql', '0010_daily_storage.sql']);
  });
});
