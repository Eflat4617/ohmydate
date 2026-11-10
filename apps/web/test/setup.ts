import { afterAll, afterEach, beforeAll } from 'vitest';
import { resetMockDb } from '../src/mocks/db';
import { server } from '../src/mocks/server';

beforeAll(() => {
  server.listen({ onUnhandledFrame: 'error' });
});

afterEach(() => {
  server.resetHandlers();
  resetMockDb();
});

afterAll(() => {
  server.close();
});
