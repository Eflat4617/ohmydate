import type { Id, ProjectRepository } from '@ohmydate/domain';
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
 * serves. The served repository also guarantees it lazily on first read/write,
 * so a CLI-created user (no project repository) still gets exactly one Inbox.
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
    if (this.#projects !== undefined) {
      await this.#projects.getInbox(user.id);
    }
    return user;
  }
}
