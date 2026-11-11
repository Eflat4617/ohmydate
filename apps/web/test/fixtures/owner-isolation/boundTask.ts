// Lint fixture (owner-guardrail.spec.ts): the three mistakes
// owner-isolation/bound-await exists for, and the correct form of each.
import { runOwnerBound, type OwnerScope } from '../../../src/session/ownerBound';

declare function save(): Promise<string>;
declare function show(text: string): void;

export async function wrong(): Promise<void> {
  await runOwnerBound(async (owner) => {
    try {
      // 1. a bare await: resumes even after the signed-in user changed
      const saved = await save();
      show(saved + String(owner.ownerId));
    } catch (cause) {
      // 2. a catch that would show a stale owner's aborted request as an error
      show(String(cause));
    } finally {
      // 3. a finally: runs for the stale owner too
      show('done');
    }
  });
}

export async function wrongHelper(owner: OwnerScope): Promise<void> {
  // The same rule inside a helper that takes the scope.
  show(await save());
  show(String(owner.ownerId));
}

export async function right(): Promise<void> {
  await runOwnerBound(
    async (owner) => {
      try {
        show(await owner.wait(save()));
      } catch (cause) {
        owner.rethrowIfStale(cause);
        show(String(cause));
      }
    },
    { onSettled: () => show('done') },
  );
}
