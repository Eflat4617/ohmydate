import { readFileSync } from 'node:fs';
import { expect, type APIRequestContext, type APIResponse, type Page } from '@playwright/test';
import { readState, type E2EState } from './state';
import {
  externalIdOf,
  fetchVikunjaProject,
  fetchVikunjaTask,
  type PlannerTask,
} from './vikunja';
import type { TargetName } from '../targets/target';

/**
 * The driver: everything a spec does that is not the page itself (blueprint
 * 15 §7.3 item 12). Two implementations, one per target (targets/target.ts):
 *
 * |                     | `ts` (default)                          | `core`                                   |
 * |---------------------|-----------------------------------------|------------------------------------------|
 * | getting in          | the login form                          | the boot hand-off (`/__boot?token=…`)    |
 * | an API request      | the page's session + `X-CSRF-Token`     | `Authorization: Bearer <launch token>`   |
 * | before each test    | reset the login rate limit              | nothing                                  |
 * | the record behind it| Vikunja, read directly                  | the core, read with the launch token     |
 * | the signed-out page | the login form                          | "open it from the app"                   |
 *
 * A spec asks the driver; it never asks which target it is on, except
 * through `serves()` for an area the core has not ported yet.
 */

/**
 * Parts of the product a step may need. The `ts` target serves all of them.
 * The `core` target serves what has been ported (blueprint 15 §10): a task
 * that ports an area adds it to `CORE_SERVES` when its spec passes there.
 */
export type Area =
  | 'tasks'
  | 'availability'
  | 'commitments'
  | 'planning'
  | 'today'
  | 'focus'
  | 'notifications'
  | 'replan'
  | 'insights'
  | 'ai'
  | 'google';

/** What the Rust core serves today: owner, projects and tasks (RC-00, RC-10A). */
const CORE_SERVES: ReadonlySet<Area> = new Set<Area>(['tasks']);

export interface Credentials {
  readonly email: string;
  readonly password: string;
}

export interface RequestOptions {
  readonly method?: string;
  readonly body?: unknown;
  readonly headers?: Record<string, string>;
}

/** A to-do as the system of record behind the planner API holds it. */
export interface StoredTask {
  readonly title: string;
  readonly done: boolean;
  readonly inInbox: boolean;
}

/** A folder (a project) as the system of record holds it. */
export interface StoredFolder {
  readonly title: string;
  readonly archived: boolean;
}

/**
 * What is behind the planner API: where a write has to arrive to be real.
 * `ts`: Vikunja. `core`: the core's own store, read back with the launch
 * token — not through the session of the page under test.
 */
export interface SystemOfRecord {
  task(page: Page, task: PlannerTask): Promise<StoredTask>;
  /** A folder by its (unique) title, archived ones included; `undefined` when none has it. */
  folder(page: Page, title: string): Promise<StoredFolder | undefined>;
}

export interface Driver {
  readonly target: TargetName;
  /** Whether this target serves an area yet (always, on `ts`). */
  serves(area: Area): boolean;
  /** Opens the app as a signed-in owner. On return the app's first screen is loading. */
  signIn(page: Page, account: Credentials): Promise<void>;
  /**
   * Signs in with the keyboard alone, from a page nobody is signed in to.
   * `ts`: Tab and Enter through the login form. `core`: there is no form to
   * walk — the hand-off is the whole sign-in.
   */
  signInByKeyboard(page: Page, account: Credentials): Promise<void>;
  /** Opens what a visitor who is not signed in sees, and waits for its heading. */
  openSignedOutPage(page: Page): Promise<void>;
  /** One planner API request (`path` without `/api/v1`), with this target's own credentials. */
  request(page: Page, path: string, options?: RequestOptions): Promise<APIResponse>;
  /** Runs before every test. */
  beforeEachTest(request: APIRequestContext): Promise<void>;
  /**
   * Whether the API's project list still shows `folderId` as a folder in use.
   * `ts` leaves an archived project out of the list altogether; the core
   * keeps it, marked `archived` (blueprint 15 §2.2, `updateProject`).
   */
  listsAsLive(projects: readonly { readonly id: string; readonly archived: boolean }[], folderId: string): boolean;
  readonly record: SystemOfRecord;
}

async function poll<T>(read: () => Promise<T>, accept: (value: T) => boolean, message: string): Promise<T> {
  let last: T | undefined;
  await expect
    .poll(
      async () => {
        last = await read();
        return accept(last);
      },
      { message },
    )
    .toBe(true);
  return last as T;
}

/** Waits until the record holds the to-do the way `expected` says (each given field). */
export async function expectStoredTask(
  page: Page,
  task: PlannerTask,
  expected: Partial<StoredTask>,
): Promise<StoredTask> {
  const wanted = Object.entries(expected) as [keyof StoredTask, StoredTask[keyof StoredTask]][];
  return poll(
    () => driver.record.task(page, task),
    (stored) => wanted.every(([key, value]) => stored[key] === value),
    `the record of task ${task.id} should become ${JSON.stringify(expected)}`,
  );
}

// ── ts: the stack as deployed ───────────────────────────────────────────────

