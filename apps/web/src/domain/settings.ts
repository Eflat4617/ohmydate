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
