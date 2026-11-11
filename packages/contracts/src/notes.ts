import { Type, type Static, type TLiteral } from '@sinclair/typebox';
import {
  LINK_TARGET_KINDS,
  MAX_LINKS_PER_NOTE,
  MAX_NOTE_BODY_LENGTH,
  MAX_NOTE_TITLE_LENGTH,
  NOTE_SENSITIVITIES,
  NOTE_SOURCES,
  type LinkTargetKind,
  type NoteSensitivity,
  type NoteSource,
} from '@ohmydate/domain';
import { CursorSchema, IdSchema, InstantSchema, VersionSchema, pageSchema } from './common.js';

/**
 * M6 notes (ContextDocument) contracts (04 §3, 05 §9/§10/§12, 07 §7, 08 §2.7).
 *
 * Notes are planner-owned Markdown; `bodyMd` is always the raw stored Markdown and the
 * API never renders or returns HTML (sanitising for display is the web client's job).
 * Notes are never synced to the task provider: the only bridge is the one-time
 * `POST /tasks/{id}:promote-description` copy.
 */

export const DocumentLinkTargetKindSchema = Type.Union(
  LINK_TARGET_KINDS.map((kind) => Type.Literal(kind)) as TLiteral<LinkTargetKind>[],
);

export const NoteSensitivitySchema = Type.Union(
  NOTE_SENSITIVITIES.map((level) => Type.Literal(level)) as TLiteral<NoteSensitivity>[],
);

export const NoteSourceSchema = Type.Union(
  NOTE_SOURCES.map((source) => Type.Literal(source)) as TLiteral<NoteSource>[],
);

const NoteTitleSchema = Type.String({ minLength: 1, maxLength: MAX_NOTE_TITLE_LENGTH });
/** Code points (Ajv `unicode`); 65 536 code points always fit the 256 KiB column check. */
const NoteBodySchema = Type.String({ maxLength: MAX_NOTE_BODY_LENGTH });

export const DocumentLinkCreateSchema = Type.Object(
  {
    targetKind: DocumentLinkTargetKindSchema,
    targetId: IdSchema,
  },
  { additionalProperties: false, $id: 'DocumentLinkCreate' },
);

export const DocumentLinkSchema = Type.Object(
  {
    id: IdSchema,
    documentId: IdSchema,
    targetKind: DocumentLinkTargetKindSchema,
    targetId: IdSchema,
    createdAt: InstantSchema,
  },
  { additionalProperties: false, $id: 'DocumentLink' },
);

export const ContextDocumentSchema = Type.Object(
  {
    id: IdSchema,
    ownerId: IdSchema,
    title: NoteTitleSchema,
    bodyMd: NoteBodySchema,
    sensitivity: NoteSensitivitySchema,
    /** Explicit per-note opt-in for AI context; default false (05 §12). */
    llmAllowed: Type.Boolean(),
    source: NoteSourceSchema,
    sourceTaskId: Type.Optional(IdSchema),
    links: Type.Array(DocumentLinkSchema, { maxItems: MAX_LINKS_PER_NOTE }),
    version: VersionSchema,
    createdAt: InstantSchema,
    updatedAt: InstantSchema,
  },
  { additionalProperties: false, $id: 'ContextDocument' },
);

export const ContextDocumentCreateSchema = Type.Object(
  {
    title: NoteTitleSchema,
    bodyMd: Type.Optional(NoteBodySchema),
    sensitivity: Type.Optional(NoteSensitivitySchema),
    llmAllowed: Type.Optional(Type.Boolean()),
    links: Type.Optional(Type.Array(DocumentLinkCreateSchema, { maxItems: MAX_LINKS_PER_NOTE })),
  },
  { additionalProperties: false, $id: 'ContextDocumentCreate' },
);

export const ContextDocumentPatchSchema = Type.Object(
  {
    title: Type.Optional(NoteTitleSchema),
    bodyMd: Type.Optional(NoteBodySchema),
    sensitivity: Type.Optional(NoteSensitivitySchema),
    llmAllowed: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false, minProperties: 1, $id: 'ContextDocumentPatch' },
);

export const ContextDocumentPageSchema = pageSchema(ContextDocumentSchema, {
  id: 'ContextDocumentPage',
});

