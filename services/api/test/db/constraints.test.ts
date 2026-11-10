import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { migrate } from '../../src/db/migrate.js';
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

describe.skipIf(!hasDatabase)('M1 schema constraints', () => {
  let schema: string;
  let client: PgClient;

  beforeEach(async () => {
    schema = makeSchemaName();
    await createSchema(schema);
    await migrate({
      databaseUrl: requireDatabaseUrl(),
      schema,
      migrationsDir,
    });
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

  async function insertProject(ownerId: string): Promise<string> {
    const id = randomUUID();
    await client.query(
      'INSERT INTO project (id, owner_id, title, kind) VALUES ($1, $2, $3, $4)',
      [id, ownerId, 'Project', 'normal'],
    );
    return id;
  }

  async function insertTask(ownerId: string): Promise<string> {
    const id = randomUUID();
    const projectId = await insertProject(ownerId);
    await client.query(
      'INSERT INTO task (id, owner_id, project_id, title_cache) VALUES ($1, $2, $3, $4)',
      [id, ownerId, projectId, 'task'],
    );
    return id;
  }

  test('rejects a self dependency', async () => {
    const ownerId = await insertUser();
    const taskId = await insertTask(ownerId);

    const error = await queryFailure(
      client.query(
        'INSERT INTO task_dependency (task_id, depends_on_task_id, owner_id) VALUES ($1, $1, $2)',
        [taskId, ownerId],
      ),
    );

    expect(error.code).toBe('23514');
    expect(error.constraint).toBe('task_dependency_no_self');
  });

  test('rejects a dependency whose endpoints belong to different owners', async () => {
    const ownerA = await insertUser();
    const ownerB = await insertUser();
    const taskA = await insertTask(ownerA);
    const taskB = await insertTask(ownerB);

    const error = await queryFailure(
      client.query(
        'INSERT INTO task_dependency (task_id, depends_on_task_id, owner_id) VALUES ($1, $2, $3)',
        [taskA, taskB, ownerA],
      ),
    );

    expect(error.code).toBe('23503');
    expect(error.constraint).toBe('task_dependency_depends_on_fk');
  });

  test('accepts a dependency between tasks of the same owner', async () => {
    const ownerId = await insertUser();
    const first = await insertTask(ownerId);
    const second = await insertTask(ownerId);

    await client.query(
      'INSERT INTO task_dependency (task_id, depends_on_task_id, owner_id) VALUES ($1, $2, $3)',
      [first, second, ownerId],
    );

    const rows = await client.query('SELECT 1 FROM task_dependency WHERE task_id = $1', [first]);
    expect(rows.rowCount).toBe(1);
  });

  test('rejects a duplicate idempotency key per owner', async () => {
    const ownerId = await insertUser();
    const insert = () =>
      client.query(
        `INSERT INTO idempotency_record
           (id, owner_id, key, route, request_hash, expires_at)
         VALUES ($1, $2, $3, $4, $5, now() + interval '24 hours')`,
        [randomUUID(), ownerId, 'create-task-1', 'POST /tasks', 'sha256:abc'],
      );

    await insert();
    const error = await queryFailure(insert());

    expect(error.code).toBe('23505');
    expect(error.constraint).toBe('idempotency_record_owner_key_unique');
  });

  function insertMapping(ownerId: string, entityId: string, externalId: string) {
    return client.query(
      `INSERT INTO external_provider_mapping
         (id, owner_id, entity_type, entity_id, provider, external_id)
       VALUES ($1, $2, 'task', $3, 'vikunja', $4)`,
      [randomUUID(), ownerId, entityId, externalId],
    );
  }

  test('enforces external provider mapping uniqueness in both directions', async () => {
    const ownerId = await insertUser();
    const taskA = await insertTask(ownerId);
    const taskB = await insertTask(ownerId);

    await insertMapping(ownerId, taskA, '412');

    const duplicateExternal = await queryFailure(insertMapping(ownerId, taskB, '412'));
    expect(duplicateExternal.code).toBe('23505');
    expect(duplicateExternal.constraint).toBe('external_provider_mapping_external_unique');

    const duplicateEntity = await queryFailure(insertMapping(ownerId, taskA, '413'));
    expect(duplicateEntity.code).toBe('23505');
    expect(duplicateEntity.constraint).toBe('external_provider_mapping_entity_unique');
  });

  test('rejects the same external id mapped by a different owner', async () => {
    const ownerA = await insertUser();
    const ownerB = await insertUser();
    const taskA = await insertTask(ownerA);
    const taskB = await insertTask(ownerB);

    await insertMapping(ownerA, taskA, '412');
    const error = await queryFailure(insertMapping(ownerB, taskB, '412'));

    expect(error.code).toBe('23505');
    expect(error.constraint).toBe('external_provider_mapping_external_unique');
  });

  test('rejects the same local entity mapped by a different owner', async () => {
    const ownerA = await insertUser();
    const ownerB = await insertUser();
    const taskA = await insertTask(ownerA);

    await insertMapping(ownerA, taskA, '412');
    const error = await queryFailure(insertMapping(ownerB, taskA, '413'));

    expect(error.code).toBe('23505');
    expect(error.constraint).toBe('external_provider_mapping_entity_unique');
  });

  test('enforces the positive version check', async () => {
    const ownerId = await insertUser();

    const error = await queryFailure(
      client.query(
        'INSERT INTO project (id, owner_id, title, version) VALUES ($1, $2, $3, 0)',
        [randomUUID(), ownerId, 'project'],
      ),
    );

    expect(error.code).toBe('23514');
    expect(error.constraint).toBe('project_version_positive');
  });

  test('allows only one pending job per unique key', async () => {
    const ownerId = await insertUser();
    const insertJob = () =>
      client.query(
        'INSERT INTO job (id, owner_id, kind, unique_key) VALUES ($1, $2, $3, $4)',
        [randomUUID(), ownerId, 'cleanup', 'cleanup:daily'],
      );

    const first = await insertJob();
    const duplicate = await queryFailure(insertJob());
    expect(duplicate.code).toBe('23505');
    expect(duplicate.constraint).toBe('job_unique_key_pending_idx');

    await client.query('UPDATE job SET status = $1 WHERE unique_key = $2', [
      'completed',
      'cleanup:daily',
    ]);
    const replacement = await insertJob();
    expect(replacement.rowCount).toBe(1);
    expect(first.rowCount).toBe(1);
  });
});
