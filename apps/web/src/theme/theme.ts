import { computed, readonly, ref, type ComputedRef, type Ref } from 'vue';
import { readActiveOwnerId } from '../session/owner';
import { captureOwnerBinding, onActiveOwnerChange, type OwnerBinding } from '../session/ownerEpoch';
import { ownerSlot } from '../session/ownerStorage';
import { applyThemeColor } from './themeColor';

/**
 * The colour theme (HOLO-01). The user picks 다크, 라이트 or 시스템 in the top
 * bar; dark is the default.
 *
 * Two attributes on the root element carry it, and the stylesheets read only
 * the second:
 *   data-theme  = what the user chose  (dark | light | system)
 *   data-scheme = what is shown        (dark | light)
 * `prefers-color-scheme` is consulted here and only while the choice is
 * `system`; no stylesheet has a media query for it.
 *
 * The choice is remembered per owner on this device through the owner-scoped
 * storage module (session/ownerStorage.ts, slot `themePref`); nothing here
 * touches browser storage itself. `bootTheme()` runs before the app mounts
 * (main.ts), from the owner this browser profile is signed in as, so the first
 * frame is already in the right theme.
 */
export const THEME_CHOICES = ['light', 'dark', 'system'] as const;
export type ThemeChoice = (typeof THEME_CHOICES)[number];
export type ThemeScheme = 'light' | 'dark';

export const DEFAULT_THEME: ThemeChoice = 'dark';
const LIGHT_QUERY = '(prefers-color-scheme: light)';

const slot = ownerSlot('themePref');

export function themePrefKey(ownerId: string | null): string {
  return slot.keyFor(ownerId);
}

export function isThemeChoice(value: unknown): value is ThemeChoice {
  return typeof value === 'string' && (THEME_CHOICES as readonly string[]).includes(value);
}

/** Anything that is not one of the three words is the default. */
export function parseTheme(raw: string | null): ThemeChoice {
  return isThemeChoice(raw) ? raw : DEFAULT_THEME;
}

export function readTheme(ownerId: string | null): ThemeChoice {
  return parseTheme(slot.read(ownerId));
}

/** Into the binding's owner namespace, only while that binding is current (ADR-023). */
export function writeTheme(binding: OwnerBinding, choice: ThemeChoice): boolean {
  const result = slot.write(binding, choice);
  // Storage can be unavailable; the choice still applies to this page.
  return result !== 'stale' && result !== 'sealed';
}

export function resolveScheme(choice: ThemeChoice, systemPrefersLight: boolean): ThemeScheme {
  if (choice === 'system') return systemPrefersLight ? 'light' : 'dark';
  return choice;
}

const choice = ref<ThemeChoice>(DEFAULT_THEME);
const systemPrefersLight = ref(false);
const scheme = computed<ThemeScheme>(() => resolveScheme(choice.value, systemPrefersLight.value));

let media: MediaQueryList | null = null;
let stopWatchingOwner: (() => void) | null = null;

function onSystemChange(event: MediaQueryListEvent): void {
  systemPrefersLight.value = event.matches;
  apply();
}

function apply(): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  root.dataset['theme'] = choice.value;
  root.dataset['scheme'] = scheme.value;
  // Form controls, scrollbars and the canvas behind the page follow along.
  document.querySelector('meta[name="color-scheme"]')?.setAttribute('content', scheme.value);
  // A phone's browser bar, and an installed app's status bar, take the ground (HOLO-07).
  applyThemeColor(scheme.value);
}

function watchSystem(): void {
  if (media !== null || typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
  media = window.matchMedia(LIGHT_QUERY);
  systemPrefersLight.value = media.matches;
  media.addEventListener('change', onSystemChange);
}

/**
 * Read the signed-in owner's theme and put it on the root element. Safe to
 * call again (a test, a hot reload): it re-reads and re-applies.
 */
export function bootTheme(): void {
  watchSystem();
  choice.value = readTheme(readActiveOwnerId());
  apply();
  // Signing in (or another tab switching user) brings that owner's own choice.
  stopWatchingOwner ??= onActiveOwnerChange((nextOwnerId) => {
    choice.value = readTheme(nextOwnerId);
    apply();
  });
}

/** Test seam: drop the listeners and go back to the default. */
export function resetThemeForTests(): void {
  media?.removeEventListener('change', onSystemChange);
  media = null;
  stopWatchingOwner?.();
  stopWatchingOwner = null;
  choice.value = DEFAULT_THEME;
  systemPrefersLight.value = false;
  if (typeof document !== 'undefined') {
    delete document.documentElement.dataset['theme'];
    delete document.documentElement.dataset['scheme'];
  }
}

export interface ThemeControls {
  readonly choice: Readonly<Ref<ThemeChoice>>;
  readonly scheme: ComputedRef<ThemeScheme>;
  setTheme(next: ThemeChoice): void;
}

export function useTheme(): ThemeControls {
  function setTheme(next: ThemeChoice): void {
    // The owner is noted at the click, before anything else can change it.
    const binding = captureOwnerBinding();
    watchSystem();
    choice.value = next;
    apply();
    writeTheme(binding, next);
  }
  return { choice: readonly(choice), scheme, setTheme };
}
