import { TaskCreateSchema, TaskPatchSchema, TaskSchema } from '../src/index.js';
import { compile } from './ajv.js';

const ID = '0193a8f2-6c1e-7b41-9a2e-1f1d6a0b3c55';

test('TaskCreate compiles in Ajv strict mode', () => {
  expect(() => compile(TaskCreateSchema)).not.toThrow();
});

test('TaskCreate accepts a minimal valid payload', () => {
  const validate = compile(TaskCreateSchema);
  expect(validate({ title: 'Write report' })).toBe(true);
});

test('TaskCreate rejects an empty title', () => {
  const validate = compile(TaskCreateSchema);
  expect(validate({ title: '' })).toBe(false);
});

test('TaskCreate rejects a title longer than 200 characters', () => {
  const validate = compile(TaskCreateSchema);
  expect(validate({ title: 'a'.repeat(201) })).toBe(false);
  expect(validate({ title: 'a'.repeat(200) })).toBe(true);
});

test('TaskCreate rejects extra properties', () => {
  const validate = compile(TaskCreateSchema);
  expect(validate({ title: 'Write report', vikunjaId: 42 })).toBe(false);
});

test('TaskCreate validates branded ids and enums', () => {
  const validate = compile(TaskCreateSchema);
  expect(validate({ title: 'Write report', projectId: ID, priority: 4 })).toBe(true);
  expect(validate({ title: 'Write report', priority: 0 })).toBe(false);
  expect(validate({ title: 'Write report', priority: 5 })).toBe(false);
  expect(validate({ title: 'Write report', status: 'blocked' })).toBe(false);
  expect(
    validate({ title: 'Write report', projectId: '0193a8f2-6c1e-4b41-9a2e-1f1d6a0b3c55' }),
  ).toBe(false);
});

test('TaskPatch accepts empty patch and nullable clears', () => {
  const validate = compile(TaskPatchSchema);
  expect(validate({})).toBe(true);
  expect(validate({ description: null, dueAt: null, session: null })).toBe(true);
  expect(validate({ unknown: true })).toBe(false);
});

test('Task schema exposes no provider-specific numeric ids', () => {
  const validate = compile(TaskSchema);
  const task = {
    id: ID,
    ownerId: ID,
    projectId: ID,
    title: 'Write report',
    status: 'todo',
    splittable: true,
    priority: 2,
    dependsOn: [],
    version: 1,
    createdAt: '2026-11-11T00:00:00.000Z',
    updatedAt: '2026-11-11T00:00:00.000Z',
    external: [{ provider: 'vikunja', externalId: '412' }],
  };
  expect(validate(task)).toBe(true);
  expect(validate({ ...task, external: [{ provider: 'vikunja', externalId: 412 }] })).toBe(false);
  expect(validate({ ...task, vikunjaId: 412 })).toBe(false);
});
