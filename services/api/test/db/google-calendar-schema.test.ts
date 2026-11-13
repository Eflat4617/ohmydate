import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, readdir, copyFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

/** A migrations directory that stops at 0015, to seed rows before 0016 runs. */
async function migrationsBefore0016(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'ohmydate-mig-0015-'));
  for (const entry of await readdir(migrationsDir)) {
    if (/^00(0\d|1[0-5])_/.test(entry)) await copyFile(join(migrationsDir, entry), join(dir, entry));
  }
  return dir;
}

describe.skipIf(!hasDatabase)('0016 google calendar (CAL-03)', () => {
  let schema: string;
  let client: PgClient;

  beforeEach(async () => {
    schema = makeSchemaName();
    await createSchema(schema);
  });

  afterEach(async () => {
    await client?.end().catch(() => undefined);
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

  function insertCommitment(
    ownerId: string,
    fields: { source?: string; calendar?: string | null; event?: string | null; rrule?: string | null; deleted?: boolean } = {},
  ): Promise<unknown> {
    return client.query(
      `INSERT INTO commitment_event
         (id, owner_id, title, start_at, end_at, rrule, time_zone, source,
          external_calendar_id, external_event_id, deleted_at)
       VALUES ($1, $2, '약속', '2026-11-14T01:00:00Z', '2026-11-14T02:00:00Z', $3, 'Asia/Seoul', $4, $5, $6, $7)`,
      [
        randomUUID(),
        ownerId,
        fields.rrule ?? null,
        fields.source ?? 'manual',
        fields.calendar ?? null,
        fields.event ?? null,
        fields.deleted === true ? new Date() : null,
      ],
    );
  }

  /** Pre-0016 shape: no external columns yet. */
  function insertLegacyCommitment(ownerId: string, rrule: string | null = null): Promise<unknown> {
    return client.query(
      `INSERT INTO commitment_event (id, owner_id, title, start_at, end_at, rrule, time_zone)
       VALUES ($1, $2, '약속', '2026-11-14T01:00:00Z', '2026-11-14T02:00:00Z', $3, 'Asia/Seoul')`,
      [randomUUID(), ownerId, rrule],
    );
  }

  async function insertConnection(ownerId: string, status = 'connected'): Promise<string> {
    const id = randomUUID();
    await client.query(
      `INSERT INTO google_calendar_connection (id, owner_id, status, refresh_token_ciphertext, token_key_id)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        id,
        ownerId,
        status,
        status === 'disconnected' ? null : randomBytes(64),
        status === 'disconnected' ? null : 'abcdef0123456789',
      ],
    );
    return id;
  }

  test('commitment_event accepts google rows only with a complete external reference and no rrule', async () => {
    await migrate({ databaseUrl: requireDatabaseUrl(), schema, migrationsDir });
    client = await connect(schema);
    const owner = await insertUser();

    await insertCommitment(owner, { source: 'google', calendar: 'primary@example', event: 'evt_1' });
    await insertCommitment(owner);

    const missingRef = await queryFailure(insertCommitment(owner, { source: 'google', calendar: 'c' }));
    expect(missingRef.constraint).toBe('commitment_event_external_ref_valid');
    const manualWithRef = await queryFailure(
      insertCommitment(owner, { source: 'manual', calendar: 'c', event: 'e' }),
    );
    expect(manualWithRef.constraint).toBe('commitment_event_external_ref_valid');
    const repeating = await queryFailure(
      insertCommitment(owner, { source: 'google', calendar: 'c', event: 'e2', rrule: 'FREQ=DAILY' }),
    );
    expect(repeating.constraint).toBe('commitment_event_external_ref_valid');
    const unknown = await queryFailure(insertCommitment(owner, { source: 'outlook' }));
    expect(unknown.constraint).toBe('commitment_event_source_valid');
  });

  test('the external reference is unique per owner among live rows only', async () => {
    await migrate({ databaseUrl: requireDatabaseUrl(), schema, migrationsDir });
    client = await connect(schema);
    const owner = await insertUser();
    const other = await insertUser();
    const ref = { source: 'google', calendar: 'cal@example', event: 'evt_same' };

    await insertCommitment(owner, ref);
    const duplicate = await queryFailure(insertCommitment(owner, ref));
    expect(duplicate.code).toBe('23505');
    // Another owner may import the same Google event; a soft-deleted row frees the key.
    await insertCommitment(other, ref);
    await client.query(
      `UPDATE commitment_event SET deleted_at = now() WHERE owner_id = $1 AND source = 'google'`,
      [owner],
    );
    await insertCommitment(owner, ref);
  });

  test('connection: token iff connected/needs_reauth, closed error codes, one row per owner', async () => {
    await migrate({ databaseUrl: requireDatabaseUrl(), schema, migrationsDir });
    client = await connect(schema);
    const owner = await insertUser();
    await insertConnection(owner);

    const second = await queryFailure(insertConnection(owner));
    expect(second.constraint).toBe('google_calendar_connection_owner_unique');

    const other = await insertUser();
    const tokenless = await queryFailure(
      client.query(
        `INSERT INTO google_calendar_connection (id, owner_id, status) VALUES ($1, $2, 'connected')`,
        [randomUUID(), other],
      ),
    );
    expect(tokenless.constraint).toBe('google_calendar_connection_token_matches_status');
    const keyless = await queryFailure(
      client.query(
        `INSERT INTO google_calendar_connection (id, owner_id, status, refresh_token_ciphertext)
         VALUES ($1, $2, 'connected', $3)`,
        [randomUUID(), other, randomBytes(64)],
      ),
    );
    expect(keyless.constraint).toBe('google_calendar_connection_token_key_present');
    const freeText = await queryFailure(
      client.query(`UPDATE google_calendar_connection SET last_error = 'Token has been expired' WHERE owner_id = $1`, [
        owner,
      ]),
    );
    expect(freeText.constraint).toBe('google_calendar_connection_last_error_valid');
    await insertConnection(other, 'disconnected');
  });

  test('calendars are owner-scoped through the composite connection FK and cascade with it', async () => {
    await migrate({ databaseUrl: requireDatabaseUrl(), schema, migrationsDir });
    client = await connect(schema);
    const owner = await insertUser();
    const other = await insertUser();
    const connection = await insertConnection(owner);

    await client.query(
      `INSERT INTO google_calendar (id, owner_id, connection_id, google_calendar_id, name, access_role)
       VALUES ($1, $2, $3, 'primary@example', '내 캘린더', 'owner')`,
      [randomUUID(), owner, connection],
    );
    const foreign = await queryFailure(
      client.query(
        `INSERT INTO google_calendar (id, owner_id, connection_id, google_calendar_id, name, access_role)
         VALUES ($1, $2, $3, 'x@example', 'x', 'owner')`,
        [randomUUID(), other, connection],
      ),
    );
    expect(foreign.constraint).toBe('google_calendar_connection_fk');
    const role = await queryFailure(
      client.query(
        `INSERT INTO google_calendar (id, owner_id, connection_id, google_calendar_id, name, access_role)
         VALUES ($1, $2, $3, 'y@example', 'y', 'admin')`,
        [randomUUID(), owner, connection],
      ),
    );
    expect(role.constraint).toBe('google_calendar_access_role_valid');

    await client.query('DELETE FROM google_calendar_connection WHERE id = $1', [connection]);
    const left = await client.query<{ count: string }>('SELECT count(*)::text AS count FROM google_calendar');
    expect(left.rows[0]?.count).toBe('0');
  });

  test('day events need ordered dates and a bounded title; mappings need a sha256 fingerprint', async () => {
    await migrate({ databaseUrl: requireDatabaseUrl(), schema, migrationsDir });
    client = await connect(schema);
    const owner = await insertUser();
    const dayEvent = (start: string, end: string, title = '개천절') =>
      client.query(
        `INSERT INTO calendar_day_event (id, owner_id, title, start_date, end_date, external_calendar_id, external_event_id)
         VALUES ($1, $2, $3, $4, $5, 'holiday@example', $6)`,
        [randomUUID(), owner, title, start, end, randomUUID()],
      );
    await dayEvent('2026-10-03', '2026-10-04');
    expect((await queryFailure(dayEvent('2026-10-03', '2026-10-03'))).constraint).toBe(
      'calendar_day_event_dates_ordered',
    );
    expect((await queryFailure(dayEvent('2026-10-03', '2026-10-04', ''))).constraint).toBe(
      'calendar_day_event_title_present',
    );

    const mapping = (fingerprint: string, kind = 'block') =>
      client.query(
        `INSERT INTO google_export_mapping (id, owner_id, local_kind, local_key, google_calendar_id, google_event_id, fingerprint)
         VALUES ($1, $2, $3, $4, 'export@example', $5, $6)`,
        [randomUUID(), owner, kind, randomUUID(), `b${randomUUID().replace(/-/g, '')}`, fingerprint],
      );
    await mapping('a'.repeat(64));
    expect((await queryFailure(mapping('not-a-digest'))).constraint).toBe(
      'google_export_mapping_fingerprint_sha256',
    );
    expect((await queryFailure(mapping('b'.repeat(64), 'task'))).constraint).toBe(
      'google_export_mapping_kind_valid',
    );
  });

  test('applies on a schema with existing commitments, rolls back with imported rows and reapplies', async () => {
    const before = await migrationsBefore0016();
    try {
      await migrate({ databaseUrl: requireDatabaseUrl(), schema, migrationsDir: before });
      client = await connect(schema);
      const owner = await insertUser();
      await insertLegacyCommitment(owner);
      await insertLegacyCommitment(owner, 'FREQ=WEEKLY;BYDAY=MO');
      await client.query(
        `INSERT INTO user_availability_version (owner_id, version) VALUES ($1, 3)`,
        [owner],
      );
      await client.end();

      const applied = await migrate({ databaseUrl: requireDatabaseUrl(), schema, migrationsDir });
      expect(applied.applied).toEqual(['0016_google_calendar.sql']);
      client = await connect(schema);
      const kept = await client.query<{ source: string; external_calendar_id: string | null }>(
        'SELECT source, external_calendar_id FROM commitment_event ORDER BY rrule NULLS FIRST',
      );
      expect(kept.rows).toEqual([
        { source: 'manual', external_calendar_id: null },
        { source: 'manual', external_calendar_id: null },
      ]);

      await insertCommitment(owner, { source: 'google', calendar: 'cal@example', event: 'evt_1' });
      await insertConnection(owner);
      await client.end();

      const rolledBack = await rollbackLatest({ databaseUrl: requireDatabaseUrl(), schema, migrationsDir });
      expect(rolledBack).toBe('0016_google_calendar.sql');
      client = await connect(schema);
      const after = await client.query<{ source: string }>('SELECT source FROM commitment_event');
      expect(after.rows.map((row) => row.source)).toEqual(['manual', 'manual']);
      const version = await client.query<{ version: number }>(
        'SELECT version FROM user_availability_version WHERE owner_id = $1',
        [owner],
      );
      expect(version.rows[0]?.version).toBe(4);
      const table = await client.query<{ name: string | null }>(
        `SELECT to_regclass('google_calendar_connection')::text AS name`,
      );
      expect(table.rows[0]?.name).toBeNull();
      const legacyColumns = await queryFailure(insertCommitment(owner, { source: 'google' }));
      expect(legacyColumns.code).toBe('42703');
      const legacySource = await queryFailure(
        client.query(
          `INSERT INTO commitment_event (id, owner_id, title, start_at, end_at, time_zone, source)
           VALUES ($1, $2, 'x', '2026-11-14T01:00:00Z', '2026-11-14T02:00:00Z', 'UTC', 'google')`,
          [randomUUID(), owner],
        ),
      );
      expect(legacySource.constraint).toBe('commitment_event_source_valid');
      await client.end();

      const reapplied = await migrate({ databaseUrl: requireDatabaseUrl(), schema, migrationsDir });
      expect(reapplied.applied).toEqual(['0016_google_calendar.sql']);
      client = await connect(schema);
    } finally {
      await rm(before, { recursive: true, force: true });
    }
  });
});
