import { setupServer } from 'msw/node';
import { createHandlers } from './handlers';
import { mockDb } from './db';

export const server = setupServer(...createHandlers(mockDb));
