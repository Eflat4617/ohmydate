import type { OwnerBinding } from './ownerEpoch';

/**
 * Owner-scoped persistence (ADR-023 guardrail, FU-77).
 *
 * This is the ONLY module allowed to touch `localStorage`, `sessionStorage` or
 * `indexedDB`; ESLint (apps/web/eslint.config.js) fails any other source file
 * that does. Everything the app keeps on the device is declared in the three
 * tables below, so one file answers "what is stored here, for whom, and what
 * happens to it when the signed-in user changes".
 *
 * Rules the API enforces, so a screen cannot get them wrong:
 * - an owner slot's key is always `<prefix>:<owner id>`; there is no way to
 *   write an unscoped key outside the device allowlist;
 * - a write takes the OwnerBinding captured where the action started. The
 *   namespace comes from that binding, never from "whoever is signed in now",
 *   and a stale binding writes nothing (`staleWrites: 'drop'`);
 * - only slots declared `keep-for-owner` (durable data whose loss would lose
 *   the user's work) accept a late or explicit-owner write, and it lands in
 *   that owner's own namespace;
 * - once the page is sealed (the owner changed and the hard reload is under
 *   way) nothing is written into the new owner's namespace: that namespace
 *   opens on the reloaded page, after `/me` (ADR-023 §2);
 * - slots declared `onOwnerChange: 'clear'` are emptied for every owner,
 *   synchronously, on any owner change; the rest are preserved for the next
 *   time that owner signs in (ADR-023 §1).
 */

export const ANONYMOUS_OWNER = 'anonymous';

type StorageArea = 'local' | 'session';

interface OwnerSlotSpec {
  readonly area: StorageArea;
  /** The stored key is `<prefix>:<owner id | 'anonymous'>`. */
  readonly prefix: string;
  readonly staleWrites: 'drop' | 'keep-for-owner';
  readonly onOwnerChange: 'preserve' | 'clear';
  readonly why: string;
}

/** Every per-owner key the web client persists. Add a line here to persist something new. */
const OWNER_SLOTS = {
  focusSessions: {
    area: 'local',
    prefix: 'ohmydate.focus.sessions',
    staleWrites: 'keep-for-owner',
    onOwnerChange: 'preserve',
    why: 'Focus sessions cached for offline use. A response that arrives after a user switch is still that owner’s session, so it is kept — in that owner’s namespace only.',
  },
  focusQuarantine: {
    area: 'local',
    prefix: 'ohmydate.focus.quarantine',
    staleWrites: 'keep-for-owner',
    onOwnerChange: 'preserve',
    why: 'Focus events the server refused, set aside for a retry. Dropping one would lose recorded focus time.',
  },
  focusClientId: {
    area: 'local',
    prefix: 'ohmydate.focus.clientId',
    staleWrites: 'keep-for-owner',
    onOwnerChange: 'preserve',
    why: 'A random id naming this device’s focus client for one owner. No user content.',
  },
  layoutPrefs: {
    area: 'local',
    prefix: 'ohmydate.layout.prefs',
    staleWrites: 'drop',
    onOwnerChange: 'preserve',
    why: 'Layout auto-switch and lock, per owner on this device.',
  },
  layoutRiskAck: {
    area: 'local',
    prefix: 'ohmydate.layout.riskAck',
    staleWrites: 'drop',
    onOwnerChange: 'preserve',
    why: 'The day the owner acknowledged the deadline-risk panel (a date).',
  },
  layoutReviewed: {
    area: 'local',
    prefix: 'ohmydate.layout.reviewed',
    staleWrites: 'drop',
    onOwnerChange: 'preserve',
    why: 'Ids of sessions the owner already reviewed (ids only).',
  },
  layoutReviewSkip: {
    area: 'local',
    prefix: 'ohmydate.layout.reviewSkip',
    staleWrites: 'drop',
    onOwnerChange: 'preserve',
    why: 'The day the owner skipped the review prompt (a date).',
  },
  themePref: {
    area: 'local',
    prefix: 'ohmydate.theme',
    staleWrites: 'drop',
    onOwnerChange: 'preserve',
    why: 'The colour theme the owner chose (dark, light or system), per owner on this device. One word, no user content.',
  },
  shellNav: {
    area: 'local',
    prefix: 'ohmydate.shell.nav',
    staleWrites: 'drop',
    onOwnerChange: 'preserve',
    why: 'Whether the owner folded the sidebar down to icons, per owner on this device. A flag, no user content.',
  },
  aiWait: {
    area: 'session',
    prefix: 'ohmydate.intake.aiWait.v2',
    staleWrites: 'drop',
    onOwnerChange: 'clear',
    why: 'A pending wizard AI wait, resumed after a reload. It holds the user’s private input, so every owner’s record is removed on any owner change (FU-76R-1 H2).',
  },
  llmConsentPrompt: {
    area: 'session',
    prefix: 'ohmydate.llm.consentPrompt',
    staleWrites: 'drop',
    onOwnerChange: 'clear',
    why: 'That the owner closed the AI consent dialog in this browser session, so a reload does not reopen it (FU-91). A marker only; cleared on any owner change, so a new sign-in asks again.',
  },
} as const satisfies Record<string, OwnerSlotSpec>;

