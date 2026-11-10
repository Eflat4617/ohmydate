import { Type, type Static, type TLiteral } from '@sinclair/typebox';
import { CursorSchema, IdSchema, InstantSchema, VersionSchema, pageSchema } from './common.js';

export const TASK_STATUSES = ['todo', 'in_progress', 'done'] as const;

export type TaskStatus = (typeof TASK_STATUSES)[number];

export const TaskStatusSchema = Type.Union(
  TASK_STATUSES.map((status) => Type.Literal(status)) as TLiteral<TaskStatus>[],
);

export const TaskPrioritySchema = Type.Integer({ minimum: 1, maximum: 4 });

export const SessionWindowSchema = Type.Object(
  {
    minMinutes: Type.Integer({ minimum: 1, maximum: 1440 }),
    maxMinutes: Type.Integer({ minimum: 1, maximum: 1440 }),
  },
  { additionalProperties: false },
);

export const ExternalProviderRefSchema = Type.Object(
  {
    provider: Type.Literal('vikunja'),
    externalId: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false },
);

const TaskTitleSchema = Type.String({ minLength: 1, maxLength: 200 });
const TaskDescriptionSchema = Type.String({ maxLength: 20_000 });

export const TaskCreateSchema = Type.Object(
  {
    projectId: Type.Optional(IdSchema),
    title: TaskTitleSchema,
    description: Type.Optional(TaskDescriptionSchema),
    status: Type.Optional(TaskStatusSchema),
    dueAt: Type.Optional(InstantSchema),
    splittable: Type.Optional(Type.Boolean()),
    session: Type.Optional(SessionWindowSchema),
    priority: Type.Optional(TaskPrioritySchema),
    dependsOn: Type.Optional(Type.Array(IdSchema)),
  },
  { additionalProperties: false, $id: 'TaskCreate' },
);

export const TaskPatchSchema = Type.Object(
  {
    projectId: Type.Optional(IdSchema),
    title: Type.Optional(TaskTitleSchema),
    description: Type.Optional(Type.Union([Type.String({ maxLength: 20_000 }), Type.Null()])),
    status: Type.Optional(TaskStatusSchema),
    dueAt: Type.Optional(Type.Union([InstantSchema, Type.Null()])),
    splittable: Type.Optional(Type.Boolean()),
    session: Type.Optional(Type.Union([SessionWindowSchema, Type.Null()])),
    priority: Type.Optional(TaskPrioritySchema),
    dependsOn: Type.Optional(Type.Array(IdSchema)),
  },
  { additionalProperties: false, $id: 'TaskPatch' },
);

export const TaskSchema = Type.Object(
  {
    id: IdSchema,
    ownerId: IdSchema,
    projectId: IdSchema,
    title: TaskTitleSchema,
    description: Type.Optional(TaskDescriptionSchema),
    status: TaskStatusSchema,
    dueAt: Type.Optional(InstantSchema),
    splittable: Type.Boolean(),
    session: Type.Optional(SessionWindowSchema),
    priority: TaskPrioritySchema,
    dependsOn: Type.Array(IdSchema),
    version: VersionSchema,
    createdAt: InstantSchema,
    updatedAt: InstantSchema,
    deletedAt: Type.Optional(InstantSchema),
    external: Type.Array(ExternalProviderRefSchema),
  },
  { additionalProperties: false, $id: 'Task' },
);

export const TaskIdParamsSchema = Type.Object(
  {
    id: IdSchema,
  },
  { additionalProperties: false, $id: 'TaskIdParams' },
);

export const TaskListQuerySchema = Type.Object(
  {
    projectId: Type.Optional(IdSchema),
    status: Type.Optional(TaskStatusSchema),
    cursor: Type.Optional(CursorSchema),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
  },
  { additionalProperties: false, $id: 'TaskListQuery' },
);

export const TaskDependencyCreateSchema = Type.Object(
  {
    dependsOnTaskId: IdSchema,
  },
  { additionalProperties: false, $id: 'TaskDependencyCreate' },
);

export const TaskDependencySchema = Type.Object(
  {
    taskId: IdSchema,
    dependsOnTaskId: IdSchema,
  },
  { additionalProperties: false, $id: 'TaskDependency' },
);

export const PageTaskSchema = pageSchema(TaskSchema, { id: 'PageTask' });

export type TaskCreate = Static<typeof TaskCreateSchema>;
export type TaskPatch = Static<typeof TaskPatchSchema>;
export type Task = Static<typeof TaskSchema>;
export type TaskIdParams = Static<typeof TaskIdParamsSchema>;
export type TaskListQuery = Static<typeof TaskListQuerySchema>;
export type TaskDependencyCreate = Static<typeof TaskDependencyCreateSchema>;
export type TaskDependency = Static<typeof TaskDependencySchema>;
