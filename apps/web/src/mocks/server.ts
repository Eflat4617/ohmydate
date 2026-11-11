import { setupServer } from 'msw/node';
import { createHandlers } from './handlers';
import { createPlanningHandlers } from './planning-handlers';
import { mockDb } from './db';

export const server = setupServer(...createHandlers(mockDb), ...createPlanningHandlers(mockDb));
