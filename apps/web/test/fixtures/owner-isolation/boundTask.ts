// Lint fixture (owner-lint.spec.ts): the mistakes owner-isolation/bound-task
// exists for, and the correct form. Linted as if it lived in src/.
import { runOwnerBound, type OwnerSteps } from '../../../src/session/ownerBound';

declare function save(): Promise<string>;
declare function show(text: string): void;
declare function nextTick(): Promise<void>;

async function announce(text: string): Promise<void> {
  await nextTick();
  show(text);
}

export async function wrong(): Promise<void> {
  // 1. an async function as the task (the compiler rejects it as well)
  // @ts-expect-error an owner-bound task must be a generator
  await runOwnerBound(async () => {
    show(await save());
  });
  // 2. acting on the outcome after the await
  show('saved');
}

export async function wrongHelper(): Promise<void> {
  await runOwnerBound(function* (owner) {
    const saved = yield* owner.wait(save());
    // 3. an async helper: what it does after its own await is not fenced
    yield* owner.wait(announce(saved));
  });
}

export function wrongChain(): Promise<void> {
  // 4. the same as 2, chained
  return runOwnerBound(function* (owner) {
    yield* owner.wait(save());
  }).then(() => show('saved'));
}

function* announceSteps(text: string): OwnerSteps<void> {
  yield nextTick();
  show(text);
}

export async function right(): Promise<boolean> {
  const outcome = await runOwnerBound(
    function* (owner) {
      try {
        const saved = yield* owner.wait(save());
        yield* announceSteps(saved);
      } catch (cause) {
        show(String(cause));
      }
    },
    { onSettled: () => show('done') },
  );
  return outcome.status === 'done';
}
