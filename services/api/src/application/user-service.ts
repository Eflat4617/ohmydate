import type { Id, InboxProjectLookup } from '@ohmydate/domain';
import type { UserRecord, UserRepository } from './ports.js';

export interface CreateUserInput {
  readonly id: Id;
  readonly email: string;
  readonly passwordHash: string;
  readonly timeZone?: string;
  readonly locale?: string;
}

/**
 * ADR-018: every new user owns exactly one Inbox. The CLI and the test harness
 * create users through this service so the invariant holds outside HTTP.
 */
export class UserService {
  readonly #users: UserRepository;
  readonly #inbox: InboxProjectLookup;

  constructor(users: UserRepository, inbox: InboxProjectLookup) {
    this.#users = users;
    this.#inbox = inbox;
  }

  async create(input: CreateUserInput): Promise<UserRecord> {
    const user = await this.#users.insert(input);
    await this.#inbox.getInbox(user.id);
    return user;
  }
}
