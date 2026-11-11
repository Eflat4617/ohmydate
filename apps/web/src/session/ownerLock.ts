import { ownerStorageSuffix } from './owner';

type LockTask<T> = () => Promise<T>;

interface LockChannelMessage {
  readonly type: 'lock-acquired' | 'lock-released';
  readonly name: string;
}

const fallbackTails = new Map<string, Promise<void>>();
let channel: BroadcastChannel | null = null;

function lockChannel(): BroadcastChannel | null {
  if (typeof BroadcastChannel === 'undefined') return null;
  if (channel !== null) return channel;
  try {
    channel = new BroadcastChannel('ohmydate.focus.locks');
    const handle = channel as unknown as { unref?: () => void };
    handle.unref?.();
    return channel;
  } catch {
    return null;
  }
}

function announce(type: LockChannelMessage['type'], name: string): void {
  try {
    lockChannel()?.postMessage({ type, name } satisfies LockChannelMessage);
  } catch (cause) {
    void cause;
  }
}

async function withFallbackLock<T>(name: string, task: LockTask<T>): Promise<T> {
  const previous = fallbackTails.get(name) ?? Promise.resolve();
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.then(() => held);
  fallbackTails.set(name, tail);
  await previous.catch(() => undefined);
  announce('lock-acquired', name);
  try {
    return await task();
  } finally {
    announce('lock-released', name);
    release();
    if (fallbackTails.get(name) === tail) fallbackTails.delete(name);
  }
}

export function ownerLockName(ownerId: string | null): string {
  return `ohmydate.focus.owner.${ownerStorageSuffix(ownerId)}`;
}

export function withOwnerLock<T>(ownerId: string | null, task: LockTask<T>): Promise<T> {
  const name = ownerLockName(ownerId);
  const locks = typeof navigator === 'undefined' ? undefined : navigator.locks;
  if (locks !== undefined && typeof locks.request === 'function') {
    return locks.request(name, { mode: 'exclusive' }, () => task()) as unknown as Promise<T>;
  }
  return withFallbackLock(name, task);
}
