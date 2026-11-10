import type { Id } from './brand.js';
import { DependencyCycleError } from './errors.js';

export interface DependencyEdge {
  readonly taskId: Id;
  readonly dependsOnTaskId: Id;
}

const WHITE = 0;
const GRAY = 1;
const BLACK = 2;

interface TraversalFrame {
  readonly node: string;
  readonly neighbors: readonly string[];
  index: number;
}

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

  for (const start of nodes) {
    if ((state.get(start) ?? WHITE) !== WHITE) continue;

    const path: string[] = [start];
    const stack: TraversalFrame[] = [
      { node: start, neighbors: adjacency.get(start) ?? [], index: 0 },
    ];
    state.set(start, GRAY);

    while (stack.length > 0) {
      const frame = stack[stack.length - 1];
      if (frame === undefined) break;

      if (frame.index >= frame.neighbors.length) {
        state.set(frame.node, BLACK);
        stack.pop();
        path.pop();
        continue;
      }

      const next = frame.neighbors[frame.index];
      frame.index += 1;
      if (next === undefined) continue;

      const nextState = state.get(next) ?? WHITE;
      if (nextState === GRAY) {
        const cycleStart = path.indexOf(next);
        throw new DependencyCycleError([...path.slice(cycleStart), next] as Id[]);
      }
      if (nextState === WHITE) {
        state.set(next, GRAY);
        path.push(next);
        stack.push({ node: next, neighbors: adjacency.get(next) ?? [], index: 0 });
      }
    }
  }
}
