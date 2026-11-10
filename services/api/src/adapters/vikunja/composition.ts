import type { Clock, IdGenerator } from '@ohmydate/domain';
import {
  VikunjaProjectRepository,
  VikunjaTaskRepository,
  type ChangeJournalStore,
  type MappingStore,
  type PlannerFieldStore,
} from '@ohmydate/provider-vikunja';
import type { Kysely } from 'kysely';
import type { AppRepositories } from '../../application/ports.js';
import type { AppConfig } from '../../config.js';
import type { Database } from '../../db/types.js';
import { loadVikunjaClients } from './owner-accounts.js';
import { PgChangeJournalStore } from './pg-change-journal-store.js';
import { PgMappingStore } from './pg-mapping-store.js';
import { PgPlannerFieldStore } from './pg-planner-field-store.js';

export interface VikunjaRepositories {
  readonly repos: AppRepositories;
  readonly tasks: VikunjaTaskRepository;
  readonly projects: VikunjaProjectRepository;
  readonly mappings: MappingStore;
  readonly plannerFields: PlannerFieldStore;
  readonly journal: ChangeJournalStore;
}

export interface VikunjaCompositionOptions {
  readonly db: Kysely<Database>;
  readonly config: AppConfig;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  /** Test/composition overrides; production builds the PostgreSQL stores. */
  readonly mappings?: MappingStore;
  readonly plannerFields?: PlannerFieldStore;
  readonly journal?: ChangeJournalStore;
}

/**
 * Composition root for `PROVIDER=vikunja`: durable PostgreSQL stores, one
 * Vikunja client per owner account (tokens resolved from env/file references),
 * and the adapter repositories sharing the same store instances.
 */
export async function createVikunjaRepositories(
  options: VikunjaCompositionOptions,
): Promise<VikunjaRepositories> {
  const mappings = options.mappings ?? new PgMappingStore(options.db);
  const plannerFields = options.plannerFields ?? new PgPlannerFieldStore(options.db, options.clock);
  const journal = options.journal ?? new PgChangeJournalStore(options.db, options.clock);
  const clients = await loadVikunjaClients({ db: options.db, config: options.config });
  const tasks = new VikunjaTaskRepository({
    clients,
    mappings,
    plannerFields,
    journal,
    clock: options.clock,
    ids: options.ids,
  });
  const projects = new VikunjaProjectRepository({
    clients,
    mappings,
    clock: options.clock,
    ids: options.ids,
  });
  return {
    repos: { tasks, projects },
    tasks,
    projects,
    mappings,
    plannerFields,
    journal,
  };
}
