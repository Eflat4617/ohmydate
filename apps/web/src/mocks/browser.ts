import { setupWorker } from 'msw/browser';
import { createHandlers } from './handlers';
import { createPlanningHandlers } from './planning-handlers';
import { mockDb } from './db';

export const worker = setupWorker(...createHandlers(mockDb), ...createPlanningHandlers(mockDb));
