import { DEFAULT_PREFERENCES, isLayoutMode, type LayoutPreferences } from '@ohmydate/ui-policy';
import { ownerStorageSuffix } from '../session/owner';
import { isOwnerBindingCurrent, type OwnerBinding } from '../session/ownerEpoch';

/**
 * "레이아웃 자동 전환" and the lock, per owner, on this device only. Stored as a
 * tiny JSON object; anything unexpected falls back to the defaults.
 */
const PREFIX = 'ohmydate.layout.prefs';

export function layoutPrefsKey(ownerId: string | null): string {
  return `${PREFIX}:${ownerStorageSuffix(ownerId)}`;
}

export function parseLayoutPrefs(raw: string | null): LayoutPreferences {
  if (raw === null) return DEFAULT_PREFERENCES;
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== 'object' || value === null) return DEFAULT_PREFERENCES;
    const record = value as Record<string, unknown>;
    const autoSwitch = typeof record['autoSwitch'] === 'boolean' ? record['autoSwitch'] : DEFAULT_PREFERENCES.autoSwitch;
    const locked = isLayoutMode(record['locked']) ? record['locked'] : null;
    return { autoSwitch, locked };
  } catch {
    return DEFAULT_PREFERENCES;
  }
}

export function readLayoutPrefs(ownerId: string | null): LayoutPreferences {
  if (typeof localStorage === 'undefined') return DEFAULT_PREFERENCES;
  try {
    return parseLayoutPrefs(localStorage.getItem(layoutPrefsKey(ownerId)));
  } catch {
    return DEFAULT_PREFERENCES;
  }
}

/** Writes into the binding's owner namespace only while that binding is current (ADR-023). */
export function writeLayoutPrefs(binding: OwnerBinding, prefs: LayoutPreferences): boolean {
  if (!isOwnerBindingCurrent(binding)) return false;
  if (typeof localStorage === 'undefined') return true;
  try {
    localStorage.setItem(
      layoutPrefsKey(binding.ownerId),
      JSON.stringify({ autoSwitch: prefs.autoSwitch, locked: prefs.locked }),
    );
  } catch {
    // Storage can be unavailable; the in-memory preference still applies.
  }
  return true;
}
