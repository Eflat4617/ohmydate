// Mirrors packages/domain/src/brand.ts isIanaTimeZone exactly: the accepted
// set is Intl.supportedValuesOf('timeZone') plus 'UTC'/'Etc/UTC', not whatever
// Intl.DateTimeFormat happens to parse (FU-90 finding 6).
const IANA_TIME_ZONES = new Set([...Intl.supportedValuesOf('timeZone'), 'UTC', 'Etc/UTC']);

export function isIanaTimeZone(value) {
  return typeof value === 'string' && IANA_TIME_ZONES.has(value);
}
