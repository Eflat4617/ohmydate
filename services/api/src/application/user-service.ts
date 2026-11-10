import { supportsInbox, type Id, type ProjectRepository } from '@ohmydate/domain';
import type { UserRecord, UserRepository } from './ports.js';

export interface CreateUserInput {
  readonly id: Id;
  readonly email: string;
  readonly passwordHash: string;
  readonly timeZone?: string;
  readonly locale?: string;
}

/**
 * ADR-018: user creation seeds the Inbox in the same ProjectRepository the API
 * serves. A repository without getInbox is left to create it lazily.
 */
export class UserService {
  readonly #users: UserRepository;
  readonly #projects: ProjectRepository | undefined;

  constructor(users: UserRepository, projects?: ProjectRepository) {
    this.#users = users;
    this.#projects = projects;
  }

  async create(input: CreateUserInput): Promise<UserRecord> {
    const user = await this.#users.insert(input);
    if (this.#projects !== undefined && supportsInbox(this.#projects)) {
      await this.#projects.getInbox(user.id);
    }
    return user;
  }
}
