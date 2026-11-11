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

const REPLANNING_TABLES = ['replan_proposal', 'replan_suppression'] as const;

describe.skipIf(!hasDatabase)('0012 replanning schema', () => {
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

  async function insertPlan(
    ownerId: string,
    taskId: string,
    seq = 1,
  ): Promise<{ planId: string; versionId: string }> {
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
       VALUES ($1, $2, $3, $4, 'user', 1)`,
      [versionId, ownerId, planId, seq],
    );
    return { planId, versionId };
  }

  async function insertProposal(options: {
    ownerId: string;
    planId: string;
    basePlanVersionId: string;
    reason?: string;
    trigger?: string;
    state?: string;
    resultPlanVersionId?: string | null;
  }): Promise<string> {
    const id = randomUUID();
    await client.query(
      `INSERT INTO replan_proposal
         (id, owner_id, plan_id, base_plan_version_id, result_plan_version_id,
          trigger_kind, reason_code, detected_at, availability_version,
          payload, state, created_at, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 1, $9, $10,
               '2026-11-11T09:00:00Z', '2026-11-11T21:00:00Z')`,
      [
        id,
        options.ownerId,
        options.planId,
        options.basePlanVersionId,
        options.resultPlanVersionId ?? null,
        options.trigger ?? 'deadline_risk',
        options.reason ?? 'deadline_slack_negative',
        '2026-11-11T08:00:00Z',
        { candidate: true },
        options.state ?? 'pending',
      ],
    );
    return id;
  }

  test('creates the M5 tables with their documented columns', async () => {
    const result = await client.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = $1 AND table_type = 'BASE TABLE'`,
      [schema],
    );
    const names = result.rows.map((row) => row.table_name);
    for (const table of REPLANNING_TABLES) {
      expect({ table, present: names.includes(table) }).toEqual({ table, present: true });
    }

    const proposalColumns = await client.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = $1 AND table_name = 'replan_proposal'
        ORDER BY ordinal_position`,
      [schema],
    );
    expect(proposalColumns.rows.map((row) => row.column_name)).toEqual([
      'id',
      'owner_id',
      'plan_id',
      'base_plan_version_id',
      'result_plan_version_id',
      'trigger_kind',
      'reason_code',
      'detected_at',
      'availability_version',
      'payload',
      'state',
      'created_at',
      'updated_at',
      'expires_at',
      'version',
    ]);

    const feedbackColumns = await client.query<{ column_name: string; column_default: string | null }>(
      `SELECT column_name, column_default FROM information_schema.columns
        WHERE table_schema = $1 AND table_name = 'estimation_feedback'
          AND column_name = 'excluded'`,
      [schema],
    );
    expect(feedbackColumns.rows).toEqual([{ column_name: 'excluded', column_default: 'false' }]);
  });

  test('at most one pending proposal per owner and reason is enforced', async () => {
    const ownerId = await insertUser();
    const taskId = await insertTask(ownerId);
    const { planId, versionId } = await insertPlan(ownerId, taskId);

    const first = await insertProposal({
      ownerId,
      planId,
      basePlanVersionId: versionId,
      reason: 'deadline_slack_negative',
    });
    const duplicate = await queryFailure(
      insertProposal({
        ownerId,
        planId,
        basePlanVersionId: versionId,
        reason: 'deadline_slack_negative',
      }),
    );
    expect(duplicate.code).toBe('23505');
    expect(duplicate.constraint).toBe('replan_proposal_owner_reason_pending_unique');

    // A different reason may be pending at the same time.
    await expect(
      insertProposal({
        ownerId,
        planId,
        basePlanVersionId: versionId,
        reason: 'commitment_overlap',
        trigger: 'commitment_conflict',
      }),
    ).resolves.toBeDefined();

    // Once the first is rejected, the same reason can be proposed again.
    await client.query(
      'UPDATE replan_proposal SET state = $1, version = version + 1 WHERE id = $2',
      ['rejected', first],
    );
    await expect(
      insertProposal({
        ownerId,
        planId,
        basePlanVersionId: versionId,
        reason: 'deadline_slack_negative',
      }),
    ).resolves.toBeDefined();

    // A second owner has an independent pending slot.
    const otherOwner = await insertUser();
    const otherTask = await insertTask(otherOwner);
    const otherPlan = await insertPlan(otherOwner, otherTask);
    await expect(
      insertProposal({
        ownerId: otherOwner,
        planId: otherPlan.planId,
        basePlanVersionId: otherPlan.versionId,
        reason: 'deadline_slack_negative',
      }),
    ).resolves.toBeDefined();
  });

  test('proposal state, trigger, reason and approval consistency are checked', async () => {
    const ownerId = await insertUser();
    const taskId = await insertTask(ownerId);
    const { planId, versionId } = await insertPlan(ownerId, taskId);

    const badState = await queryFailure(
      insertProposal({ ownerId, planId, basePlanVersionId: versionId, state: 'draft' }),
    );
    expect(badState.code).toBe('23514');
    expect(badState.constraint).toBe('replan_proposal_state_valid');

    const badTrigger = await queryFailure(
      insertProposal({ ownerId, planId, basePlanVersionId: versionId, trigger: 'capacity' }),
    );
    expect(badTrigger.code).toBe('23514');
    expect(badTrigger.constraint).toBe('replan_proposal_trigger_valid');

    const badReason = await queryFailure(
      insertProposal({ ownerId, planId, basePlanVersionId: versionId, reason: 'made_up' }),
    );
    expect(badReason.code).toBe('23514');
    expect(badReason.constraint).toBe('replan_proposal_reason_valid');

    const approvedWithoutResult = await queryFailure(
      insertProposal({ ownerId, planId, basePlanVersionId: versionId, state: 'approved' }),
    );
    expect(approvedWithoutResult.code).toBe('23514');
    expect(approvedWithoutResult.constraint).toBe('replan_proposal_approved_has_result');

    const secondVersion = randomUUID();
    await client.query(
      `INSERT INTO plan_version
         (id, owner_id, plan_id, seq, created_by, availability_version)
       VALUES ($1, $2, $3, 2, 'replan', 1)`,
      [secondVersion, ownerId, planId],
    );
    const approved = await insertProposal({
      ownerId,
      planId,
      basePlanVersionId: versionId,
      state: 'approved',
      resultPlanVersionId: secondVersion,
    });
    expect(approved).toBeDefined();

    const pendingWithResult = await queryFailure(
      insertProposal({
        ownerId,
        planId,
        basePlanVersionId: versionId,
        state: 'pending',
        resultPlanVersionId: secondVersion,
      }),
    );
    expect(pendingWithResult.code).toBe('23514');
    expect(pendingWithResult.constraint).toBe('replan_proposal_approved_has_result');
  });

  test('base and result plan versions must belong to the same plan and owner', async () => {
    const ownerId = await insertUser();
    const taskId = await insertTask(ownerId);
    const first = await insertPlan(ownerId, taskId, 1);
    const second = await insertPlan(ownerId, taskId, 1);

    const crossPlan = await queryFailure(
      insertProposal({
        ownerId,
        planId: first.planId,
        basePlanVersionId: second.versionId,
      }),
    );
    expect(crossPlan.code).toBe('23503');
    expect(crossPlan.constraint).toBe('replan_proposal_base_version_fk');

    const crossPlanResult = await queryFailure(
      insertProposal({
        ownerId,
        planId: first.planId,
        basePlanVersionId: first.versionId,
        state: 'approved',
        resultPlanVersionId: second.versionId,
      }),
    );
    expect(crossPlanResult.code).toBe('23503');
    expect(crossPlanResult.constraint).toBe('replan_proposal_result_version_fk');

    const otherOwner = await insertUser();
    const otherTask = await insertTask(otherOwner);
    const otherPlan = await insertPlan(otherOwner, otherTask);
    const crossOwner = await queryFailure(
      insertProposal({
        ownerId,
        planId: otherPlan.planId,
        basePlanVersionId: otherPlan.versionId,
      }),
    );
    expect(crossOwner.code).toBe('23503');
  });

  test('suppression rows are unique per owner and reason and expire in the future', async () => {
    const ownerId = await insertUser();
    const insert = (reason: string, until: string) =>
      client.query(
        `INSERT INTO replan_suppression (owner_id, reason_code, until)
         VALUES ($1, $2, $3)`,
        [ownerId, reason, until],
      );

    await insert('deadline_slack_negative', '2026-11-12T09:00:00Z');
    const duplicate = await queryFailure(
      insert('deadline_slack_negative', '2026-11-12T10:00:00Z'),
    );
    expect(duplicate.code).toBe('23505');
    expect(duplicate.constraint).toBe('replan_suppression_pkey');

    await expect(insert('commitment_overlap', '2026-11-12T09:00:00Z')).resolves.toBeDefined();

    const past = await queryFailure(insert('user_request', '2020-01-01T00:00:00Z'));
    expect(past.code).toBe('23514');
    expect(past.constraint).toBe('replan_suppression_until_after_created');

    const badReason = await queryFailure(insert('made_up', '2026-11-12T09:00:00Z'));
    expect(badReason.code).toBe('23514');
    expect(badReason.constraint).toBe('replan_suppression_reason_valid');
  });

  test('estimation feedback exclusion defaults to false and can be toggled', async () => {
    const ownerId = await insertUser();
    const taskId = await insertTask(ownerId);
    const feedbackId = randomUUID();
    await client.query(
      `INSERT INTO estimation_feedback
         (id, owner_id, task_id, estimated_p50, actual_focus_min, quality)
       VALUES ($1, $2, $3, 120, 95, 'outlier')`,
      [feedbackId, ownerId, taskId],
    );
    const initial = await client.query<{ excluded: boolean }>(
      'SELECT excluded FROM estimation_feedback WHERE id = $1',
      [feedbackId],
    );
    expect(initial.rows[0]?.excluded).toBe(false);

    await client.query(
      'UPDATE estimation_feedback SET excluded = true, version = version + 1 WHERE id = $1',
      [feedbackId],
    );
    const excluded = await client.query<{ excluded: boolean; version: number }>(
      'SELECT excluded, version FROM estimation_feedback WHERE id = $1',
      [feedbackId],
    );
    expect(excluded.rows[0]).toEqual({ excluded: true, version: 2 });
  });

  test('rolls back 0012 with seeded rows and can reapply it', async () => {
    const ownerId = await insertUser();
    const taskId = await insertTask(ownerId);
    const { planId, versionId } = await insertPlan(ownerId, taskId);
    await insertProposal({ ownerId, planId, basePlanVersionId: versionId });
    await client.query(
      `INSERT INTO replan_suppression (owner_id, reason_code, until)
       VALUES ($1, 'deadline_slack_negative', '2026-11-12T09:00:00Z')`,
      [ownerId],
    );
    await client.query(
      `INSERT INTO estimation_feedback
         (id, owner_id, task_id, estimated_p50, actual_focus_min, quality, excluded)
       VALUES ($1, $2, $3, 120, 95, 'excluded', true)`,
      [randomUUID(), ownerId, taskId],
    );

    await client.end();
    client = await connect(schema);

    const rolledBack = await rollbackLatest({
      databaseUrl: requireDatabaseUrl(),
      schema,
      migrationsDir,
    });
    expect(rolledBack).toBe('0012_replanning.sql');

    for (const table of REPLANNING_TABLES) {
      const gone = await client.query<{ name: string | null }>(
        'SELECT to_regclass($1)::text AS name',
        [table],
      );
      expect({ table, name: gone.rows[0]?.name }).toEqual({ table, name: null });
    }
    const column = await client.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = $1 AND table_name = 'estimation_feedback'
          AND column_name = 'excluded'`,
      [schema],
    );
    expect(column.rows.map((row) => row.column_name)).toEqual([]);
    const feedback = await client.query<{ name: string | null }>(
      `SELECT to_regclass('estimation_feedback')::text AS name`,
    );
    expect(feedback.rows[0]?.name).not.toBeNull();

    const reapplied = await migrate({
      databaseUrl: requireDatabaseUrl(),
      schema,
      migrationsDir,
    });
    expect(reapplied.applied).toEqual(['0012_replanning.sql']);
  });
});
