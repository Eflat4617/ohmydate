import { Type, type Static } from '@sinclair/typebox';
import { IdSchema, InstantSchema, VersionSchema, pageSchema } from './common.js';

const ProjectTitleSchema = Type.String({ minLength: 1, maxLength: 200 });

export const ProjectCreateSchema = Type.Object(
  {
    title: ProjectTitleSchema,
  },
  { additionalProperties: false, $id: 'ProjectCreate' },
);

export const ProjectSchema = Type.Object(
  {
    id: IdSchema,
    ownerId: IdSchema,
    title: ProjectTitleSchema,
    archived: Type.Boolean(),
    version: VersionSchema,
    createdAt: InstantSchema,
    updatedAt: InstantSchema,
  },
  { additionalProperties: false, $id: 'Project' },
);

export const ProjectPatchSchema = Type.Object(
  {
    title: Type.Optional(ProjectTitleSchema),
    archived: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false, $id: 'ProjectPatch' },
);

export const PageProjectSchema = pageSchema(ProjectSchema, { id: 'PageProject' });

export type ProjectCreate = Static<typeof ProjectCreateSchema>;
export type Project = Static<typeof ProjectSchema>;
export type ProjectPatch = Static<typeof ProjectPatchSchema>;
