/**
 * Small date helpers kept for existing imports. Everything the user reads is
 * formatted by `src/i18n/format.ts` (Intl, user time zone, Korean copy).
 */
export { formatTimer, minutesBetween as durationMinutes } from './i18n/format';

export function localDateIso(now: Date = new Date()): string {
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}
