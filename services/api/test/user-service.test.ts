import type { Id, InboxProjectLookup, Instant, Project, Version } from '@ohmydate/domain';
import type { UserRecord, UserRepository } from '../src/application/ports.js';
import { UserService } from '../src/application/user-service.js';

const userId = '01900000-0000-7000-8000-000000000001' as Id;

function userRecord(): UserRecord {
  return {
    id: userId,
    email: 'new@example.test',
    passwordHash: 'hash',
    timeZone: 'UTC',
    locale: 'en',
    version: 1,
    createdAt: '2026-11-11T00:00:00.000Z' as Instant,
    updatedAt: '2026-11-11T00:00:00.000Z' as Instant,
  };
}

describe('UserService', () => {
  it('creates the Inbox for every new user', async () => {
    const insert = vi.fn(async () => userRecord());
    const inboxProject: Project = {
      id: '01900000-0000-7000-8000-000000000002' as Id,
      ownerId: userId,
      title: 'Inbox',
      kind: 'inbox',
      archived: false,
      version: 1 as Version,
      createdAt: '2026-11-11T00:00:00.000Z' as Instant,
      updatedAt: '2026-11-11T00:00:00.000Z' as Instant,
    };
    const getInbox = vi.fn(async () => inboxProject);
    const users = { insert } as unknown as UserRepository;
    const inbox = { getInbox } as InboxProjectLookup;

    const created = await new UserService(users, inbox).create({
      id: userId,
      email: 'new@example.test',
      passwordHash: 'hash',
    });

    expect(created.id).toBe(userId);
    expect(insert).toHaveBeenCalledWith({
      id: userId,
      email: 'new@example.test',
      passwordHash: 'hash',
    });
    expect(getInbox).toHaveBeenCalledWith(userId);
  });
});
