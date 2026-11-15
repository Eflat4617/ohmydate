import {
  ProjectCreateSchema,
  ProjectIdParamsSchema,
  ProjectPatchSchema,
  ProjectSchema,
} from '../src/index.js';
import { compile } from './ajv.js';

const ID = '0193a8f2-6c1e-7b41-9a2e-1f1d6a0b3c55';

const project = {
  id: ID,
  ownerId: ID,
  title: 'Inbox',
  kind: 'inbox',
  archived: false,
  version: 1,
  createdAt: '2026-11-11T00:00:00.000Z',
  updatedAt: '2026-11-11T00:00:00.000Z',
};

test('Project requires a supported kind', () => {
  const validate = compile(ProjectSchema);
  expect(validate(project)).toBe(true);
  expect(validate({ ...project, kind: 'normal' })).toBe(true);
  expect(validate({ ...project, kind: undefined })).toBe(false);
  expect(validate({ ...project, kind: 'archive' })).toBe(false);
});

test('ProjectCreate cannot create an inbox project', () => {
  const validate = compile(ProjectCreateSchema);
  expect(validate({ title: 'Work' })).toBe(true);
  expect(validate({ title: 'Inbox', kind: 'inbox' })).toBe(false);
  expect(validate({ title: 'Inbox', kind: 'normal' })).toBe(false);
});

test('ProjectPatch changes only the title and the archived flag (FOLD-01)', () => {
  const validate = compile(ProjectPatchSchema);
  expect(validate({})).toBe(true);
  expect(validate({ title: 'Thesis' })).toBe(true);
  expect(validate({ archived: true })).toBe(true);
  expect(validate({ title: 'Thesis', archived: false })).toBe(true);
  expect(validate({ title: 'x'.repeat(200) })).toBe(true);

  // A patch cannot turn a project into the Inbox, move it or touch its version.
  expect(validate({ kind: 'inbox' })).toBe(false);
  expect(validate({ title: 'Thesis', ownerId: ID })).toBe(false);
  expect(validate({ version: 2 })).toBe(false);
  expect(validate({ deletedAt: '2026-11-16T00:00:00.000Z' })).toBe(false);
  // Title validation as create.
  expect(validate({ title: '' })).toBe(false);
  expect(validate({ title: 'x'.repeat(201) })).toBe(false);
  expect(validate({ title: null })).toBe(false);
  expect(validate({ title: 7 })).toBe(false);
  expect(validate({ archived: 'true' })).toBe(false);
  expect(validate({ archived: null })).toBe(false);
});

test('ProjectIdParams takes one UUIDv7 id', () => {
  const validate = compile(ProjectIdParamsSchema);
  expect(validate({ id: ID })).toBe(true);
  expect(validate({ id: 'not-a-uuid' })).toBe(false);
  expect(validate({})).toBe(false);
  expect(validate({ id: ID, projectId: ID })).toBe(false);
});
