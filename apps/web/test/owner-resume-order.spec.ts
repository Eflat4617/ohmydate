import { nextTick } from 'vue';
import { newActionId, plannerClient } from '../src/api';
import WizardNotesPanel from '../src/components/notes/WizardNotesPanel.vue';
import { NOTE_MEETING_ID } from '../src/mocks/notes-seed';
import { runOwnerBound, type OwnerSteps } from '../src/session/ownerBound';
import { adoptActiveOwner, currentOwnerId } from '../src/session/ownerEpoch';
import { buttonInElement, dialogByTitle } from './m6-03-notes-utils';
import { useTestClock } from './m6-layout-utils';
import { setLayoutClock } from '../src/layout/clock';
import { OWNER_B, createOwnerSwitchStage, type OwnerSwitchStage, until } from './support/ownerSwitch';

/**
 * FU-77R-1 H1 — a check made when the awaited promise RESOLVES is not a check
 * made when the continuation RESUMES. These are the reviewer's reproductions:
 * the owner changes in the microtask gap after the answer was accepted, and
 * during a helper's own await.
 */
// Stage-based tests mount real screens; shared test machines can be slow.
vi.setConfig({ testTimeout: 60_000 });

const OWNER_A = '01900000-0000-7000-8000-0000000000a0';

function gate<T = void>() {
  let release: (value: T) => void = () => {};
  const promise = new Promise<T>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

async function flush(): Promise<void> {
  for (let round = 0; round < 5; round += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('H1 — the primitive: the owner changes between resolution and resumption', () => {
  beforeEach(() => {
    adoptActiveOwner(OWNER_A, 'bootstrap');
  });

  it('resolve the awaited work, then switch in the next microtask: the write after the wait must not run for B', async () => {
    const held = gate<string>();
    const writes: string[] = [];
    const running = runOwnerBound(function* (owner) {
      const value = yield* owner.wait(held.promise);
      writes.push(`${value} written while ${String(currentOwnerId())} is signed in`);
    });
    held.release('A-private');
    queueMicrotask(() => adoptActiveOwner(OWNER_B, 'storage'));
    expect(await running).toEqual({ status: 'stale' });
    expect(writes).toEqual([]);
  });

  it('the same gap at every later wait, and between the last line and the handlers', async () => {
    for (const gapAt of [0, 1, 2]) {
      adoptActiveOwner(OWNER_A, 'storage');
      const gates = [gate<string>(), gate<string>(), gate<string>()];
      const writes: string[] = [];
      const settled = vi.fn();
      const running = runOwnerBound(
        function* (owner) {
          for (const [index, held] of gates.entries()) {
            const value = yield* owner.wait(held.promise);
            writes.push(`${index}:${value}:${String(currentOwnerId())}`);
          }
        },
        { onSettled: settled },
      );
      for (const [index, held] of gates.entries()) {
        held.release('A');
        if (index === gapAt) queueMicrotask(() => adoptActiveOwner(OWNER_B, 'storage'));
        await flush();
      }
      expect(await running).toEqual({ status: 'stale' });
      // Everything written was written while A was signed in; nothing after the switch.
      expect(writes).toEqual(Array.from({ length: gapAt }, (_, index) => `${index}:A:${OWNER_A}`));
      expect(settled).not.toHaveBeenCalled();
    }
  });

  it('control: without a switch the same task writes for its own owner', async () => {
    const held = gate<string>();
    const writes: string[] = [];
    const running = runOwnerBound(function* (owner) {
      writes.push(`${yield* owner.wait(held.promise)} for ${String(currentOwnerId())}`);
    });
    held.release('A-private');
    expect(await running).toEqual({ status: 'done', value: undefined });
    expect(writes).toEqual([`A-private for ${OWNER_A}`]);
  });

  it('the owner changes during a helper’s own wait: the helper’s write after it must not run', async () => {
    const tick = gate();
    const announced: string[] = [];
    function* announce(message: string): OwnerSteps<void> {
      yield tick.promise;
      announced.push(message);
    }
    const running = runOwnerBound(function* () {
      yield* announce('Linked A-private-title');
    });
    adoptActiveOwner(OWNER_B, 'storage');
    expect(await running).toEqual({ status: 'stale' });
    tick.release();
    await flush();
    expect(announced).toEqual([]);
  });

  it('…and in the microtask gap after the helper’s wait settled', async () => {
    const tick = gate();
    const announced: string[] = [];
    function* announce(message: string): OwnerSteps<void> {
      yield tick.promise;
      announced.push(message);
    }
    const running = runOwnerBound(function* () {
      yield* announce('Linked A-private-title');
    });
    tick.release();
    queueMicrotask(() => adoptActiveOwner(OWNER_B, 'storage'));
    expect(await running).toEqual({ status: 'stale' });
    await flush();
    expect(announced).toEqual([]);
  });
});

describe('H1 — the screens the reviewer reproduced it on', () => {
  let stage: OwnerSwitchStage | null = null;

  afterEach(async () => {
    await stage?.dispose();
    stage = null;
    setLayoutClock(null);
  });

  it('AvailabilityView: the PUT answer is accepted, then the owner changes before save() resumes — nothing cached or announced for B', async () => {
    stage = await createOwnerSwitchStage();
    const wrapper = await stage.mountView('/settings/availability');
    await until(() => expect(wrapper.find('form.settings-form').exists()).toBe(true));
    const armed = stage.switchAtBoundEvent('settled', 0);
    await wrapper.get('form.settings-form').trigger('submit');
    await until(() => expect(armed.fired).toBe(true));
    await stage.settle();
    stage.expectNoLeak();
  });

  it('WizardNotesPanel: the owner changes while announce() waits for nextTick — nothing is announced for B', async () => {
    useTestClock();
    stage = await createOwnerSwitchStage();
    const planning = await plannerClient.createIntakeSession({ title: '졸업 논문 실험 계획' }, newActionId('intake'));
    const wrapper = stage.mount(WizardNotesPanel, { props: { goalId: String(planning.goalId) } });
    await wrapper.get('[data-wizard-notes-add]').trigger('click');
    await until(() => expect(() => dialogByTitle('참고할 노트 고르기')).not.toThrow());
    const picker = dialogByTitle('참고할 노트 고르기');
    await until(() => expect(picker.querySelector(`[data-wizard-candidate="${NOTE_MEETING_ID}"]`)).not.toBeNull());
    await stage.settle();
    // Waits of link(): the POST, the cache publish, then announce()'s own nextTick.
    const armed = stage.switchAtBoundEvent('waiting', 2);
    buttonInElement(picker, '“발표 준비 회의” 이 계획에 연결').click();
    await until(() => expect(armed.fired).toBe(true));
    await nextTick();
    await stage.settle();
    expect(document.body.textContent).not.toContain('이 계획에 연결했어요');
    stage.expectNoLeak();
  });
});
