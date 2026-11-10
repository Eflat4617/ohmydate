import type { Insertable } from 'kysely';
import {
  databaseTables,
  jsonb,
  type AssertTableColumns,
  type ExpectTrue,
  type OutboxEventTable,
  type UserTable,
} from '../../src/db/types.js';

/**
 * Typecheck-only fixtures (not picked up by vitest: the filename is not
 * *.test.ts). `tsc` runs them via services/api/tsconfig.json, so a regression
 * in the Database types or the schema assertions breaks `pnpm run typecheck`.
 */

const baseOutbox = {
  id: '0193a8f2-6c1e-7b41-9a2e-1f1d6a0b3c55',
  owner_id: '0193a8f2-6c1e-7b41-9a2e-1f1d6a0b3c56',
  topic: 'task.created',
} as const;

export const validOutboxInsert: Insertable<OutboxEventTable> = {
  ...baseOutbox,
  payload: jsonb({ taskId: '0193a8f2-6c1e-7b41-9a2e-1f1d6a0b3c55' }),
};

// @ts-expect-error outbox_event.payload is NOT NULL without a default and must be supplied
export const missingPayload: Insertable<OutboxEventTable> = { ...baseOutbox };

// @ts-expect-error raw objects are not JsonbParam; use jsonb(value)
export const rawObjectPayload: Insertable<OutboxEventTable> = { ...baseOutbox, payload: { a: 1 } };

// @ts-expect-error raw arrays are not JsonbParam; use jsonb(value)
export const rawArrayPayload: Insertable<OutboxEventTable> = { ...baseOutbox, payload: ['a', 'b'] };

// @ts-expect-error raw strings are not JsonbParam; use jsonb(value)
export const rawStringPayload: Insertable<OutboxEventTable> = { ...baseOutbox, payload: 'hello' };

// @ts-expect-error raw numbers are not JsonbParam; use jsonb(value)
export const rawNumberPayload: Insertable<OutboxEventTable> = { ...baseOutbox, payload: 123 };

// @ts-expect-error raw booleans are not JsonbParam; use jsonb(value)
export const rawBooleanPayload: Insertable<OutboxEventTable> = { ...baseOutbox, payload: true };

// @ts-expect-error SQL NULL is not a JSONB value for a NOT NULL column
export const nullPayload: Insertable<OutboxEventTable> = { ...baseOutbox, payload: null };

export type UserTableMatchesSchema = ExpectTrue<
  AssertTableColumns<UserTable, typeof databaseTables.user>
>;

type WrongUserTable = Omit<UserTable, 'id'> & { id: number };

// @ts-expect-error a deliberately wrong interface column type must fail the schema assertion
export type WrongUserTableIsRejected = ExpectTrue<AssertTableColumns<WrongUserTable, typeof databaseTables.user>>;
