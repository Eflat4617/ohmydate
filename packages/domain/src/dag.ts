import type { Id } from './brand.js';
import { DependencyCycleError } from './errors.js';

export interface DependencyEdge {
  readonly taskId: Id;
  readonly dependsOnTaskId: Id;
}

const WHITE = 0;
const GRAY = 1;
const BLACK = 2;

export function assertAcyclic(edges: Iterable<DependencyEdge>): void {
  const adjacency = new Map<string, string[]>();
  const nodes = new Set<string>();

  const addNode = (node: string): void => {
    nodes.add(node);
    if (!adjacency.has(node)) adjacency.set(node, []);
  };

  for (const edge of edges) {
    const from = edge.taskId;
    const to = edge.dependsOnTaskId;
    addNode(from);
    addNode(to);
    adjacency.get(from)?.push(to);
  }

  const state = new Map<string, number>();
  for (const node of nodes) state.set(node, WHITE);
  const stack: string[] = [];

  const visit = (node: string): string[] | null => {
    state.set(node, GRAY);
    stack.push(node);

    for (const next of adjacency.get(node) ?? []) {
      const nextState = state.get(next) ?? WHITE;
      if (nextState === GRAY) {
        const cycleStart = stack.indexOf(next);
        return [...stack.slice(cycleStart), next];
      }
      if (nextState === WHITE) {
        const found = visit(next);
        if (found !== null) return found;
      }
    }

    stack.pop();
    state.set(node, BLACK);
    return null;
  };

  for (const node of nodes) {
    if ((state.get(node) ?? WHITE) !== WHITE) continue;
    const cycle = visit(node);
    if (cycle !== null) {
      throw new DependencyCycleError(cycle as Id[]);
    }
  }
}
