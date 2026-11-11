import { setupServer } from 'msw/node';
import { createHandlers } from './handlers';
import { createIntakeHandlers } from './intake-handlers';
import { mockDb } from './db';

export const server = setupServer(...createHandlers(mockDb), ...createIntakeHandlers(mockDb));
