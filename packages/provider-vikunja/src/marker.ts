import { isUuidV7, type Id } from '@ohmydate/domain';

const MARKER_PATTERN = /<!--\s*ohmydate:([0-9a-fA-F-]{36})\s*-->/g;
const TRAILING_MARKER_PATTERN = /\n*<!--\s*ohmydate:([0-9a-fA-F-]{36})\s*-->\s*$/;

/**
 * ADR-016 §2 orphan recovery marker. The marker is appended to the Vikunja
 * description so a crashed create can be reconciled by searching for the
 * planner UUID. It is stripped before a task crosses the domain boundary.
 */
export function appendMarker(description: string | undefined, id: Id): string {
  const marker = `<!-- ohmydate:${id} -->`;
  const base = description ?? '';
  return base.length === 0 ? marker : `${base}\n\n${marker}`;
}

export function stripMarker(description: string | undefined): string | undefined {
  if (description === undefined) return undefined;
  const match = TRAILING_MARKER_PATTERN.exec(description);
  if (match === null) return description.length === 0 ? undefined : description;
  const stripped = description.slice(0, match.index).trimEnd();
  return stripped.length === 0 ? undefined : stripped;
}

export function extractMarker(description: string | undefined): Id | null {
  if (description === undefined) return null;
  MARKER_PATTERN.lastIndex = 0;
  let last: string | null = null;
  for (let match = MARKER_PATTERN.exec(description); match !== null; match = MARKER_PATTERN.exec(description)) {
    last = match[1] ?? null;
  }
  return last !== null && isUuidV7(last) ? last : null;
}