interface DeviceSlotSpec {
  readonly area: StorageArea;
  readonly key: string;
  readonly onOwnerChange: 'preserve' | 'clear';
  readonly why: string;
}

/**
 * The allowlist of keys that are NOT namespaced by an owner. Device-level
 * facts only; never user content. Anything else belongs in OWNER_SLOTS.
 */
const DEVICE_SLOTS = {
  activeOwner: {
    area: 'local',
    key: 'ohmydate.focus.owner',
    onOwnerChange: 'preserve',
    why: 'Which owner this browser profile is signed in as. Other tabs learn of a user switch from its storage event. An id, no user content.',
  },
  legacyAiWait: {
    area: 'session',
    key: 'ohmydate.intake.aiWait.v1',
    onOwnerChange: 'clear',
    why: 'The pre-FU-76R-1 unscoped AI-wait record. Never read; removed on sight.',
  },
} as const satisfies Record<string, DeviceSlotSpec>;

/** IndexedDB databases the client may open. One per device; records carry their owner. */
const DEVICE_DATABASES = {
  'ohmydate-focus': {
    why: 'The offline Focus event journal. Every record carries `ownerId`, and every read, clear and replay filters by it (session/journal.ts).',
  },
} as const satisfies Record<string, { readonly why: string }>;

export type OwnerSlotName = keyof typeof OWNER_SLOTS;
export type DeviceSlotName = keyof typeof DEVICE_SLOTS;
export type DeviceDatabaseName = keyof typeof DEVICE_DATABASES;
type DurableSlotName = {
  [K in OwnerSlotName]: (typeof OWNER_SLOTS)[K]['staleWrites'] extends 'keep-for-owner' ? K : never;
}[OwnerSlotName];

/**
 * - `ok`: stored (or removed).
 * - `stale`: the binding is no longer current and the slot drops stale writes.
 * - `sealed`: the page is being hard-reset; the new owner's namespace is closed.
 * - `unavailable`: this browser has no such storage.
 * - `failed`: storage threw (private mode, quota).
 */
export type OwnerWriteResult = 'ok' | 'stale' | 'sealed' | 'unavailable' | 'failed';

/** Who is signed in, as known by session/ownerEpoch.ts (which registers itself here). */
export interface OwnerAuthority {
  isCurrent(binding: OwnerBinding): boolean;
  currentOwnerId(): string | null;
  isPageSealed(): boolean;
}

// Until ownerEpoch registers, no binding can exist, so none is current.
let authority: OwnerAuthority = {
  isCurrent: () => false,
  currentOwnerId: () => null,
  isPageSealed: () => false,
};

export function bindOwnerAuthority(next: OwnerAuthority): void {
  authority = next;
}

function storageArea(area: StorageArea): Storage | null {
  try {
    if (area === 'local') return typeof localStorage === 'undefined' ? null : localStorage;
    return typeof sessionStorage === 'undefined' ? null : sessionStorage;
  } catch {
    // Reading the property itself can throw when storage is blocked.
    return null;
  }
}

function readKey(area: StorageArea, key: string): string | null {
  const store = storageArea(area);
  if (store === null) return null;
  try {
    return store.getItem(key);
  } catch {
    return null;
  }
}

function writeKey(area: StorageArea, key: string, value: string | null): OwnerWriteResult {
  const store = storageArea(area);
  if (store === null) return 'unavailable';
  try {
    if (value === null) store.removeItem(key);
    else store.setItem(key, value);
    return 'ok';
  } catch {
    return 'failed';
  }
}

/** A sealed page never opens the namespace of the owner it is being reset for. */
function closedBySeal(ownerId: string | null): boolean {
  return authority.isPageSealed() && ownerId === authority.currentOwnerId();
}

export interface OwnerSlot {
  /** True when this browser has the slot's storage area at all. */
  available(): boolean;
  keyFor(ownerId: string | null): string;
  read(ownerId: string | null): string | null;
  /** Into the binding's own namespace; nothing at all once the binding is stale (unless the slot is durable). */
  write(binding: OwnerBinding, value: string): OwnerWriteResult;
  remove(binding: OwnerBinding): OwnerWriteResult;
  /** Remove one owner's value (cleanup of an invalid or dismissed record). */
  discard(ownerId: string | null): OwnerWriteResult;
  /** Remove every owner's value. */
  clearAllOwners(): void;
}

