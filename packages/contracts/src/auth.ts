import { Type, type Static } from '@sinclair/typebox';
import { IanaTimeZoneSchema, IdSchema, InstantSchema, VersionSchema } from './common.js';

export const LoginRequestSchema = Type.Object(
  {
    email: Type.String({ format: 'email', maxLength: 320 }),
    password: Type.String({ minLength: 1, maxLength: 1024 }),
  },
  { additionalProperties: false, $id: 'LoginRequest' },
);

export const LlmConsentSchema = Type.Object(
  {
    granted: Type.Boolean(),
    at: InstantSchema,
    provider: Type.String({ minLength: 1, maxLength: 64 }),
  },
  { additionalProperties: false, $id: 'LlmConsent' },
);

export const LlmBudgetSchema = Type.Object(
  {
    dailyUsd: Type.Number({ minimum: 0 }),
    monthlyUsd: Type.Number({ minimum: 0 }),
  },
  { additionalProperties: false, $id: 'LlmBudget' },
);

export const LlmSettingsSchema = Type.Object(
  {
    consent: Type.Optional(LlmConsentSchema),
    budget: Type.Optional(LlmBudgetSchema),
  },
  { additionalProperties: false, $id: 'LlmSettings' },
);

export const LlmConsentPatchSchema = Type.Object(
  { granted: Type.Boolean() },
  { additionalProperties: false, $id: 'LlmConsentPatch' },
);

export const LlmBudgetPatchSchema = Type.Object(
  {
    dailyUsd: Type.Optional(Type.Number({ minimum: 0 })),
    monthlyUsd: Type.Optional(Type.Number({ minimum: 0 })),
  },
  { additionalProperties: false, $id: 'LlmBudgetPatch' },
);

export const LlmSettingsPatchSchema = Type.Object(
  {
    consent: Type.Optional(LlmConsentPatchSchema),
    budget: Type.Optional(LlmBudgetPatchSchema),
  },
  { additionalProperties: false, $id: 'LlmSettingsPatch' },
);

export const UserSchema = Type.Object(
  {
    id: IdSchema,
    email: Type.String({ format: 'email', maxLength: 320 }),
    timeZone: IanaTimeZoneSchema,
    locale: Type.String({ minLength: 2, maxLength: 35 }),
    llm: Type.Optional(LlmSettingsSchema),
    /** Active product provider; the consent dialog is only needed for `deepseek`. */
    llmProvider: Type.Optional(Type.Union([Type.Literal('fake'), Type.Literal('deepseek')])),
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
    llm: Type.Optional(LlmSettingsPatchSchema),
  },
  { additionalProperties: false, $id: 'UserSettingsPatch' },
);

export type LlmConsent = Static<typeof LlmConsentSchema>;
export type LlmBudget = Static<typeof LlmBudgetSchema>;
export type LlmSettings = Static<typeof LlmSettingsSchema>;
export type LlmSettingsPatch = Static<typeof LlmSettingsPatchSchema>;
export type LoginRequest = Static<typeof LoginRequestSchema>;
export type User = Static<typeof UserSchema>;
export type UserSettingsPatch = Static<typeof UserSettingsPatchSchema>;
