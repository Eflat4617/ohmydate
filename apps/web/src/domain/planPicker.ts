import type { GoalSummary, Task } from '../api';

/**
 * FU-98: the /plans/new task picker groups open tasks by the plan (goal) that
 * created them, so a whole AI-generated plan is selected with one checkbox.
 * Pure functions; the view owns the loading and the selection state.
 */

/** One folder in the picker: a goal's open tasks, or the open tasks no goal claims. */
export interface PickerGroup {
  /** Stable key: `goal:<id>` or `other`. */
  readonly key: string;
  readonly kind: 'goal' | 'other';
  readonly goalId: string | null;
  /** The goal's title; null for the "기타 작업" group. */
  readonly title: string | null;
  readonly tasks: readonly Task[];
}

/** State of a group's "모두 선택" checkbox. `some` renders as indeterminate. */
export type GroupSelection = 'all' | 'some' | 'none';

/**
 * Load bounds: every page up to 10 × 100 tasks and 5 × 100 goals. Past either
 * bound the picker says its list is partial instead of silently cutting it.
 */
export const PICKER_PAGE_SIZE = 100;
export const PICKER_TASK_PAGES = 10;
export const PICKER_GOAL_PAGES = 5;

/** Groups beyond this count start collapsed, except the newest one. */
export const EXPANDED_GROUP_LIMIT = 3;

/** A task a plan can still schedule: not done, not deleted. */
export function isSchedulable(task: Task): boolean {
  return task.status !== 'done' && task.deletedAt === undefined;
}

function newestFirst(left: GoalSummary, right: GoalSummary): number {
  if (left.createdAt !== right.createdAt) return left.createdAt < right.createdAt ? 1 : -1;
  if (left.id === right.id) return 0;
  return left.id < right.id ? 1 : -1;
}

/**
 * Newest goal first; inside a goal, its approval's step order. A task is in
 * exactly one group (the newest goal that names it). Open tasks no goal names
 * form a final "other" group in list order. Goals with no open task are left
 * out: there is nothing in them to schedule.
 */
export function groupPickerTasks(goals: readonly GoalSummary[], tasks: readonly Task[]): PickerGroup[] {
  const open = new Map<string, Task>();
  for (const task of tasks) if (isSchedulable(task)) open.set(task.id, task);
  const assigned = new Set<string>();
  const groups: PickerGroup[] = [];
  for (const goal of [...goals].sort(newestFirst)) {
    const members: Task[] = [];
    for (const taskId of goal.taskIds) {
      const task = open.get(taskId);
      if (task === undefined || assigned.has(taskId)) continue;
      assigned.add(taskId);
      members.push(task);
    }
    if (members.length > 0) {
      groups.push({ key: `goal:${goal.id}`, kind: 'goal', goalId: goal.id, title: goal.title, tasks: members });
    }
  }
  const rest = [...open.values()].filter((task) => !assigned.has(task.id));
  if (rest.length > 0) groups.push({ key: 'other', kind: 'other', goalId: null, title: null, tasks: rest });
  return groups;
}

export function groupSelection(group: PickerGroup, selected: ReadonlySet<string>): GroupSelection {
  let count = 0;
  for (const task of group.tasks) if (selected.has(task.id)) count += 1;
  if (count === 0) return 'none';
  return count === group.tasks.length ? 'all' : 'some';
}

export function selectedCount(group: PickerGroup, selected: ReadonlySet<string>): number {
  return group.tasks.reduce((sum, task) => sum + (selected.has(task.id) ? 1 : 0), 0);
}

/**
 * The "모두 선택" click: a fully selected group is cleared; a partly or not
 * selected group gets every one of its tasks. Other groups are untouched.
 */
export function toggleGroup(group: PickerGroup, selected: ReadonlySet<string>): Set<string> {
  const next = new Set(selected);
  if (groupSelection(group, selected) === 'all') {
    for (const task of group.tasks) next.delete(task.id);
  } else {
    for (const task of group.tasks) next.add(task.id);
  }
  return next;
}

/** Few groups: all open. Many: only the newest (first) one. */
export function defaultGroupOpen(index: number, groupCount: number): boolean {
  return groupCount <= EXPANDED_GROUP_LIMIT || index === 0;
}

/**
 * The ids a plan is made from: the selected tasks still on screen, in display
 * order. A selected task that left the list (done elsewhere) is not sent.
 */
export function selectedTaskIdsInOrder(groups: readonly PickerGroup[], selected: ReadonlySet<string>): string[] {
  return groups.flatMap((group) => group.tasks.filter((task) => selected.has(task.id)).map((task) => task.id));
}

export interface SelectionSummary {
  readonly tasks: number;
  /** Goal groups with at least one selected task. */
  readonly plans: number;
  /** Whether a task of the "other" group is selected. */
  readonly other: boolean;
}

export function selectionSummary(groups: readonly PickerGroup[], selected: ReadonlySet<string>): SelectionSummary {
  let tasks = 0;
  let plans = 0;
  let other = false;
  for (const group of groups) {
    const count = selectedCount(group, selected);
    tasks += count;
    if (count === 0) continue;
    if (group.kind === 'goal') plans += 1;
    else other = true;
  }
  return { tasks, plans, other };
}
