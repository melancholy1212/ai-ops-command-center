export interface DependencyEdge {
  /** The task that waits. */
  taskId: string;
  /** The task it waits for. */
  dependsOnTaskId: string;
}

/**
 * Returns one cycle (as a list of task ids, first id repeated at the end) or null if the graph is
 * acyclic. Expansion may only add edges that keep the task graph a DAG; this is checked before commit.
 */
export function findCycle(edges: readonly DependencyEdge[]): string[] | null {
  const next = new Map<string, string[]>();
  for (const { taskId, dependsOnTaskId } of edges) {
    next.set(taskId, [...(next.get(taskId) ?? []), dependsOnTaskId]);
  }
  const state = new Map<string, 'visiting' | 'done'>();
  const path: string[] = [];

  const visit = (node: string): string[] | null => {
    if (state.get(node) === 'done') return null;
    if (state.get(node) === 'visiting') return [...path.slice(path.indexOf(node)), node];
    state.set(node, 'visiting');
    path.push(node);
    for (const target of next.get(node) ?? []) {
      const cycle = visit(target);
      if (cycle) return cycle;
    }
    path.pop();
    state.set(node, 'done');
    return null;
  };

  for (const node of next.keys()) {
    const cycle = visit(node);
    if (cycle) return cycle;
  }
  return null;
}
