import { Type, type TSchema } from '@sinclair/typebox';

export const UUID_V7_PATTERN =
  '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$';

export const IfMatchPattern = '^W/"[1-9][0-9]*"$';

export const IdSchema = Type.String({ format: 'uuid', pattern: UUID_V7_PATTERN });

export const InstantSchema = Type.String({ format: 'date-time' });

export const VersionSchema = Type.Integer({ minimum: 1 });

export const IfMatchHeaderSchema = Type.String({ pattern: IfMatchPattern });

export const IdempotencyKeyHeaderSchema = Type.String({ format: 'uuid' });

export const CursorSchema = Type.String({ minLength: 1 });

export interface PageSchemaOptions {
  readonly id: string;
}

export function pageSchema<T extends TSchema>(item: T, options: PageSchemaOptions): TSchema {
  return Type.Object(
    {
      items: Type.Array(item),
      nextCursor: Type.Union([CursorSchema, Type.Null()]),
    },
    { additionalProperties: false, $id: options.id },
  );
}
