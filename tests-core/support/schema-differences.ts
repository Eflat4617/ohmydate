/**
 * The verdict differences between the reference validator (Ajv) and the
 * core's (`jsonschema`) that are known and decided. Each entry is a kind of
 * sample (see `samples.ts`) the two judge differently, and the id of its
 * decision in `docs/blueprint/15-DESKTOP-RUST-CORE.md` §2.4.
 *
 * `schema.test.ts` fails when a difference appears that is not listed here,
 * and when a listed one no longer occurs.
 */
export interface KnownDifference {
  /** Sample kind, exactly as the report prints it. */
  readonly kind: string;
  /** `true`: the reference accepts and the core refuses. `false`: the reverse. */
  readonly referenceAccepts: boolean;
  /** Decision id in the plan (§2.4). */
  readonly decision: string;
  /**
   * `kind` is a prefix, and any number of kinds may match it — none too.
   * For a family whose members depend on data outside the repository (which
   * zone names one runtime's ICU lists): the direction is decided, the
   * members are not pinned.
   */
  readonly family?: true;
}

export const knownDifferences: readonly KnownDifference[] = [
  // S1 — RFC 3339 has no such spellings; the core refuses them at the schema
  // (400), the reference lets them through to its domain check (422).
  { kind: 'format:date-time:offset-hours-only', referenceAccepts: true, decision: 'S1' },
  { kind: 'format:date-time:offset-no-colon', referenceAccepts: true, decision: 'S1' },
  { kind: 'format:date-time:space-separator', referenceAccepts: true, decision: 'S1' },
  // S2 — a UUID is the 36 characters; `urn:uuid:` in front is a URN.
  { kind: 'header:idempotency-key:format:uuid:urn-prefix', referenceAccepts: true, decision: 'S2' },
  { kind: 'header:idempotency-key:format:uuid:urn-prefix-upper', referenceAccepts: true, decision: 'S2' },
  // S3 — the core takes zone names from the tz database, the reference from
  // its runtime's ICU. The core accepts everything the reference accepts:
  // a difference in the other direction is not covered by this entry.
  { kind: 'format:iana-time-zone:', referenceAccepts: false, decision: 'S3', family: true },
  // S4 — half a surrogate pair is not Unicode text; the core does not read
  // such JSON at all (400).
  { kind: 'text:lone-surrogate', referenceAccepts: true, decision: 'S4' },
  { kind: 'text:lone-surrogate-inside', referenceAccepts: true, decision: 'S4' },
  { kind: 'non-blank-text:lone-surrogate', referenceAccepts: true, decision: 'S4' },
  { kind: 'non-blank-text:lone-surrogate-inside', referenceAccepts: true, decision: 'S4' },
];
