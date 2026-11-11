import {
  ApiError,
  plannerClient,
  uuidV7Key,
  type PlannerClient,
  type WorkSession,
} from '../api';
import { sessionJournal as defaultJournal, type FocusEventKind, type SessionEventRecord, type SessionJournal } from './journal';
import {
  captureOwnerBinding,
  isOwnerBindingCurrent,
  type OwnerBinding,
} from './ownerEpoch';
import {
  clearQuarantine,
  listQuarantine,
  quarantineRecord,
} from './quarantine';

export interface FocusStoreLike {
  get(sessionId: string): WorkSession | null;
  update(session: WorkSession, binding?: OwnerBinding): void;
  setPendingCount(count: number, binding?: OwnerBinding): void;
  setSyncState(
    state: 'idle' | 'offline' | 'syncing' | 'synced' | 'conflict',
    message?: string | null,
    binding?: OwnerBinding,
  ): void;
}

export interface FlushResult {
  readonly uploaded: number;
  readonly remaining: number;
  readonly conflict: string | null;
  readonly quarantined: number;
}

interface QueueOptions {
  readonly client?: PlannerClient;
  readonly journal?: SessionJournal;
  readonly store: FocusStoreLike;
  readonly online: boolean;
  readonly binding?: OwnerBinding;
}

interface EnqueueOptions extends QueueOptions {
  readonly key?: string;
  readonly clientAt?: string;
}

const flushes = new WeakMap<SessionJournal, Map<string, Promise<FlushResult>>>();

function flushKey(binding: OwnerBinding): string {
  return `${binding.ownerId ?? 'anonymous'}:${binding.epoch}`;
}

export function applyOptimistic(session: WorkSession, kind: FocusEventKind, clientAt: string): WorkSession {
  const version = session.version + 1;
  const cursorMs = Date.parse(session.startedAt) + (session.focusedSec + session.pausedSec) * 1000;
  const deltaSec = Math.max(0, Math.floor((Date.parse(clientAt) - cursorMs) / 1000));
  if (kind === 'pause') {
    return {
      ...session,
      state: 'paused',
      focusedSec:
        session.state === 'active' ? session.focusedSec + deltaSec : session.focusedSec,
      version,
    };
  }
  if (kind === 'resume') {
    return {
      ...session,
      state: 'active',
      pausedSec:
        session.state === 'paused' ? session.pausedSec + deltaSec : session.pausedSec,
      version,
    };
  }
  return {
    ...session,
    state: 'completed',
    endedAt: clientAt,
    focusedSec:
      session.state === 'active' ? session.focusedSec + deltaSec : session.focusedSec,
    pausedSec:
      session.state === 'paused' ? session.pausedSec + deltaSec : session.pausedSec,
    version,
  };
}

export async function enqueueFocusEvent(
  options: EnqueueOptions,
  session: WorkSession,
  kind: FocusEventKind,
): Promise<WorkSession> {
  const journal = options.journal ?? defaultJournal;
  const binding = options.binding ?? captureOwnerBinding();
  const clientAt = options.clientAt ?? new Date().toISOString();
  const key = options.key ?? uuidV7Key();
  await journal.append(
    {
      id: cryptoRandomId(),
      sessionId: session.id,
      kind,
      clientAt,
      idempotencyKey: key,
      expectedVersion: session.version,
    },
    binding.ownerId,
  );
  const optimistic = applyOptimistic(session, kind, clientAt);
  options.store.update(optimistic, binding);
  const remaining = (await journal.list(undefined, binding.ownerId)).length;
  options.store.setPendingCount(remaining, binding);
  options.store.setSyncState(
    'offline',
    `${remaining} focus event${remaining === 1 ? '' : 's'} saved on this device. Uploading automatically when you reconnect.`,
    binding,
  );
  return optimistic;
}

export async function sendFocusEvent(
  client: PlannerClient,
  record: Pick<SessionEventRecord, 'sessionId' | 'clientAt' | 'idempotencyKey' | 'expectedVersion' | 'kind'>,
  signal?: AbortSignal,
): Promise<WorkSession> {
  switch (record.kind) {
    case 'pause':
      return client.pauseSession(record.sessionId, record.clientAt, record.idempotencyKey, record.expectedVersion, signal);
    case 'resume':
      return client.resumeSession(record.sessionId, record.clientAt, record.idempotencyKey, record.expectedVersion, signal);
    case 'complete':
      return client.completeSession(record.sessionId, record.clientAt, record.idempotencyKey, record.expectedVersion, signal);
  }
}

export function flushFocusJournal(options: QueueOptions): Promise<FlushResult> {
  const journal = options.journal ?? defaultJournal;
  const binding = options.binding ?? captureOwnerBinding();
  const key = flushKey(binding);
  let byOwner = flushes.get(journal);
  if (byOwner === undefined) {
    byOwner = new Map();
    flushes.set(journal, byOwner);
  }
  const existing = byOwner.get(key);
  if (existing !== undefined) return existing;
  const pending = runFlush({ ...options, journal, binding }).finally(() => {
    byOwner?.delete(key);
  });
  byOwner.set(key, pending);
  return pending;
}

async function remainingFor(journal: SessionJournal, binding: OwnerBinding): Promise<number> {
  return (await journal.list(undefined, binding.ownerId)).length;
}

function setAsideNote(count: number): string {
  return `${count} saved focus event${count === 1 ? '' : 's'} ${count === 1 ? 'was' : 'were'} set aside on this device.`;
}

function withQuarantine(message: string, quarantined: number): string {
  return quarantined === 0 ? message : `${message} ${setAsideNote(quarantined)}`;
}

