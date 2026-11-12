import { describe, expect, test } from 'vitest';
import { isIanaTimeZone as domainIsIanaTimeZone } from '../../packages/domain/src/brand.ts';
import { isIanaTimeZone as localIsIanaTimeZone } from './time-zone.mjs';

describe('local time-zone set parity with the domain', () => {
  test('accepts the same IANA identifiers and rejects the same spellings', () => {
    const accepted = [...Intl.supportedValuesOf('timeZone'), 'UTC', 'Etc/UTC'];
    for (const zone of accepted) {
      expect(localIsIanaTimeZone(zone), zone).toBe(true);
      expect(domainIsIanaTimeZone(zone), zone).toBe(true);
    }
    for (const zone of ['asia/seoul', '+09:00', 'EST', '', 'Mars/Olympus']) {
      expect(localIsIanaTimeZone(zone), zone).toBe(false);
      expect(domainIsIanaTimeZone(zone), zone).toBe(false);
    }
  });
});