async function csrfToken(page: Page): Promise<string> {
  const cookies = await page.context().cookies();
  const cookie = cookies.find((candidate) => candidate.name === 'csrf');
  if (cookie === undefined) throw new Error('csrf cookie is missing');
  return cookie.value;
}

function tsDriver(state: E2EState): Driver {
  return {
    target: 'ts',
    serves: () => true,

    async signIn(page, account) {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        await page.goto(`${state.webUrl}/login`);
        await page.getByLabel('이메일').fill(account.email);
        await page.getByLabel('비밀번호').fill(account.password);
        const responsePromise = page.waitForResponse(
          (response) =>
            response.request().method() === 'POST' &&
            new URL(response.url()).pathname.endsWith('/auth/login'),
        );
        await page.getByRole('button', { name: '로그인' }).click();
        const response = await responsePromise;
        if (response.status() === 429) {
          // The dev API allows five logins per minute per IP+email and exposes a
          // fixed 60s window. Earlier E2E-1 scenarios use the whole budget, so wait
          // for the window to roll over instead of failing the later suites.
          await page.waitForTimeout(61_000);
          continue;
        }
        return;
      }
      throw new Error('login was rate limited for three consecutive windows');
    },

    async signInByKeyboard(page, account) {
      await page.goto(`${state.webUrl}/login`);
      await page.keyboard.press('Tab');
      await expect(page.getByLabel('이메일')).toBeFocused();
      await page.keyboard.type(account.email);

      await page.keyboard.press('Tab');
      await expect(page.getByLabel('비밀번호')).toBeFocused();
      await page.keyboard.type(account.password);

      await page.keyboard.press('Enter');
    },

    async openSignedOutPage(page) {
      await page.goto(`${state.webUrl}/login`);
      await expect(page.getByRole('heading', { name: 'OhMyDate에 로그인' })).toBeVisible();
    },

    async request(page, path, options = {}) {
      const method = options.method ?? 'GET';
      const headers: Record<string, string> = { accept: 'application/json', ...options.headers };
      if (method !== 'GET') {
        headers['X-CSRF-Token'] = await csrfToken(page);
        if (options.body !== undefined) headers['content-type'] = 'application/json';
      }
      return page.request.fetch(`${state.apiUrl}/api/v1${path}`, {
        method,
        headers,
        ...(options.body === undefined ? {} : { data: options.body }),
      });
    },

    /**
     * FU-79: every Playwright test starts with a clean login rate-limit window.
     *
     * The login limiter is a process-wide fixed window keyed by `${ip}:${email}`.
     * Earlier tests in the same E2E run share the API process and often the same
     * fixture owner, so E2E-5 could inherit a nearly exhausted window and fail on
     * a 429 after its own back-off. The reset route exists only when the API is
     * started with the fake-only `E2E_RESET_LOGIN_RATE_LIMIT=1` knob (global-setup
     * does that); production refuses the knob, and the limiter's production
     * behaviour is untouched.
     */
    async beforeEachTest(request) {
      const response = await request.post(`${state.apiUrl}/api/v1/__e2e__/reset-login-rate-limit`);
      if (response.status() !== 204) {
        throw new Error(
          `E2E login-rate-limit reset -> ${response.status()}; is E2E_RESET_LOGIN_RATE_LIMIT=1 set?`,
        );
      }
    },

    listsAsLive: (projects, folderId) => projects.some((project) => project.id === folderId),

    record: {
      async task(_page, task) {
        const remote = await fetchVikunjaTask(state, externalIdOf(task));
        return {
          title: remote.title,
          done: remote.done === true,
          inInbox: String(remote.project_id) === state.inboxExternalId,
        };
      },
      async folder(_page, title) {
        const remote = await fetchVikunjaProject(state, title);
        return remote === undefined ? undefined : { title: remote.title, archived: remote.is_archived === true };
      },
    },
  };
}

// ── core: the Rust core, alone ──────────────────────────────────────────────

/**
 * The launch token of the core under test, from its ready file (0600). It is
 * a secret: it goes into a request header or the hand-off address and nowhere
 * else — never into a message, a title, a log line or the state file.
 */
function launchToken(state: E2EState): string {
  if (state.core === undefined) throw new Error('this run has no core (E2E_TARGET=core sets one up)');
  const ready = JSON.parse(readFileSync(state.core.readyFile, 'utf8')) as { token?: unknown };
  if (typeof ready.token !== 'string' || ready.token.length === 0) throw new Error('the core’s ready file has no token');
  return ready.token;
}

/** An address of the web that only this driver answers: it sends the page on to `/__boot`. */
const HAND_OFF_PATH = '/__e2e-hand-off';

