import { ProjectCreateSchema, ProjectSchema } from '../src/index.js';
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
