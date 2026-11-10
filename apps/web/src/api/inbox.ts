import type { PlannerClient, Project } from './client';

const MAX_PAGES = 1_000;
const PAGE_SIZE = 100;

/**
 * ADR-018: find the Inbox by kind, paging through /projects. Project lists are
 * ordered by creation time, so a non-first-page Inbox must still be found.
 */
export async function findInboxProject(
  client: PlannerClient,
  pageSize: number = PAGE_SIZE,
): Promise<Project | null> {
  let cursor: string | undefined;
  for (let pageCount = 0; pageCount < MAX_PAGES; pageCount += 1) {
    const page = await client.listProjects(
      cursor === undefined ? { limit: pageSize } : { limit: pageSize, cursor },
    );
    const inbox = page.items.find((project) => project.kind === 'inbox');
    if (inbox !== undefined) return inbox;
    if (page.nextCursor === null) return null;
    cursor = page.nextCursor;
  }
  throw new Error('project pagination did not terminate');
}