/** A `keep-for-owner` slot: durable data may also be written for an explicitly named owner. */
export interface DurableOwnerSlot extends OwnerSlot {
  writeFor(ownerId: string | null, value: string): OwnerWriteResult;
}

function createOwnerSlot(spec: OwnerSlotSpec): DurableOwnerSlot {
  const keyFor = (ownerId: string | null): string => `${spec.prefix}:${ownerId ?? ANONYMOUS_OWNER}`;

  function store(ownerId: string | null, value: string | null): OwnerWriteResult {
    if (closedBySeal(ownerId)) return 'sealed';
    return writeKey(spec.area, keyFor(ownerId), value);
  }

  function bound(binding: OwnerBinding, value: string | null): OwnerWriteResult {
    if (spec.staleWrites === 'drop' && !authority.isCurrent(binding)) return 'stale';
    return store(binding.ownerId, value);
  }

  return {
    available: () => storageArea(spec.area) !== null,
    keyFor,
    read: (ownerId) => readKey(spec.area, keyFor(ownerId)),
    write: (binding, value) => bound(binding, value),
    remove: (binding) => bound(binding, null),
    discard: (ownerId) => store(ownerId, null),
    clearAllOwners() {
      const area = storageArea(spec.area);
      if (area === null) return;
      try {
        const keys: string[] = [];
        for (let index = 0; index < area.length; index += 1) {
          const key = area.key(index);
          if (key !== null && key.startsWith(`${spec.prefix}:`)) keys.push(key);
        }
        for (const key of keys) area.removeItem(key);
      } catch {
        // Storage blocked: nothing was persisted either.
      }
    },
    writeFor: (ownerId, value) => store(ownerId, value),
  };
}

const ownerSlots = new Map<OwnerSlotName, DurableOwnerSlot>();

export function ownerSlot<Name extends OwnerSlotName>(
  name: Name,
): Name extends DurableSlotName ? DurableOwnerSlot : OwnerSlot {
  let slot = ownerSlots.get(name);
  if (slot === undefined) {
    slot = createOwnerSlot(OWNER_SLOTS[name]);
    ownerSlots.set(name, slot);
  }
  return slot;
}

export interface DeviceSlot {
  readonly key: string;
  read(): string | null;
  write(value: string): OwnerWriteResult;
  remove(): OwnerWriteResult;
}

export function deviceSlot(name: DeviceSlotName): DeviceSlot {
  const spec: DeviceSlotSpec = DEVICE_SLOTS[name];
  return {
    key: spec.key,
    read: () => readKey(spec.area, spec.key),
    write: (value) => writeKey(spec.area, spec.key, value),
    remove: () => writeKey(spec.area, spec.key, null),
  };
}

/**
 * Called by ownerEpoch on every owner change, before any listener or late
 * continuation can run: slots that must not outlive the owner are emptied.
 */
export function clearSlotsOnOwnerChange(): void {
  for (const name of Object.keys(OWNER_SLOTS) as OwnerSlotName[]) {
    if (OWNER_SLOTS[name].onOwnerChange === 'clear') ownerSlot(name).clearAllOwners();
  }
  for (const name of Object.keys(DEVICE_SLOTS) as DeviceSlotName[]) {
    if (DEVICE_SLOTS[name].onOwnerChange === 'clear') deviceSlot(name).remove();
  }
}

export function hasIndexedDb(): boolean {
  try {
    return typeof indexedDB !== 'undefined';
  } catch {
    return false;
  }
}

/**
 * Open one of the allowlisted device databases. Records in it must carry
 * their owner; `ownerNamespaceClosed` tells a writer when to refuse.
 */
export function openDeviceDatabase(
  name: DeviceDatabaseName,
  version: number,
  upgrade: (request: IDBOpenDBRequest) => void,
): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name, version);
    request.onupgradeneeded = () => upgrade(request);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error(`Could not open ${name}`));
  });
}

/** True when a persistent write for `ownerId` must be refused (sealed page, new owner). */
export function ownerNamespaceClosed(ownerId: string | null): boolean {
  return closedBySeal(ownerId);
}

/** The declared tables, for the guardrail's own tests and for documentation. */
export const OWNER_STORAGE_MANIFEST = {
  ownerSlots: OWNER_SLOTS,
  deviceSlots: DEVICE_SLOTS,
  deviceDatabases: DEVICE_DATABASES,
} as const;
