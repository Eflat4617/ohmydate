import { setupServer } from 'msw/node';
import { createHandlers } from './handlers';
import { createCommitmentParseHandlers } from './commitment-parse';
import { createIntakeHandlers } from './intake-handlers';
import { createNotesHandlers } from './notes';
import { createPlanningHandlers } from './planning-handlers';
import { createReplanHandlers } from './replan';
import { mockDb } from './db';

export const server = setupServer(
  ...createHandlers(mockDb),
  ...createIntakeHandlers(mockDb),
  // CAL-02: before the planning handlers so /commitments:parse never reaches /commitments.
  ...createCommitmentParseHandlers(mockDb),
  ...createPlanningHandlers(mockDb),
  ...createReplanHandlers(mockDb),
  ...createNotesHandlers(mockDb),
);
