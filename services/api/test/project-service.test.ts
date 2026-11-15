/**
 * FOLD-01: the rules `ProjectService.update` adds in front of the repository.
 * No database: the in-memory repository, and a recording one that behaves
 * like the Vikunja adapter where the two differ.
 */
import {
  NotFoundError,
  ValidationFailedError,
  VersionConflictError,
  type Id,
  type Page,
  type Project,
  type ProjectPatch,
  type ProjectRepository,
  type Version,
} from '@ohmydate/domain';
import { createInMemoryRepositories } from '@ohmydate/provider-native/in-memory';
import { FakeClock, createSeededIdGenerator } from '@ohmydate/testkit';
import { ProjectService } from '../src/application/project-service.js';

function setup() {
  const clock = new FakeClock();
  const ids = createSeededIdGenerator(20261116, clock);
  const repos = createInMemoryRepositories({ clock, ids });
  return {
    clock,
    repos,
    service: new ProjectService(repos.projects),
    alice: ids.next(),
    bob: ids.next(),
  };
}

const v = (value: number): Version => value as Version;

/** Counts writes and, like every adapter, gives any accepted patch a new version. */
class RecordingRepository implements ProjectRepository {
  readonly capabilities = { strictConcurrency: false, idempotentCreate: false };
  readonly writes: ProjectPatch[] = [];
  #project: Project;

  constructor(project: Project) {
    this.#project = project;
  }

  create(): Promise<Project> {
    throw new Error('not used');
  }

  async get(ownerId: Id, id: Id): Promise<Project | null> {
    return ownerId === this.#project.ownerId && id === this.#project.id ? this.#project : null;
  }

  list(): Promise<Page<Project>> {
    throw new Error('not used');
  }

  async update(_ownerId: Id, _id: Id, patch: ProjectPatch): Promise<Project> {
    this.writes.push(patch);
    this.#project = {
      ...this.#project,
      ...(patch.title === undefined ? {} : { title: patch.title }),
      ...(patch.archived === undefined ? {} : { archived: patch.archived }),
      version: v(this.#project.version + 1),
    };
    return this.#project;
  }

  getInbox(): Promise<Project> {
    throw new Error('not used');
  }
}

function recording(overrides: Partial<Project> = {}) {
  const clock = new FakeClock();
  const ids = createSeededIdGenerator(7, clock);
  const project: Project = {
    id: ids.next(),
    ownerId: ids.next(),
    title: 'Folder',
    kind: 'normal',
    archived: false,
    version: v(3),
    createdAt: clock.now(),
    updatedAt: clock.now(),
    ...overrides,
  };
  const repository = new RecordingRepository(project);
  return { project, repository, service: new ProjectService(repository), stranger: ids.next() };
}

test('renames and archives through the repository, one version per change', async () => {
  const { service, repos, alice } = setup();
  const project = await repos.projects.create(alice, { title: 'Thesiss' }, 'k1');

  const renamed = await service.update(alice, project.id, { title: 'Thesis' }, v(1));
  expect(renamed).toMatchObject({ title: 'Thesis', archived: false, version: 2, kind: 'normal' });
  const archived = await service.update(alice, project.id, { archived: true }, v(2));
  expect(archived).toMatchObject({ title: 'Thesis', archived: true, version: 3 });
  expect(await repos.projects.get(alice, project.id)).toEqual(archived);
});

test('an empty patch returns the current project and never reaches the repository', async () => {
  const { project, repository, service } = recording();

  expect(await service.update(project.ownerId, project.id, {}, v(3))).toEqual(project);
  expect(repository.writes).toEqual([]);

  // The repository itself would have given the empty patch a new version.
  const direct = await repository.update(project.ownerId, project.id, {});
  expect(direct.version).toBe(4);

  // A patch with one field is passed on as it is.
  await service.update(project.ownerId, project.id, { archived: false }, v(4));
  expect(repository.writes).toEqual([{}, { archived: false }]);
});

