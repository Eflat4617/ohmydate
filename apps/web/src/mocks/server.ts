import { setupServer } from 'msw/node';
import { createHandlers } from './handlers';
import { createIntakeHandlers } from './intake-handlers';
import { createPlanningHandlers } from './planning-handlers';
import { createReplanHandlers } from './replan';
import { mockDb } from './db';

export const server = setupServer(
  ...createHandlers(mockDb),
  ...createIntakeHandlers(mockDb),
  ...createPlanningHandlers(mockDb),
  ...createReplanHandlers(mockDb),
);
