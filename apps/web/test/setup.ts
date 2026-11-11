import { afterAll, afterEach, beforeAll, beforeEach } from 'vitest';
import { resetMockDb } from '../src/mocks/db';
import { server } from '../src/mocks/server';
import { clearOwnerResetPending, injectOwnerReload } from '../src/session/ownerEpoch';

beforeAll(() => {
  server.listen({ onUnhandledFrame: 'error' });
});

beforeEach(() => {
  injectOwnerReload(() => {});
  clearOwnerResetPending();
});

afterEach(() => {
  server.resetHandlers();
  resetMockDb();
  injectOwnerReload(null);
  clearOwnerResetPending();
});

afterAll(() => {
  server.close();
});
