import { isIanaTimeZone } from '@ohmydate/domain';
import { Type, type TSchema } from '@sinclair/typebox';

export const UUID_V7_PATTERN =
  '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$';

export const IfMatchPattern = '^W/"[1-9][0-9]*"$';

export const IfMatchAvailabilityPattern = '^W/"availability:[1-9][0-9]*"$';

export const IdSchema = Type.String({ format: 'uuid', pattern: UUID_V7_PATTERN });

export const InstantSchema = Type.String({ format: 'date-time' });

export const VersionSchema = Type.Integer({ minimum: 1 });

export const IfMatchHeaderSchema = Type.String({ pattern: IfMatchPattern });

export const IfMatchAvailabilityHeaderSchema = Type.String({ pattern: IfMatchAvailabilityPattern });

export const IdempotencyKeyHeaderSchema = Type.String({ format: 'uuid' });

export const IfNoneMatchHeaderSchema = Type.String({ minLength: 1 });

export const IANA_TIME_ZONE_FORMAT = 'iana-time-zone';

export interface FormatRegistrar {
  addFormat(
    name: string,
    format: { readonly type: 'string'; readonly validate: (value: string) => boolean },
  ): unknown;
}

/**
 * Ajv does not know the custom IANA format by default. The API layer must call
 * this helper on its Ajv/Fastify instance before compiling contracts, so request
 * validation uses the same named-zone policy as the domain validator.
 */
export function registerIanaTimeZoneFormat(ajv: FormatRegistrar): void {
  ajv.addFormat(IANA_TIME_ZONE_FORMAT, {
    type: 'string',
    validate: (value) => isIanaTimeZone(value),
  });
}

export const IanaTimeZoneSchema = Type.String({ format: IANA_TIME_ZONE_FORMAT });

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
