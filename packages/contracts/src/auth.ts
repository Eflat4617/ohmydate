import { Type, type Static } from '@sinclair/typebox';
import { IanaTimeZoneSchema, IdSchema, InstantSchema, VersionSchema } from './common.js';

export const LoginRequestSchema = Type.Object(
  {
    email: Type.String({ format: 'email', maxLength: 320 }),
    password: Type.String({ minLength: 1, maxLength: 1024 }),
  },
  { additionalProperties: false, $id: 'LoginRequest' },
);

export const UserSchema = Type.Object(
  {
    id: IdSchema,
    email: Type.String({ format: 'email', maxLength: 320 }),
    timeZone: IanaTimeZoneSchema,
    locale: Type.String({ minLength: 2, maxLength: 35 }),
    version: VersionSchema,
    createdAt: InstantSchema,
    updatedAt: InstantSchema,
  },
  { additionalProperties: false, $id: 'User' },
);

export const UserSettingsPatchSchema = Type.Object(
  {
    timeZone: Type.Optional(IanaTimeZoneSchema),
    locale: Type.Optional(Type.String({ minLength: 2, maxLength: 35 })),
  },
  { additionalProperties: false, $id: 'UserSettingsPatch' },
);

export type LoginRequest = Static<typeof LoginRequestSchema>;
export type User = Static<typeof UserSchema>;
export type UserSettingsPatch = Static<typeof UserSettingsPatchSchema>;
