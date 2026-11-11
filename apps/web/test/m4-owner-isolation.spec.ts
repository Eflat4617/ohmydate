import { createPinia } from 'pinia';
import { newActionId, plannerClient, type User, type WorkSession } from '../src/api';
import { sessionJournal } from '../src/session/journal';
import { useAuthStore } from '../src/stores/auth';
import { useSessionStore } from '../src/stores/session';
import { TODAY_BLOCK_ONE_ID, TODAY_TASK_ONE_ID, createUuidV7, mockDb } from '../src/mocks/db';

function otherUser(base: User): User {
  return {
    ...base,
    id: createUuidV7(),
    email: 'other-owner@example.test',
    version: 1,
  };
}

describe('owner isolation', () => {
  beforeEach(async () => {
    localStorage.clear();
    for (const owner of ['owner-a', 'owner-b', null] as const) {
      sessionJournal.setOwner(owner);
      await sessionJournal.clear();
    }
  });

  afterAll(() => {
    sessionJournal.setOwner(null);
  });

  it('namespaces session storage and the journal by owner and clears memory on account switch', async () => {
    const pinia = createPinia();
    const auth = useAuthStore(pinia);
    const sessions = useSessionStore(pinia);
    const userA = mockDb.user;
    const userB = otherUser(userA);

    const login = vi.spyOn(plannerClient, 'login').mockResolvedValue();
    const logout = vi.spyOn(plannerClient, 'logout').mockResolvedValue();
    const getMe = vi.spyOn(plannerClient, 'getMe');

    getMe.mockResolvedValue(userA);
    await auth.login('a@example.test', 'pw');

    const sessionA = await plannerClient.createSession(
      {
        taskId: TODAY_TASK_ONE_ID,
        blockId: TODAY_BLOCK_ONE_ID,
        clientStartedAt: new Date().toISOString(),
        clientId: 'owner-a-client',
      },
      newActionId('session'),
    );
    sessions.remember(sessionA);
    await sessionJournal.append({
      id: createUuidV7(),
      sessionId: sessionA.id,
      kind: 'pause',
      clientAt: new Date().toISOString(),
      idempotencyKey: newActionId('pause'),
      expectedVersion: sessionA.version,
    });
    expect(Object.keys(localStorage).some((key) => key.includes(userA.id))).toBe(true);

    await auth.logout();
    expect(logout).toHaveBeenCalledTimes(1);
    expect(sessions.active).toBeNull();
    expect(await sessionJournal.list()).toHaveLength(0);

    getMe.mockResolvedValue(userB);
    await auth.login('b@example.test', 'pw');
    expect(sessions.active).toBeNull();
    expect(await sessionJournal.list()).toHaveLength(0);

    const sessionB: WorkSession = {
      ...sessionA,
      id: createUuidV7(),
      taskId: TODAY_TASK_ONE_ID,
      clientId: 'owner-b-client',
    };
    sessions.remember(sessionB);
    await sessionJournal.append({
      id: createUuidV7(),
      sessionId: sessionB.id,
      kind: 'resume',
      clientAt: new Date().toISOString(),
      idempotencyKey: newActionId('resume'),
      expectedVersion: sessionB.version,
    });

    getMe.mockResolvedValue(userA);
    await auth.login('a@example.test', 'pw');
    expect(sessions.get(sessionA.id)?.id).toBe(sessionA.id);
    expect(sessions.get(sessionB.id)).toBeNull();
    const ownerAQueue = await sessionJournal.list();
    expect(ownerAQueue.map((event) => event.sessionId)).toEqual([sessionA.id]);

    sessionJournal.setOwner(null);
    await sessionJournal.clear();
    sessions.setOwner(null);
    expect(login).toHaveBeenCalled();
  });
});
