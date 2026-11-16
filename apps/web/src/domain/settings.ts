/**
 * 설정 (HOLO-04, FLOW.md §4): one screen, four sections. Which one is open is
 * in the address (`/settings/<section>`); without one it is the first.
 */
export const SETTINGS_SECTIONS = ['availability', 'calendar', 'ai', 'display'] as const;

export type SettingsSection = (typeof SETTINGS_SECTIONS)[number];

export const DEFAULT_SETTINGS_SECTION: SettingsSection = 'availability';

/** The section a route parameter names; the first one for anything else. */
export function settingsSectionOf(value: unknown): SettingsSection {
  const name = Array.isArray(value) ? value[0] : value;
  return typeof name === 'string' && (SETTINGS_SECTIONS as readonly string[]).includes(name)
    ? (name as SettingsSection)
    : DEFAULT_SETTINGS_SECTION;
}

/**
 * The zones a time zone field offers: the engine's list, and always the zone
 * that is set. The owner's zone comes from the server's time zone database;
 * a web view's `Intl.supportedValuesOf('timeZone')` can be older or leave out
 * an alias (blueprint 15 §2.4 S3, §7.3 item 5). A zone the engine does not
 * list is still the owner's zone: it stays in the field, first, and is never
 * blanked or treated as a mistake.
 */
export function timeZoneChoices(listed: readonly string[], current: string | null | undefined): string[] {
  if (typeof current !== 'string' || current.length === 0 || listed.includes(current)) return [...listed];
  return [current, ...listed];
}