export async function retryQuarantinedFocusEvents(options: QueueOptions): Promise<number> {
  const journal = options.journal ?? defaultJournal;
  const binding = options.binding ?? captureOwnerBinding();
  const entries = listQuarantine(binding.ownerId);
  if (entries.length === 0) return 0;
  let requeued = 0;
  for (const entry of entries) {
    const record = entry.record;
    await journal.append(
      {
        id: record.id,
        sessionId: record.sessionId,
        kind: record.kind,
        clientAt: record.clientAt,
        idempotencyKey: record.idempotencyKey,
        expectedVersion: record.expectedVersion,
      },
      binding.ownerId,
    );
    requeued += 1;
  }
  clearQuarantine(binding.ownerId);
  const remaining = await remainingFor(journal, binding);
  options.store.setPendingCount(remaining, binding);
  options.store.setSyncState(
    'offline',
    `${remaining} focus event${remaining === 1 ? '' : 's'} re-queued from quarantine. Uploading automatically when you reconnect.`,
    binding,
  );
  return requeued;
}

async function runFlush(
  options: QueueOptions & { journal: SessionJournal; binding: OwnerBinding },
): Promise<FlushResult> {
  const { binding } = options;
  const records = await options.journal.list(undefined, binding.ownerId);
  if (!isOwnerBindingCurrent(binding)) {
    return { uploaded: 0, remaining: records.length, conflict: null, quarantined: 0 };
  }
  if (records.length === 0) {
    options.store.setPendingCount(0, binding);
    options.store.setSyncState('idle', null, binding);
    return { uploaded: 0, remaining: 0, conflict: null, quarantined: 0 };
  }
  if (!options.online) {
    options.store.setPendingCount(records.length, binding);
    options.store.setSyncState(
      'offline',
      `${records.length} focus event${records.length === 1 ? '' : 's'} saved on this device. Uploading automatically when you reconnect.`,
      binding,
    );
    return { uploaded: 0, remaining: records.length, conflict: null, quarantined: 0 };
  }

  const client = options.client ?? plannerClient;
  options.store.setSyncState('syncing', 'Uploading saved focus events…', binding);
  let uploaded = 0;
  let quarantined = 0;
  const stopForStaleOwner = async (): Promise<FlushResult> => ({
    uploaded,
    remaining: await remainingFor(options.journal, binding),
    conflict: null,
    quarantined,
  });
  for (const record of records) {
    if (!isOwnerBindingCurrent(binding)) return stopForStaleOwner();
    try {
      const updated = await sendFocusEvent(client, record, binding.signal);
      await options.journal.remove(record.seq);
      uploaded += 1;
      options.store.update(updated, binding);
      options.store.setPendingCount(await remainingFor(options.journal, binding), binding);
    } catch (cause) {
      if (!isOwnerBindingCurrent(binding)) return stopForStaleOwner();
      if (cause instanceof ApiError && (cause.status === 403 || cause.status === 404)) {
        let sameOwner: boolean;
        try {
          const me = await client.getMe(binding.signal);
          sameOwner = me.id === binding.ownerId;
        } catch {
          sameOwner = false;
        }
        if (!sameOwner || !isOwnerBindingCurrent(binding)) {
          const remaining = await remainingFor(options.journal, binding);
          options.store.setPendingCount(remaining, binding);
          const message = withQuarantine(
            `${remaining} focus event${remaining === 1 ? '' : 's'} still waiting to upload because the signed-in owner changed.`,
            quarantined,
          );
          options.store.setSyncState('conflict', message, binding);
          return { uploaded, remaining, conflict: null, quarantined };
        }
        if (!quarantineRecord(binding.ownerId, record, cause.detail)) {
          const remaining = await remainingFor(options.journal, binding);
          options.store.setPendingCount(remaining, binding);
          const message = withQuarantine(
            `${remaining} focus event${remaining === 1 ? '' : 's'} could not be set aside because this device could not store the quarantine. It remains in the queue.`,
            quarantined,
          );
          options.store.setSyncState('conflict', message, binding);
          return { uploaded, remaining, conflict: message, quarantined };
        }
        await options.journal.remove(record.seq);
        quarantined += 1;
        options.store.setPendingCount(await remainingFor(options.journal, binding), binding);
        continue;
      }
      const remaining = await remainingFor(options.journal, binding);
      options.store.setPendingCount(remaining, binding);
      if (cause instanceof ApiError && (cause.status === 409 || cause.status === 412 || cause.status === 422)) {
        const message = withQuarantine(
          `${cause.detail} Saved focus events were kept on this device.`,
          quarantined,
        );
        options.store.setSyncState('conflict', message, binding);
        return { uploaded, remaining, conflict: message, quarantined };
      }
      const message = withQuarantine(
        `${remaining} focus event${remaining === 1 ? '' : 's'} still waiting to upload.`,
        quarantined,
      );
      options.store.setSyncState('offline', message, binding);
      return { uploaded, remaining, conflict: null, quarantined };
    }
  }
  if (!isOwnerBindingCurrent(binding)) return stopForStaleOwner();
  if (quarantined > 0) {
    const message = setAsideNote(quarantined);
    options.store.setSyncState('conflict', message, binding);
    return { uploaded, remaining: 0, conflict: null, quarantined };
  }
  options.store.setSyncState('synced', 'Saved focus events uploaded.', binding);
  return { uploaded, remaining: 0, conflict: null, quarantined: 0 };
}

export function cryptoRandomId(): string {
  return uuidV7Key();
}