test('an empty patch is still refused for a stranger and for a stale version', async () => {
  const { project, repository, service, stranger } = recording();

  await expect(service.update(stranger, project.id, {}, v(3))).rejects.toBeInstanceOf(NotFoundError);
  await expect(service.update(project.ownerId, project.id, {}, v(2))).rejects.toBeInstanceOf(
    VersionConflictError,
  );
  expect(repository.writes).toEqual([]);
});

test("another owner's project is NotFound whatever the version or the patch says", async () => {
  const { service, repos, alice, bob } = setup();
  const project = await repos.projects.create(alice, { title: 'Private' }, 'k1');

  for (const [patch, version] of [
    [{ title: 'Mine now' }, 1],
    [{ archived: true }, 9],
    [{}, 1],
    [{ title: '   ' }, 1],
  ] as const) {
    const attempt = service.update(bob, project.id, patch, v(version));
    await expect(attempt).rejects.toBeInstanceOf(NotFoundError);
    await expect(attempt).rejects.not.toBeInstanceOf(VersionConflictError);
  }
  expect(await repos.projects.get(alice, project.id)).toEqual(project);
});

test('checks run in the order owner, version, rules', async () => {
  const { service, repos, alice } = setup();
  const inbox = await repos.projects.getInbox(alice);

  // A stale version wins over the Inbox rule and over a blank title.
  await expect(service.update(alice, inbox.id, { archived: true }, v(5))).rejects.toBeInstanceOf(
    VersionConflictError,
  );
  await expect(service.update(alice, inbox.id, { title: '   ' }, v(5))).rejects.toBeInstanceOf(
    VersionConflictError,
  );
  const blank = service.update(alice, inbox.id, { title: '   ' }, v(1));
  await expect(blank).rejects.toBeInstanceOf(ValidationFailedError);
  await expect(blank).rejects.toMatchObject({
    issues: [{ path: 'title', message: 'title must not be empty' }],
  });
  expect(await repos.projects.getInbox(alice)).toEqual(inbox);
});

test('the Inbox is never archived, and the refusal does not depend on the repository', async () => {
  const { project, repository, service } = recording({ kind: 'inbox', title: 'Inbox' });

  const refused = service.update(project.ownerId, project.id, { archived: true }, v(3));
  await expect(refused).rejects.toBeInstanceOf(ValidationFailedError);
  await expect(refused).rejects.toMatchObject({
    issues: [{ path: 'archived', message: 'the inbox project cannot be archived or deleted' }],
  });
  await expect(
    service.update(project.ownerId, project.id, { title: 'Gone', archived: true }, v(3)),
  ).rejects.toBeInstanceOf(ValidationFailedError);
  expect(repository.writes).toEqual([]);

  // Renaming it is allowed; it stays the Inbox.
  const renamed = await service.update(project.ownerId, project.id, { title: '바깥' }, v(3));
  expect(renamed).toMatchObject({ kind: 'inbox', title: '바깥', archived: false, version: 4 });
});

test('an archived project is renamed only by a patch that brings it back', async () => {
  const { project, repository, service } = recording({ archived: true });

  for (const patch of [{ title: 'Renamed' }, { title: 'Renamed', archived: true }]) {
    const refused = service.update(project.ownerId, project.id, patch, v(3));
    await expect(refused).rejects.toBeInstanceOf(ValidationFailedError);
    await expect(refused).rejects.toMatchObject({ issues: [{ path: 'title' }] });
  }
  expect(repository.writes).toEqual([]);

  // Archiving it again and bringing it back (with or without a new title) pass.
  await service.update(project.ownerId, project.id, { archived: true }, v(3));
  const back = await service.update(
    project.ownerId,
    project.id,
    { title: 'Renamed', archived: false },
    v(4),
  );
  expect(back).toMatchObject({ title: 'Renamed', archived: false, version: 5 });
  expect(repository.writes).toEqual([{ archived: true }, { title: 'Renamed', archived: false }]);
});
