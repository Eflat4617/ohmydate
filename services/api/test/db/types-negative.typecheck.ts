import type { Insertable } from 'kysely';
import {
  databaseTables,
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

export const validOutboxInsert: Insertable<OutboxEventTable> = {
  id: '0193a8f2-6c1e-7b41-9a2e-1f1d6a0b3c55',
  owner_id: '0193a8f2-6c1e-7b41-9a2e-1f1d6a0b3c56',
  topic: 'task.created',
  payload: { taskId: '0193a8f2-6c1e-7b41-9a2e-1f1d6a0b3c55' },
};

// @ts-expect-error outbox_event.payload is NOT NULL without a default and must be supplied
export const missingPayload: Insertable<OutboxEventTable> = { id: '0193a8f2-6c1e-7b41-9a2e-1f1d6a0b3c55', owner_id: '0193a8f2-6c1e-7b41-9a2e-1f1d6a0b3c56', topic: 'task.created' };

export type UserTableMatchesSchema = ExpectTrue<
  AssertTableColumns<UserTable, typeof databaseTables.user>
>;

type WrongUserTable = Omit<UserTable, 'id'> & { id: number };

// @ts-expect-error a deliberately wrong interface column type must fail the schema assertion
export type WrongUserTableIsRejected = ExpectTrue<AssertTableColumns<WrongUserTable, typeof databaseTables.user>>;
