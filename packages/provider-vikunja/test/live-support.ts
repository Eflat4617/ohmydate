import { NotFoundError, type Id } from '@ohmydate/domain';
import { VikunjaClient } from '../src/client.js';
import type { MappingStore } from '../src/mapping-store.js';

export interface LiveUser {
  readonly userId: number;
  readonly username: string;
  /**
   * Synthetic, run-scoped API token. Test-only: it is never logged and never
   * leaves the process; it lets a test build a client with an injected fetch
   * wrapper without mutating the shared client.
   */
  readonly token: string;
  readonly client: VikunjaClient;
}

// Scoped to exactly what the adapter exercises. Token management itself needs
// a JWT, so the bootstrap below logs in first and keeps the JWT only long
// enough to mint the token (ADR-016 §6).
const TOKEN_PERMISSIONS: Readonly<Record<string, readonly string[]>> = {
  projects: ['create', 'read_all', 'read_one', 'update', 'delete', 'permanent'],
  tasks: [
    'create',
    'read_all',
    'read_one',
    'update',
    'delete',
    'deleted',
    'permanent',
  ],
  tasks_relations: ['create', 'delete'],
  // ADR-018 reads the user's default project, which is exposed on GET /user.
  other: ['user'],
};

function uniqueSuffix(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export async function createSyntheticUser(baseUrl: string): Promise<LiveUser> {
  const username = `m105-${uniqueSuffix()}`;
  const password = `pw-${uniqueSuffix()}-${uniqueSuffix()}`;
  const anon = new VikunjaClient({ baseUrl });

  const registered = await anon.register({
    username,
    email: `${username}@example.invalid`,
    password,
  });
  const jwt = await anon.login(username, password);
  anon.setToken(jwt);

  const created = await anon.createApiToken({
    title: `m105 adapter token ${username}`,
    expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    permissions: TOKEN_PERMISSIONS,
  });
  anon.setToken(created.token);

  return { userId: registered.id, username, token: created.token, client: anon };
}

async function ignoreNotFound(action: () => Promise<void>): Promise<void> {
  try {
    await action();
  } catch (error) {
    if (!(error instanceof NotFoundError)) throw error;
  }
}

/**
 * Removes every task owned by a synthetic test user (projects are left in
 * place, including the default Inbox). Only data created by this run is touched;
 * the account itself stays so repeated runs remain cheap against the auth rate
 * limit.
 */
export async function purgeUserData(
  client: VikunjaClient,
  _mappings: MappingStore,
  _ownerId: Id,
): Promise<void> {
  void _mappings;
  void _ownerId;
  for (const task of await client.listAllTasks()) {
    await ignoreNotFound(() => client.deleteTask(String(task.id)));
    await ignoreNotFound(() => client.permanentDeleteTask(String(task.id)));
  }
  for (const task of await client.listAllDeletedTasks()) {
    await ignoreNotFound(() => client.permanentDeleteTask(String(task.id)));
  }
}
