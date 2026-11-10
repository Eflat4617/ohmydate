import type {
  DecompositionStepDto,
  TaskTemplate,
  TemplateSource,
  TemplateStats,
} from '@ohmydate/contracts';
import type { Id, Instant } from '@ohmydate/domain';
import { sql, type Kysely, type Selectable } from 'kysely';
import type { Database, TaskTemplateTable } from '../db/types.js';
import type {
  TaskTemplateRepository,
  TemplatePage,
} from '../application/intake/ports.js';

type TemplateRow = Selectable<TaskTemplateTable>;

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

function toInstant(value: Date | string): Instant {
  return (value instanceof Date ? value.toISOString() : value) as Instant;
}

const STEP_KINDS: ReadonlySet<string> = new Set(['prep', 'work', 'review', 'buffer']);

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asString(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback;
}

function asNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/**
 * Contract/DB default alignment (M2-02R LOW): `task_template.steps` defaults to
 * `[]` and `stats` is open jsonb, while the DTO requires the closed step/stat
 * shapes. The mapper guarantees the DTO shape instead of casting blindly.
 */
function mapSteps(value: unknown): DecompositionStepDto[] {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => {
    const step = asRecord(entry);
    const estimate = asRecord(step['estimate']);
    const dependsOn = Array.isArray(step['dependsOn'])
      ? step['dependsOn'].filter((ref): ref is string => typeof ref === 'string')
      : [];
    return {
      key: asString(step['key'], 's1'),
      title: asString(step['title'], 'Untitled step'),
      deliverable: asString(step['deliverable'], ''),
      doneCriteria: asString(step['doneCriteria'], ''),
      kind: STEP_KINDS.has(asString(step['kind'], 'work'))
        ? (step['kind'] as DecompositionStepDto['kind'])
        : 'work',
      estimate: {
        p50Minutes: asNumber(estimate['p50Minutes'], 5),
        p90Minutes: asNumber(estimate['p90Minutes'], 5),
      },
      dependsOn,
      splittable: step['splittable'] === true,
    };
  });
}

function mapStats(value: unknown): TemplateStats {
  const stats = asRecord(value);
  return {
    ...(typeof stats['sampleCount'] === 'number'
      ? { sampleCount: stats['sampleCount'] }
      : {}),
    ...(typeof stats['meanRatio'] === 'number' ? { meanRatio: stats['meanRatio'] } : {}),
    ...(typeof stats['p90Ratio'] === 'number' ? { p90Ratio: stats['p90Ratio'] } : {}),
  };
}

function mapTemplate(row: TemplateRow): TaskTemplate {
  return {
    id: row.id as Id,
    ownerId: row.owner_id as Id,
    name: row.name,
    steps: mapSteps(row.steps),
    stats: mapStats(row.stats),
    source: row.source as TemplateSource,
    confidence: row.confidence,
    version: row.version,
    createdAt: toInstant(row.created_at),
    updatedAt: toInstant(row.updated_at),
    ...(row.deleted_at === null ? {} : { deletedAt: toInstant(row.deleted_at) }),
  };
}

function normalizeLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return DEFAULT_LIMIT;
  return Math.max(1, Math.min(MAX_LIMIT, Math.floor(limit)));
}

function decodeCursor(cursor: string | undefined): number {
  if (cursor === undefined) return 0;
  const parsed = Number.parseInt(Buffer.from(cursor, 'base64url').toString('utf8'), 10);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : 0;
}

function encodeCursor(offset: number): string {
  return Buffer.from(String(offset), 'utf8').toString('base64url');
}

export class PgTaskTemplateRepository implements TaskTemplateRepository {
  readonly #db: Kysely<Database>;

  constructor(db: Kysely<Database>) {
    this.#db = db;
  }

  async list(
    ownerId: Id,
    query: { readonly query?: string; readonly cursor?: string; readonly limit?: number },
  ): Promise<TemplatePage> {
    const limit = normalizeLimit(query.limit);
    const offset = decodeCursor(query.cursor);
    const search = query.query?.trim();

    let base = this.#db
      .selectFrom('task_template')
      .selectAll()
      .where('owner_id', '=', ownerId)
      .where('deleted_at', 'is', null);
    if (search !== undefined && search.length > 0) {
      base = base.where(sql<boolean>`name ILIKE ${`%${search}%`}`);
    }

    const rows = await base
      .orderBy('name', 'asc')
      .orderBy('id', 'asc')
      .offset(offset)
      .limit(limit + 1)
      .execute();

    const page = rows.slice(0, limit);
    return {
      items: page.map(mapTemplate),
      nextCursor: rows.length > limit ? encodeCursor(offset + limit) : null,
    };
  }

  async get(ownerId: Id, id: Id): Promise<TaskTemplate | null> {
    const row = await this.#db
      .selectFrom('task_template')
      .selectAll()
      .where('id', '=', id)
      .where('owner_id', '=', ownerId)
      .where('deleted_at', 'is', null)
      .executeTakeFirst();
    return row === undefined ? null : mapTemplate(row);
  }

  async incrementFalsePositive(ownerId: Id, templateId: Id): Promise<void> {
    await this.#db
      .updateTable('task_type_fingerprint')
      .set({
        false_positive_count: sql<number>`false_positive_count + 1`,
        updated_at: sql<Date>`now()`,
        version: sql<number>`version + 1`,
      })
      .where('owner_id', '=', ownerId)
      .where('template_id', '=', templateId)
      .execute();
  }
}