/**
 * `q` searches title + body through the `simple` tsvector (prefix match per token;
 * there is no Korean stemmer). `targetKind` + `targetId` (both or neither) list the
 * notes linked to one goal/project/task.
 */
export const ContextDocumentListQuerySchema = Type.Object(
  {
    q: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
    targetKind: Type.Optional(DocumentLinkTargetKindSchema),
    targetId: Type.Optional(IdSchema),
    cursor: Type.Optional(CursorSchema),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
  },
  { additionalProperties: false, $id: 'ContextDocumentListQuery' },
);

export const ContextDocumentIdParamsSchema = Type.Object(
  { id: IdSchema },
  { additionalProperties: false, $id: 'ContextDocumentIdParams' },
);

export const DocumentLinkParamsSchema = Type.Object(
  { id: IdSchema, linkId: IdSchema },
  { additionalProperties: false, $id: 'DocumentLinkParams' },
);

export const NOTE_AI_USAGE_STATUSES = ['pending', 'succeeded', 'failed', 'budget_exceeded'] as const;
export type NoteAiUsageStatusName = (typeof NOTE_AI_USAGE_STATUSES)[number];

export const NoteAiUsageStatusSchema = Type.Union(
  NOTE_AI_USAGE_STATUSES.map((status) => Type.Literal(status)) as TLiteral<NoteAiUsageStatusName>[],
);

const SectionHashSchema = Type.String({ pattern: '^[0-9a-f]{16}$' });

/**
 * One AI call that received sections of this note (note_ai_usage). Ids, hashes and
 * counts only: the sent text is never stored. `stale` is true when the note was edited
 * after the call (documentVersion < current version).
 */
export const NoteAiUsageSchema = Type.Object(
  {
    id: IdSchema,
    documentId: IdSchema,
    agentRunId: IdSchema,
    purpose: Type.String({ maxLength: 64 }),
    promptIdVersion: Type.String({ maxLength: 128 }),
    status: NoteAiUsageStatusSchema,
    provider: Type.String({ maxLength: 64 }),
    model: Type.String({ maxLength: 128 }),
    documentVersion: VersionSchema,
    bodyHash: Type.String({ pattern: '^[0-9a-f]{64}$' }),
    sectionHashes: Type.Array(SectionHashSchema, { minItems: 1, maxItems: 64 }),
    sentBytes: Type.Integer({ minimum: 0 }),
    stale: Type.Boolean(),
    createdAt: InstantSchema,
  },
  { additionalProperties: false, $id: 'NoteAiUsage' },
);

export const NoteAiUsagePageSchema = pageSchema(NoteAiUsageSchema, { id: 'NoteAiUsagePage' });

export const NoteAiUsageListQuerySchema = Type.Object(
  {
    cursor: Type.Optional(CursorSchema),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
  },
  { additionalProperties: false, $id: 'NoteAiUsageListQuery' },
);

export type DocumentLinkTargetKindName = LinkTargetKind;
export type NoteSensitivityName = NoteSensitivity;
export type NoteSourceName = NoteSource;
export type DocumentLinkCreate = Static<typeof DocumentLinkCreateSchema>;
export type DocumentLinkDto = Static<typeof DocumentLinkSchema>;
export type ContextDocumentDto = Static<typeof ContextDocumentSchema>;
export type ContextDocumentCreate = Static<typeof ContextDocumentCreateSchema>;
export type ContextDocumentPatch = Static<typeof ContextDocumentPatchSchema>;
export interface ContextDocumentPage {
  readonly items: readonly ContextDocumentDto[];
  readonly nextCursor: string | null;
}
export type ContextDocumentListQuery = Static<typeof ContextDocumentListQuerySchema>;
export type ContextDocumentIdParams = Static<typeof ContextDocumentIdParamsSchema>;
export type DocumentLinkParams = Static<typeof DocumentLinkParamsSchema>;
export type NoteAiUsageDto = Static<typeof NoteAiUsageSchema>;
export interface NoteAiUsagePage {
  readonly items: readonly NoteAiUsageDto[];
  readonly nextCursor: string | null;
}
export type NoteAiUsageListQuery = Static<typeof NoteAiUsageListQuerySchema>;
