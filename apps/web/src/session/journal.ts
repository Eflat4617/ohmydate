export type FocusEventKind = 'pause' | 'resume' | 'complete';

export interface SessionEventRecord {
  readonly seq: number;
  readonly id: string;
  readonly sessionId: string;
  readonly kind: FocusEventKind;
  readonly clientAt: string;
  readonly idempotencyKey: string;
  readonly expectedVersion: number;
}

export type QueuedSessionEvent = Omit<SessionEventRecord, 'seq'>;

export interface SessionJournal {
  append(event: QueuedSessionEvent): Promise<SessionEventRecord>;
  list(sessionId?: string): Promise<SessionEventRecord[]>;
  remove(seq: number): Promise<void>;
  clear(): Promise<void>;
}

const DB_NAME = 'ohmydate-focus';
const DB_VERSION = 1;
const STORE = 'events';

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
  });
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(STORE)) {
        const store = database.createObjectStore(STORE, { keyPath: 'seq', autoIncrement: true });
        store.createIndex('sessionId', 'sessionId', { unique: false });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('Could not open Focus journal'));
  });
}

export class IndexedDbSessionJournal implements SessionJournal {
  private database: Promise<IDBDatabase> | null = null;

  private db(): Promise<IDBDatabase> {
    this.database ??= openDatabase();
    return this.database;
  }

  async append(event: QueuedSessionEvent): Promise<SessionEventRecord> {
    const database = await this.db();
    const transaction = database.transaction(STORE, 'readwrite');
    const store = transaction.objectStore(STORE);
    const key = await requestResult(store.add(event));
    await new Promise<void>((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error ?? new Error('Journal write failed'));
      transaction.onabort = () => reject(transaction.error ?? new Error('Journal write aborted'));
    });
    return { ...event, seq: Number(key) };
  }

  async list(sessionId?: string): Promise<SessionEventRecord[]> {
    const database = await this.db();
    const transaction = database.transaction(STORE, 'readonly');
    const store = transaction.objectStore(STORE);
    const records = await requestResult<SessionEventRecord[]>(store.getAll());
    const filtered = sessionId === undefined ? records : records.filter((item) => item.sessionId === sessionId);
    return filtered.sort((left, right) => left.seq - right.seq);
  }

  async remove(seq: number): Promise<void> {
    const database = await this.db();
    const transaction = database.transaction(STORE, 'readwrite');
    await requestResult(transaction.objectStore(STORE).delete(seq));
    await new Promise<void>((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error ?? new Error('Journal delete failed'));
      transaction.onabort = () => reject(transaction.error ?? new Error('Journal delete aborted'));
    });
  }

  async clear(): Promise<void> {
    const database = await this.db();
    const transaction = database.transaction(STORE, 'readwrite');
    await requestResult(transaction.objectStore(STORE).clear());
    await new Promise<void>((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error ?? new Error('Journal clear failed'));
      transaction.onabort = () => reject(transaction.error ?? new Error('Journal clear aborted'));
    });
  }
}

export class MemorySessionJournal implements SessionJournal {
  private records: SessionEventRecord[] = [];
  private sequence = 0;

  async append(event: QueuedSessionEvent): Promise<SessionEventRecord> {
    this.sequence += 1;
    const record = { ...event, seq: this.sequence };
    this.records.push(record);
    return record;
  }

  async list(sessionId?: string): Promise<SessionEventRecord[]> {
    const records = sessionId === undefined ? this.records : this.records.filter((item) => item.sessionId === sessionId);
    return [...records].sort((left, right) => left.seq - right.seq);
  }

  async remove(seq: number): Promise<void> {
    this.records = this.records.filter((item) => item.seq !== seq);
  }

  async clear(): Promise<void> {
    this.records = [];
  }
}

export function createSessionJournal(): SessionJournal {
  if (typeof indexedDB === 'undefined') return new MemorySessionJournal();
  return new IndexedDbSessionJournal();
}

export const sessionJournal: SessionJournal = createSessionJournal();
