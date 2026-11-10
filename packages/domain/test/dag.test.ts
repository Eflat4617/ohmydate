import {
  assertAcyclic,
  DependencyCycleError,
  type DependencyEdge,
  type Id,
} from '../src/index.js';

const a = '0193a8f2-6c1e-7b41-9a2e-1f1d6a0b0001' as Id;
const b = '0193a8f2-6c1e-7b41-9a2e-1f1d6a0b0002' as Id;
const c = '0193a8f2-6c1e-7b41-9a2e-1f1d6a0b0003' as Id;
const d = '0193a8f2-6c1e-7b41-9a2e-1f1d6a0b0004' as Id;

const edge = (taskId: Id, dependsOnTaskId: Id): DependencyEdge => ({ taskId, dependsOnTaskId });

function cycleOf(edges: DependencyEdge[]): readonly Id[] {
  try {
    assertAcyclic(edges);
  } catch (error) {
    expect(error).toBeInstanceOf(DependencyCycleError);
    expect((error as DependencyCycleError).code).toBe('dependency_cycle');
    return (error as DependencyCycleError).cycle;
  }
  throw new Error('expected DependencyCycleError');
}

test('a DAG passes', () => {
  expect(() => assertAcyclic([edge(a, b), edge(b, c), edge(a, c)])).not.toThrow();
});

test('an empty edge set passes', () => {
  expect(() => assertAcyclic([])).not.toThrow();
});

test('self dependency throws with a two-node cycle path', () => {
  const cycle = cycleOf([edge(a, a)]);
  expect(cycle).toEqual([a, a]);
});

test('two-cycle throws and reports the cycle path', () => {
  const cycle = cycleOf([edge(a, b), edge(b, a)]);
  expect(cycle).toEqual([a, b, a]);
});

test('long cycle throws and reports the full path', () => {
  const cycle = cycleOf([edge(a, b), edge(b, c), edge(c, d), edge(d, a)]);
  expect(cycle).toEqual([a, b, c, d, a]);
});

test('a cycle reachable behind an acyclic prefix is found', () => {
  const cycle = cycleOf([edge(a, b), edge(b, c), edge(c, b)]);
  expect(cycle).toEqual([b, c, b]);
});

test('cycle path nodes are branded ids from the graph', () => {
  const cycle = cycleOf([edge(a, b), edge(b, a)]);
  for (const id of cycle) expect([a, b]).toContain(id);
});
