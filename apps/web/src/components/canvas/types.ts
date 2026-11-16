import type { Project, Task } from '../../api';

/**
 * What the 할 일 canvas can ask for (HOLO-05). The canvas draws and moves
 * things; the place (views/TasksView.vue) owns the requests, the conflict
 * dialog, the toasts and the undo. Every promise settles — a failure is said
 * by the place and comes back here as `false`, `null` or 0.
 */
export interface CanvasActions {
  /** Save a new title. False when nothing was saved (a conflict dialog may have opened). */
  rename(task: Task, title: string): Promise<boolean>;
  /** Mark it done. True once the server has it: the capsule then leaves the surface. */
  complete(task: Task): Promise<boolean>;
  /** Delete it (the place hides it at once and offers an undo). */
  remove(task: Task): void;
  /** Set the deadline, or take it away with null. */
  setDue(task: Task, dueAt: string | null): Promise<boolean>;
  /** File to-dos into a folder, or onto the open water (null). Answers the ids that were moved. */
  file(tasks: readonly Task[], folderId: string | null): Promise<string[]>;
  renameFolder(folder: Project, title: string): Promise<boolean>;
  /** Ask to remove a folder (the place confirms, empties it into the inbox, then archives it). */
  removeFolder(folder: Project): void;
  /** Ask for a new folder; `thenFile` are to-dos to put into it once it exists. */
  newFolder(thenFile?: readonly Task[]): void;
}
