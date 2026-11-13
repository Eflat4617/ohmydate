import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SEED_TASK_TITLE } from '../src/mocks/db';
import { createOwnerSwitchStage, type OwnerSwitchStage, until } from './support/ownerSwitch';
import { OWNER_SWITCH_CASES, OWNER_SWITCH_SHARDS, buttonByText, inboxReady } from './support/ownerSwitchCases';

/**
 * FU-77 — the owner-isolation regression sweep (ADR-023 guardrail).
 *
 * One scenario for every screen that writes asynchronously: owner A starts
 * the action, its response is held, another user signs in, the response is
 * released. Whatever the screen, nothing of A's action may then reach B: no
 * key in B's storage namespace, no toast, no navigation, no announcement or
 * dialog, no cache entry, no mutating request with B's credentials. Each case
 * also runs without the switch, to show the action is not a no-op.
 *
 * The cases live in test/support/ownerSwitchCases.ts and run from the
 * owner-switch-sweep.shard-N.spec.ts files, in parallel with each other and —
 * see the package's test script — after the rest of the suite, so that the
 * sweep's CPU load cannot slow the timing-sensitive tests next to it. A new screen that
 * talks to the API must add a case there (or an exemption with a reason
 * here): the manifest test below fails until it does.
 */

// Stage-based tests mount real screens; shared test machines can be slow.
vi.setConfig({ testTimeout: 60_000 });

const CASES = OWNER_SWITCH_CASES;

// ── Manifest: no screen is left out ─────────────────────────────────────────

/**
 * Files that talk to the API or persist on the device but need no case of
 * their own, each with the reason. Everything else that does must be listed
 * in a case's `covers`.
 */
const EXEMPT: Record<string, string> = {
  'src/components/notes/EvidenceList.vue': 'Reads only, through ownerFenced lookups; writes nothing.',
  'src/components/notes/NoteAiUsage.vue': 'Reads only, through ownerFenced lookups; writes nothing.',
  'src/components/ReplanBanner.vue': 'Reads only (owner-keyed query); writes nothing.',
  'src/composables/relatedNotes.ts': 'Reads only, through ownerFenced lookups; writes nothing.',
  'src/composables/usePlannerRange.ts':
    'Reads only (CAL-01 month page and Today agenda), through owner-keyed ownerFenced lookups; writes nothing.',
  'src/composables/useLatestReplanPlan.ts': 'Reads only (owner-keyed query); writes nothing.',
  'src/composables/useGoogleCalendar.ts':
    'Reads only (CAL-04 Google connection and all-day events), through owner-keyed ownerFenced lookups; writes nothing.',
  'src/layout/useTodaySnapshot.ts': 'Reads only (owner-keyed query); writes nothing.',
  'src/layout/shellNav.ts':
    'HOLO-01 sidebar fold: one synchronous ownerSlot write at the click, under the binding captured there; no request, nothing awaited. holo-shell.spec.ts covers the owner scoping.',
  'src/theme/theme.ts':
    'HOLO-01 theme choice: one synchronous ownerSlot write at the click, under the binding captured there; no request, nothing awaited. holo-theme.spec.ts covers the owner scoping.',
  'src/views/ProjectDetailView.vue': 'Reads only; its task edits are TaskList / useTaskActions (inbox cases).',
  'src/views/ProjectListView.vue': 'Reads only; writes nothing.',
  'src/session/owner.ts': 'The device-level active-owner pointer; changed only by the owner change itself.',
  'src/session/quarantine.ts': 'Durable focus quarantine, written under the journal lock; m4-owner-bound.spec.ts and owner-guardrail.spec.ts.',
  'src/session/journal.ts': 'The focus journal; exercised through focusQueue (focus cases) and owner-guardrail.spec.ts.',
};

const SOURCES = import.meta.glob<string>('../src/**/*.{ts,vue}', { query: '?raw', import: 'default', eager: true });

/** Talks to the API, or declares something it persists on the device. */
const NEEDS_A_CASE = /\b[pP]lannerClient\b|\b(ownerSlot|deviceSlot|openDeviceDatabase)\(/;
const NOT_APP_CODE = /^src\/(api|mocks)\/|^src\/session\/ownerStorage\.ts$/;

describe('sweep manifest', () => {
  it('every case runs: one shard spec file per shard, no more and no fewer, and the test script runs them (negative)', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const script = (JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8')) as { scripts: { test: string } }).scripts.test;
    expect(script).toContain('vitest run test/owner-switch-sweep.shard-');
    const shardFiles = readdirSync(here).filter((name) => /^owner-switch-sweep\.shard-\d+\.spec\.ts$/.test(name));
    expect(shardFiles.sort()).toEqual(
      Array.from({ length: OWNER_SWITCH_SHARDS }, (_, index) => `owner-switch-sweep.shard-${index}.spec.ts`),
    );
    expect(new Set(CASES.map((testCase) => testCase.name)).size).toBe(CASES.length);
  });

  const files = Object.entries(SOURCES)
    .map(([path, source]) => ({ path: path.replace(/^\.\.\//, ''), source }))
    .filter((file) => !NOT_APP_CODE.test(file.path));
  const covered = new Set([
    ...CASES.flatMap((testCase) => testCase.covers),
    // The undo-delete describe block below.
    'src/components/TaskList.vue',
  ]);

  it('every source file that talks to the API or persists on the device has a case or an exemption with a reason', () => {
    const needing = files.filter((file) => NEEDS_A_CASE.test(file.source)).map((file) => file.path);
    expect(needing.length).toBeGreaterThan(20);
    expect(needing.filter((path) => !covered.has(path) && EXEMPT[path] === undefined)).toEqual([]);
  });

  it('names only files that exist, and exempts nothing a case already covers (negative)', () => {
    const known = new Set(files.map((file) => file.path));
    expect([...covered, ...Object.keys(EXEMPT)].filter((path) => !known.has(path))).toEqual([]);
    expect(Object.keys(EXEMPT).filter((path) => covered.has(path))).toEqual([]);
    // An exemption for a file that no longer needs one is stale.
    const needing = new Set(files.filter((file) => NEEDS_A_CASE.test(file.source)).map((file) => file.path));
    expect(Object.keys(EXEMPT).filter((path) => !needing.has(path))).toEqual([]);
    expect(Object.values(EXEMPT).every((reason) => reason.length > 20)).toBe(true);
  });
});

describe('inbox: delete with undo — the timer belongs to whoever clicked', () => {
  let stage: OwnerSwitchStage | null = null;

  afterEach(async () => {
    vi.useRealTimers();
    await stage?.dispose();
    stage = null;
  });

  async function clickDelete(): Promise<OwnerSwitchStage> {
    const created = await createOwnerSwitchStage();
    const wrapper = await created.mountView('/inbox');
    await inboxReady(wrapper);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    await buttonByText(wrapper, `${SEED_TASK_TITLE} 삭제`).trigger('click');
    return created;
  }

  it('control: the delete is sent when the undo window closes', async () => {
    stage = await clickDelete();
    await vi.advanceTimersByTimeAsync(6_100);
    await until(() => expect(stage?.requests.some((request) => request.method === 'DELETE')).toBe(true));
  });

  it('switch: another user signed in during the undo window — nothing is sent, shown or cached', async () => {
    stage = await clickDelete();
    await stage.switchOwner();
    await vi.advanceTimersByTimeAsync(6_100);
    await stage.settle();
    expect(stage.requests.filter((request) => request.method === 'DELETE')).toEqual([]);
    stage.expectNoLeak();
  });
});
