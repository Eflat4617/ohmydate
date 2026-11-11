/**
 * M6-01R-1 H1: request URLs are logged as PATH ONLY for every route.
 *
 * Query values are user data (a note search string is note text) and no
 * name-based redaction of the raw string is reliable: Fastify decodes `%71`
 * to `q`, accepts repeated and bracketed keys, and a future
 * `useSemicolonDelimiter` would turn `;` into a separator. So the logged URL
 * stops at the first `?`, `;` or `#`, and values are never logged at all.
 *
 * For observability only the NAMES of a small allow-list of structural
 * parameters are reported (decoded with URLSearchParams semantics, exact
 * case), plus a count of every other parameter.
 */

export const LOGGABLE_QUERY_PARAM_NAMES: ReadonlySet<string> = new Set([
  'cursor',
  'date',
  'from',
  'limit',
  'projectId',
  'state',
  'status',
  'targetId',
  'targetKind',
  'taskId',
  'to',
]);

export interface LoggedUrl {
  /** Request path with everything from the first `?`, `;` or `#` removed. */
  readonly path: string;
  /** Allow-listed parameter names present (sorted, unique). Present only with a query. */
  readonly queryKeys?: readonly string[];
  /** Number of parameters whose names are not allow-listed. Present only with a query. */
  readonly queryOmitted?: number;
}

const SEPARATOR = /[?;#]/;

export function loggedUrl(rawUrl: string): LoggedUrl {
  const cut = rawUrl.search(SEPARATOR);
  if (cut < 0) return { path: rawUrl };
  const path = rawUrl.slice(0, cut);
  // Everything after the path, minus a fragment, split on both `&` and `;`.
  const rest = rawUrl.slice(cut + 1).split('#', 1)[0] ?? '';
  const keys = new Set<string>();
  let omitted = 0;
  for (const part of rest.split(/[&;]/)) {
    if (part.length === 0) continue;
    let name: string;
    try {
      // URLSearchParams semantics: `+` is a space and percent escapes decode.
      name = [...new URLSearchParams(part).keys()][0] ?? '';
    } catch {
      name = '';
    }
    if (LOGGABLE_QUERY_PARAM_NAMES.has(name)) keys.add(name);
    else omitted += 1;
  }
  return { path, queryKeys: [...keys].sort(), queryOmitted: omitted };
}

/** Path-only form for `route` fields and other single-string log sites. */
export function loggedPath(rawUrl: string): string {
  return loggedUrl(rawUrl).path;
}
