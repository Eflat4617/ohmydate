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

const PLANNING_TABLES = [
  'availability_exception',
  'availability_rule',
  'commitment_event',
  'plan',
  'plan_candidate',
  'plan_version',
  'schedule_approval',
  'schedule_block',
  'user_availability_version',
] as const;

describe.skipIf(!hasDatabase)('0007 planning core schema', () => {
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

  async function insertPlan(ownerId: string): Promise<string> {
    const id = randomUUID();
    await client.query(
      `INSERT INTO plan (id, owner_id, scope, status, availability_version)
       VALUES ($1, $2, $3, 'draft', 1)`,
      [id, ownerId, { taskIds: [] }],
    );
    return id;
  }

  async function insertCandidate(ownerId: string, planId: string): Promise<string> {
    const id = randomUUID();
    await client.query(
      `INSERT INTO plan_candidate
         (id, owner_id, plan_id, policy, blocks, metrics, explanation,
          feasible, deficit_min, input_hash, generator_version)
       VALUES ($1, $2, $3, 'balanced', '[]'::jsonb, '{}'::jsonb, '[]'::jsonb,
               true, 0, 'sha256:test', 'scheduler@test')`,
      [id, ownerId, planId],
    );
    return id;
  }

  async function insertVersion(
    ownerId: string,
    planId: string,
    seq: number,
    candidateId: string | null = null,
  ): Promise<string> {
    const id = randomUUID();
    await client.query(
      `INSERT INTO plan_version
         (id, owner_id, plan_id, seq, candidate_id, created_by, availability_version)
       VALUES ($1, $2, $3, $4, $5, 'user', 1)`,
      [id, ownerId, planId, seq, candidateId],
    );
    return id;
  }

  async function insertBlock(
    ownerId: string,
    versionId: string,
    taskId: string,
    startAt: string,
    endAt: string,
    status = 'planned',
  ): Promise<string> {
    const id = randomUUID();
    await client.query(
      `INSERT INTO schedule_block
         (id, owner_id, plan_version_id, task_id, start_at, end_at, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [id, ownerId, versionId, taskId, startAt, endAt, status],
    );
    return id;
  }

  test('creates the planning tables with the documented column shapes', async () => {
    const result = await client.query<{ table_name: string }>(
      `SELECT table_name
         FROM information_schema.tables
        WHERE table_schema = $1 AND table_type = 'BASE TABLE'`,
      [schema],
    );
    const names = result.rows.map((row) => row.table_name);
    for (const table of PLANNING_TABLES) {
      expect({ table, present: names.includes(table) }).toEqual({ table, present: true });
    }

    const planColumns = await client.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = $1 AND table_name = 'plan'
        ORDER BY ordinal_position`,
      [schema],
    );
    expect(planColumns.rows.map((row) => row.column_name)).toEqual([
      'id',
      'owner_id',
      'scope',
      'status',
      'current_version_id',
      'availability_version',
      'created_at',
      'updated_at',
      'version',
      'deleted_at',
    ]);
  });

  test('availability_version only moves forward', async () => {
    const ownerId = await insertUser();
    await client.query(
      'INSERT INTO user_availability_version (owner_id, version) VALUES ($1, 1)',
      [ownerId],
    );
    await client.query(
      'UPDATE user_availability_version SET version = 2 WHERE owner_id = $1',
      [ownerId],
    );

    const equal = await queryFailure(
      client.query('UPDATE user_availability_version SET version = 2 WHERE owner_id = $1', [
        ownerId,
      ]),
    );
    expect(equal.code).toBe('23514');

    const backwards = await queryFailure(
      client.query('UPDATE user_availability_version SET version = 1 WHERE owner_id = $1', [
        ownerId,
      ]),
    );
    expect(backwards.code).toBe('23514');
  });

  test('owner-scoped composite FKs reject cross-owner children', async () => {
    const ownerA = await insertUser();
    const ownerB = await insertUser();
    const planId = await insertPlan(ownerA);

    const candidate = await queryFailure(
      client.query(
        `INSERT INTO plan_candidate
           (id, owner_id, plan_id, policy, feasible, input_hash, generator_version)
         VALUES ($1, $2, $3, 'balanced', true, 'sha256:test', 'scheduler@test')`,
        [randomUUID(), ownerB, planId],
      ),
    );
    expect(candidate.code).toBe('23503');
    expect(candidate.constraint).toBe('plan_candidate_plan_fk');

    const versionId = await insertVersion(ownerA, planId, 1);
    const taskB = await insertTask(ownerB);
    const block = await queryFailure(
      client.query(
        `INSERT INTO schedule_block
           (id, owner_id, plan_version_id, task_id, start_at, end_at)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          randomUUID(),
          ownerA,
          versionId,
          taskB,
          '2026-11-12T09:00:00Z',
          '2026-11-12T10:00:00Z',
        ],
      ),
    );
    expect(block.code).toBe('23503');
    expect(block.constraint).toBe('schedule_block_task_fk');
  });

  test('active schedule blocks cannot overlap, but superseded history can', async () => {
    const ownerId = await insertUser();
    const taskId = await insertTask(ownerId);
    const planId = await insertPlan(ownerId);
    const versionId = await insertVersion(ownerId, planId, 1);

    await insertBlock(
      ownerId,
      versionId,
      taskId,
      '2026-11-12T09:00:00Z',
      '2026-11-12T10:00:00Z',
    );

    const overlap = await queryFailure(
      client.query(
        `INSERT INTO schedule_block
           (id, owner_id, plan_version_id, task_id, start_at, end_at)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          randomUUID(),
          ownerId,
          versionId,
          taskId,
          '2026-11-12T09:30:00Z',
          '2026-11-12T10:30:00Z',
        ],
      ),
    );
    expect(overlap.code).toBe('23P01');
    expect(overlap.constraint).toBe('schedule_block_no_overlap');

    // A superseded block is history and does not participate in the EXCLUDE.
    await insertBlock(
      ownerId,
      versionId,
      taskId,
      '2026-11-12T09:30:00Z',
      '2026-11-12T10:30:00Z',
      'superseded',
    );

    // Adjacent active blocks are fine.
    await insertBlock(
      ownerId,
      versionId,
      taskId,
      '2026-11-12T10:00:00Z',
      '2026-11-12T11:00:00Z',
    );
  });

  test('plan versions are unique per plan sequence and approvals per idempotency key', async () => {
    const ownerId = await insertUser();
    const planId = await insertPlan(ownerId);
    const versionId = await insertVersion(ownerId, planId, 1);

    const duplicateSeq = await queryFailure(
      client.query(
        `INSERT INTO plan_version
           (id, owner_id, plan_id, seq, created_by, availability_version)
         VALUES ($1, $2, $3, 1, 'user', 1)`,
        [randomUUID(), ownerId, planId],
      ),
    );
    expect(duplicateSeq.code).toBe('23505');
    expect(duplicateSeq.constraint).toBe('plan_version_plan_seq_unique');

    const approve = (idempotencyKey: string) =>
      client.query(
        `INSERT INTO schedule_approval
           (id, owner_id, plan_version_id, idempotency_key, availability_version)
         VALUES ($1, $2, $3, $4, 1)`,
        [randomUUID(), ownerId, versionId, idempotencyKey],
      );
    await approve('0193a8f2-6c1e-7b41-9a2e-1f1d6a0b3c55');
    const duplicateApproval = await queryFailure(
      approve('0193a8f2-6c1e-7b41-9a2e-1f1d6a0b3c55'),
    );
    expect(duplicateApproval.code).toBe('23505');
    expect(duplicateApproval.constraint).toBe('schedule_approval_idempotency_key_unique');
  });

  test('rolls back 0007 with seeded rows and can reapply it', async () => {
    const ownerId = await insertUser();
    const taskId = await insertTask(ownerId);
    const planId = await insertPlan(ownerId);
    const candidateId = await insertCandidate(ownerId, planId);
    const versionId = await insertVersion(ownerId, planId, 1, candidateId);
    await insertBlock(ownerId, versionId, taskId, '2026-11-12T09:00:00Z', '2026-11-12T10:00:00Z');
    await client.query(
      `INSERT INTO schedule_approval
         (id, owner_id, plan_version_id, idempotency_key, availability_version)
       VALUES ($1, $2, $3, $4, 1)`,
      [randomUUID(), ownerId, versionId, '0193a8f2-6c1e-7b41-9a2e-1f1d6a0b3c55'],
    );
    await client.query(
      `INSERT INTO commitment_event
         (id, owner_id, title, start_at, end_at, time_zone)
       VALUES ($1, $2, 'Seminar', $3, $4, 'Asia/Seoul')`,
      [
        randomUUID(),
        ownerId,
        '2026-11-12T05:00:00Z',
        '2026-11-12T07:00:00Z',
      ],
    );
    await client.query(
      `INSERT INTO availability_rule
         (id, owner_id, weekday, start_local, end_local, time_zone, kind)
       VALUES ($1, $2, 1, '09:00', '18:00', 'Asia/Seoul', 'work')`,
      [randomUUID(), ownerId],
    );
    await client.query(
      `INSERT INTO availability_exception (id, owner_id, date, kind)
       VALUES ($1, $2, '2026-11-15', 'off')`,
      [randomUUID(), ownerId],
    );
    await client.query(
      'INSERT INTO user_availability_version (owner_id, version) VALUES ($1, 3)',
      [ownerId],
    );
    await client.end();
    client = await connect(schema);

    const rolledBack = await rollbackLatest({
      databaseUrl: requireDatabaseUrl(),
      schema,
      migrationsDir,
    });
    expect(rolledBack).toBe('0007_planning_core.sql');

    for (const table of PLANNING_TABLES) {
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
    expect(reapplied.applied).toEqual(['0007_planning_core.sql']);
  });
});
