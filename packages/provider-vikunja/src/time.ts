import { epochMsToInstant, type Instant } from '@ohmydate/domain';

/**
 * Normalise a Vikunja `date-time` to the planner's UTC `Instant`.
 * Vikunja uses `0001-01-01T00:00:00Z` for unset dates, which falls outside the
 * planner range and is treated as absent.
 */
export function normalizeRemoteInstant(value: string | undefined): Instant | undefined {
  if (value === undefined || value.length === 0) return undefined;
  const epochMs = Date.parse(value);
  if (!Number.isFinite(epochMs) || epochMs < 0) return undefined;
  try {
    return epochMsToInstant(epochMs);
  } catch {
    return undefined;
  }
}
