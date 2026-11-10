import { setupWorker } from 'msw/browser';
import { createHandlers } from './handlers';
import { mockDb } from './db';

export const worker = setupWorker(...createHandlers(mockDb));
