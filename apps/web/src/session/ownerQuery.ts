import { QueryClient, type QueryClientConfig } from '@tanstack/vue-query';
import { OwnerChangedError } from './ownerBound';
import { isPageSealed, onActiveOwnerChange } from './ownerEpoch';

/**
 * The app's query cache, scoped to one owner (ADR-023 guardrail, FU-77).
 *
 * The cache lives in memory and is shared by every screen, so it must never
 * span two users:
 * - on any owner change every request in flight is cancelled and the whole
 *   cache is dropped, at once — nothing fetched for the previous user can be
 *   shown to the next one, whatever a screen's cache keys look like;
 * - once the page is sealed (a hard reset is under way) the cache takes no
 *   more data: `setQueryData` from a late continuation is ignored;
 * - a lookup that failed because its owner changed is never retried.
 */
const DEFAULT_RETRIES = 3;

class OwnerQueryClient extends QueryClient {
  private stopWatching: (() => void) | null = null;
  private mounts = 0;

  override mount(): void {
    this.mounts += 1;
    this.stopWatching ??= onActiveOwnerChange(() => this.dropEverything());
    super.mount();
  }

  override unmount(): void {
    this.mounts = Math.max(0, this.mounts - 1);
    if (this.mounts === 0) {
      this.stopWatching?.();
      this.stopWatching = null;
    }
    super.unmount();
  }

  private dropEverything(): void {
    // Cancelling is synchronous (the returned promise only reports completion):
    // a response that arrives later is ignored by the cancelled query.
    void this.cancelQueries();
    this.clear();
  }
}

/** A sealed page's cache takes no more data: late `setQueryData` calls are ignored. */
function refuseWritesWhenSealed(client: QueryClient): void {
  const setQueryData = client.setQueryData.bind(client) as (...args: unknown[]) => unknown;
  const setQueriesData = client.setQueriesData.bind(client) as (...args: unknown[]) => unknown;
  client.setQueryData = ((...args: unknown[]) =>
    isPageSealed() ? undefined : setQueryData(...args)) as QueryClient['setQueryData'];
  client.setQueriesData = ((...args: unknown[]) =>
    isPageSealed() ? [] : setQueriesData(...args)) as QueryClient['setQueriesData'];
}

/** The query client the app runs on (main.ts). Tests that need the owner scoping use it too. */
export function createOwnerQueryClient(config: QueryClientConfig = {}): QueryClient {
  const client = new OwnerQueryClient({
    ...config,
    defaultOptions: {
      ...config.defaultOptions,
      queries: {
        retry: (failureCount: number, cause: unknown) =>
          !(cause instanceof OwnerChangedError) && failureCount < DEFAULT_RETRIES,
        ...config.defaultOptions?.queries,
      },
    },
  });
  refuseWritesWhenSealed(client);
  return client;
}
