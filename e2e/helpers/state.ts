import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export interface E2EState {
  readonly webUrl: string;
  readonly apiUrl: string;
  readonly vikunjaUrl: string;
  readonly databaseSchema: string;
  readonly email: string;
  readonly password: string;
  readonly vikunjaToken: string;
  readonly vikunjaUserId: number;
  readonly inboxExternalId: string;
  readonly todayEmail: string;
  readonly todayPassword: string;
  readonly todayVikunjaToken: string;
  readonly todayVikunjaUserId: number;
  readonly todayInboxExternalId: string;
  readonly plansEmail: string;
  readonly plansPassword: string;
  readonly plansVikunjaToken: string;
  readonly plansVikunjaUserId: number;
  readonly plansInboxExternalId: string;
  readonly apiPid: number;
  readonly webPid: number;
  /**
   * Simulated-clock offset (ms) applied to the API process and to browser
   * contexts that opt in. 0 / absent unless E2E_FAKE_NOW was set.
   */
  readonly clockOffsetMs?: number;
}

export const STATE_PATH = fileURLToPath(
  new URL('../../test-results/e2e/run-state.json', import.meta.url),
);

let cached: E2EState | null = null;

export function readState(): E2EState {
  if (cached !== null) return cached;
  cached = JSON.parse(readFileSync(STATE_PATH, 'utf8')) as E2EState;
  return cached;
}
