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
import { quarantineRecord } from './quarantine';

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
  readonly binding?: OwnerBinding;
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
  const binding = captureOwnerBinding();
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

async function runFlush(
  options: QueueOptions & { journal: SessionJournal; binding: OwnerBinding },
): Promise<FlushResult> {
  const { binding } = options;
  const records = await options.journal.list(undefined, binding.ownerId);
  if (!isOwnerBindingCurrent(binding)) {
    return { uploaded: 0, remaining: records.length, conflict: null };
  }
  if (records.length === 0) {
    options.store.setPendingCount(0, binding);
    options.store.setSyncState('idle', null, binding);
    return { uploaded: 0, remaining: 0, conflict: null };
  }
  if (!options.online) {
    options.store.setPendingCount(records.length, binding);
    options.store.setSyncState(
      'offline',
      `${records.length} focus event${records.length === 1 ? '' : 's'} saved on this device. Uploading automatically when you reconnect.`,
      binding,
    );
    return { uploaded: 0, remaining: records.length, conflict: null };
  }

  const client = options.client ?? plannerClient;
  options.store.setSyncState('syncing', 'Uploading saved focus events…', binding);
  let uploaded = 0;
  let quarantined = 0;
  for (const record of records) {
    if (!isOwnerBindingCurrent(binding)) {
      return {
        uploaded,
        remaining: await remainingFor(options.journal, binding),
        conflict: null,
      };
    }
    try {
      const updated = await sendFocusEvent(client, record);
      await options.journal.remove(record.seq);
      uploaded += 1;
      options.store.update(updated, binding);
      options.store.setPendingCount(await remainingFor(options.journal, binding), binding);
    } catch (cause) {
      if (!isOwnerBindingCurrent(binding)) {
        return {
          uploaded,
          remaining: await remainingFor(options.journal, binding),
          conflict: null,
        };
      }
      if (cause instanceof ApiError && (cause.status === 403 || cause.status === 404)) {
        quarantineRecord(binding.ownerId, record, cause.detail);
        await options.journal.remove(record.seq);
        quarantined += 1;
        options.store.setPendingCount(await remainingFor(options.journal, binding), binding);
        continue;
      }
      const remaining = await remainingFor(options.journal, binding);
      options.store.setPendingCount(remaining, binding);
      if (cause instanceof ApiError && (cause.status === 409 || cause.status === 412 || cause.status === 422)) {
        const message = `${cause.detail} Saved focus events were kept on this device.`;
        options.store.setSyncState('conflict', message, binding);
        return { uploaded, remaining, conflict: message };
      }
      options.store.setSyncState(
        'offline',
        `${remaining} focus event${remaining === 1 ? '' : 's'} still waiting to upload.`,
        binding,
      );
      return { uploaded, remaining, conflict: null };
    }
  }
  if (!isOwnerBindingCurrent(binding)) {
    return { uploaded, remaining: await remainingFor(options.journal, binding), conflict: null };
  }
  if (quarantined > 0) {
    options.store.setSyncState(
      'conflict',
      `${quarantined} saved focus event${quarantined === 1 ? '' : 's'} could not be replayed because the session is no longer available. It was set aside on this device.`,
      binding,
    );
    return { uploaded, remaining: 0, conflict: null };
  }
  options.store.setSyncState('synced', 'Saved focus events uploaded.', binding);
  return { uploaded, remaining: 0, conflict: null };
}

export function cryptoRandomId(): string {
  return uuidV7Key();
}
