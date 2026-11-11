import {
  ApiError,
  plannerClient,
  uuidV7Key,
  type PlannerClient,
  type WorkSession,
} from '../api';
import { sessionJournal as defaultJournal, type FocusEventKind, type SessionEventRecord, type SessionJournal } from './journal';

export interface FocusStoreLike {
  get(sessionId: string): WorkSession | null;
  update(session: WorkSession): void;
  setPendingCount(count: number): void;
  setSyncState(state: 'idle' | 'offline' | 'syncing' | 'synced' | 'conflict', message?: string | null): void;
}

export interface FlushResult {
  readonly uploaded: number;
  readonly remaining: number;
  readonly conflict: string | null;
}

interface QueueOptions {
  readonly client?: PlannerClient;
  readonly journal?: SessionJournal;
  readonly store: FocusStoreLike;
  readonly online: boolean;
}

interface EnqueueOptions extends QueueOptions {
  readonly key?: string;
  readonly clientAt?: string;
}

const flushes = new WeakMap<SessionJournal, Promise<FlushResult>>();

export function applyOptimistic(session: WorkSession, kind: FocusEventKind, clientAt: string): WorkSession {
  const version = session.version + 1;
  if (kind === 'pause') {
    return { ...session, state: 'paused', version };
  }
  if (kind === 'resume') {
    return { ...session, state: 'active', version };
  }
  return { ...session, state: 'completed', endedAt: clientAt, version };
}

export async function enqueueFocusEvent(
  options: EnqueueOptions,
  session: WorkSession,
  kind: FocusEventKind,
): Promise<WorkSession> {
  const journal = options.journal ?? defaultJournal;
  const clientAt = options.clientAt ?? new Date().toISOString();
  const key = options.key ?? uuidV7Key();
  await journal.append({
    id: cryptoRandomId(),
    sessionId: session.id,
    kind,
    clientAt,
    idempotencyKey: key,
    expectedVersion: session.version,
  });
  const optimistic = applyOptimistic(session, kind, clientAt);
  options.store.update(optimistic);
  const remaining = (await journal.list()).length;
  options.store.setPendingCount(remaining);
  options.store.setSyncState(
    'offline',
    `${remaining} focus event${remaining === 1 ? '' : 's'} saved on this device. Uploading automatically when you reconnect.`,
  );
  return optimistic;
}

export async function sendFocusEvent(
  client: PlannerClient,
  record: Pick<SessionEventRecord, 'sessionId' | 'clientAt' | 'idempotencyKey' | 'expectedVersion' | 'kind'>,
): Promise<WorkSession> {
  switch (record.kind) {
    case 'pause':
      return client.pauseSession(record.sessionId, record.clientAt, record.idempotencyKey, record.expectedVersion);
    case 'resume':
      return client.resumeSession(record.sessionId, record.clientAt, record.idempotencyKey, record.expectedVersion);
    case 'complete':
      return client.completeSession(record.sessionId, record.clientAt, record.idempotencyKey, record.expectedVersion);
  }
}

export function flushFocusJournal(options: QueueOptions): Promise<FlushResult> {
  const journal = options.journal ?? defaultJournal;
  const existing = flushes.get(journal);
  if (existing !== undefined) return existing;
  const pending = runFlush({ ...options, journal }).finally(() => {
    flushes.delete(journal);
  });
  flushes.set(journal, pending);
  return pending;
}

async function runFlush(options: QueueOptions & { journal: SessionJournal }): Promise<FlushResult> {
  const records = await options.journal.list();
  if (records.length === 0) {
    options.store.setPendingCount(0);
    options.store.setSyncState('idle');
    return { uploaded: 0, remaining: 0, conflict: null };
  }
  if (!options.online) {
    options.store.setPendingCount(records.length);
    options.store.setSyncState(
      'offline',
      `${records.length} focus event${records.length === 1 ? '' : 's'} saved on this device. Uploading automatically when you reconnect.`,
    );
    return { uploaded: 0, remaining: records.length, conflict: null };
  }

  const client = options.client ?? plannerClient;
  options.store.setSyncState('syncing', 'Uploading saved focus events…');
  let uploaded = 0;
  for (const record of records) {
    try {
      const updated = await sendFocusEvent(client, record);
      options.store.update(updated);
      await options.journal.remove(record.seq);
      uploaded += 1;
      const remaining = (await options.journal.list()).length;
      options.store.setPendingCount(remaining);
    } catch (cause) {
      const remaining = (await options.journal.list()).length;
      options.store.setPendingCount(remaining);
      if (cause instanceof ApiError && (cause.status === 409 || cause.status === 412 || cause.status === 422)) {
        const message = `${cause.detail} Saved focus events were kept on this device.`;
        options.store.setSyncState('conflict', message);
        return { uploaded, remaining, conflict: message };
      }
      options.store.setSyncState(
        'offline',
        `${remaining} focus event${remaining === 1 ? '' : 's'} still waiting to upload.`,
      );
      return { uploaded, remaining, conflict: null };
    }
  }
  options.store.setSyncState('synced', 'Saved focus events uploaded.');
  return { uploaded, remaining: 0, conflict: null };
}

export function cryptoRandomId(): string {
  return uuidV7Key();
}