function coreDriver(state: E2EState): Driver {
  /**
   * A read straight from the core with the launch token and nothing else: no
   * cookie jar, no page session. (Node's `fetch`, as the Vikunja reads are.)
   */
  async function read<T>(path: string): Promise<T> {
    let response: Response;
    try {
      response = await fetch(`${state.apiUrl}/api/v1${path}`, {
        headers: { accept: 'application/json', authorization: `Bearer ${launchToken(state)}` },
      });
    } catch {
      throw new Error(`core GET ${path} could not be sent`);
    }
    const text = await response.text();
    expect(response.ok, `core GET ${path} -> ${response.status}: ${text}`).toBeTruthy();
    return JSON.parse(text) as T;
  }

  /**
   * What the desktop shell does (15 §1.3): the page asks the core for
   * `/__boot?token=…`, and the core answers with the launch cookie and a
   * redirect to `/`.
   *
   * The page is not sent there by name. It is sent to an address without the
   * token, which this driver answers with a one-line document that sends the
   * page on to the real one — so the browser makes the real request and keeps
   * the real cookie, while the step Playwright records, its report and any
   * message it prints name an address that holds no secret. (A document and
   * not a redirect: WebKit does not let a test answer with one.)
   */
  async function bootHandOff(page: Page): Promise<void> {
    const origin = new URL(state.webUrl).origin;
    const pattern = `${state.webUrl}${HAND_OFF_PATH}`;
    await page.route(pattern, (route) =>
      route.fulfill({
        status: 200,
        contentType: 'text/html; charset=utf-8',
        headers: { 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' },
        body: `<!doctype html><meta http-equiv="refresh" content="0;url=/__boot?token=${encodeURIComponent(launchToken(state))}"><title>OhMyDate</title>`,
      }),
    );
    try {
      await page.goto(pattern);
      // On to /__boot (the cookie), then `/` (303), then wherever the app opens.
      await page.waitForURL((url) => url.origin === origin && !url.pathname.startsWith('/__'));
    } catch {
      // Whatever went wrong, Playwright's own words may quote where the page was sent on to.
      throw new Error('the boot hand-off to the core failed');
    } finally {
      await page.unroute(pattern);
    }
    const landed = new URL(page.url());
    expect(landed.search, 'the hand-off leaves no query behind').toBe('');
  }

  return {
    target: 'core',
    serves: (area) => CORE_SERVES.has(area),

    signIn: (page) => bootHandOff(page),
    signInByKeyboard: (page) => bootHandOff(page),

    async openSignedOutPage(page) {
      // No hand-off: the page has no launch cookie, as when the address is opened by hand.
      await page.goto(`${state.webUrl}/`);
      await expect(page.getByRole('heading', { name: '앱에서 다시 열어 주세요' })).toBeVisible();
    },

    async request(page, path, options = {}) {
      const method = options.method ?? 'GET';
      const headers: Record<string, string> = {
        accept: 'application/json',
        ...options.headers,
        authorization: `Bearer ${launchToken(state)}`,
      };
      if (method !== 'GET' && options.body !== undefined) headers['content-type'] = 'application/json';
      try {
        return await page.request.fetch(`${state.apiUrl}/api/v1${path}`, {
          method,
          headers,
          ...(options.body === undefined ? {} : { data: options.body }),
        });
      } catch {
        // Playwright's message for a request that could not be sent lists its headers.
        throw new Error(`core ${method} ${path} could not be sent`);
      }
    },

    // One owner, no login, nothing to rate-limit.
    beforeEachTest: () => Promise.resolve(),

    listsAsLive: (projects, folderId) => projects.some((project) => project.id === folderId && !project.archived),

    record: {
      async task(_page, task) {
        const [stored, projects] = await Promise.all([
          read<{ title: string; status: string; projectId: string }>(`/tasks/${task.id}`),
          read<{ items: { id: string; kind: string }[] }>('/projects?limit=100'),
        ]);
        const inbox = projects.items.find((project) => project.kind === 'inbox');
        return { title: stored.title, done: stored.status === 'done', inInbox: inbox !== undefined && stored.projectId === inbox.id };
      },
      async folder(_page, title) {
        // The core's list keeps an archived project, marked (15 §2.2).
        const projects = await read<{ items: { title: string; kind: string; archived: boolean }[] }>('/projects?limit=100');
        const found = projects.items.find((project) => project.kind !== 'inbox' && project.title === title);
        return found === undefined ? undefined : { title: found.title, archived: found.archived };
      },
    },
  };
}

let cached: Driver | null = null;

/** The driver of this run's target. */
export function getDriver(): Driver {
  if (cached === null) {
    const state = readState();
    cached = state.target === 'core' ? coreDriver(state) : tsDriver(state);
  }
  return cached;
}

/** The driver of this run's target, resolved on first use (so importing this file reads nothing). */
export const driver: Driver = {
  get target() {
    return getDriver().target;
  },
  serves: (area) => getDriver().serves(area),
  signIn: (page, account) => getDriver().signIn(page, account),
  signInByKeyboard: (page, account) => getDriver().signInByKeyboard(page, account),
  openSignedOutPage: (page) => getDriver().openSignedOutPage(page),
  request: (page, path, options) => getDriver().request(page, path, options),
  beforeEachTest: (request) => getDriver().beforeEachTest(request),
  listsAsLive: (projects, folderId) => getDriver().listsAsLive(projects, folderId),
  record: {
    task: (page, task) => getDriver().record.task(page, task),
    folder: (page, title) => getDriver().record.folder(page, title),
  },
};
