/**
 * Host names, besides loopback, that the built web may be asked for
 * (`vite preview`, started by `local:start`).
 *
 * The preview server refuses a request whose Host header it does not know:
 * that is what stops a web page elsewhere from reaching the app through a
 * name it points at this machine (DNS rebinding). A person who reaches the
 * app through a private network name — a tailnet name served by
 * `tailscale serve` — lists that exact name in `OHMYDATE_WEB_ALLOWED_HOSTS`
 * (comma-separated; `local:start` passes it from the local settings).
 *
 * Exact names only. A wildcard or a leading dot would allow names nobody
 * chose, so they are an error here and the server does not start.
 */
export const WEB_ALLOWED_HOSTS_ENV = 'OHMYDATE_WEB_ALLOWED_HOSTS';

const LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

export class AllowedHostError extends Error {
  constructor(entry: string) {
    // The entry is the operator's own setting, not user content.
    super(`${WEB_ALLOWED_HOSTS_ENV}: "${entry}" is not an exact host name (no wildcard, no leading dot, no port, no scheme)`);
    this.name = 'AllowedHostError';
  }
}

/** The extra host names from the environment; empty when none are set. */
export function allowedHostsFromEnv(env: Record<string, string | undefined> = process.env): string[] {
  const raw = env[WEB_ALLOWED_HOSTS_ENV];
  if (raw === undefined || raw.trim().length === 0) return [];
  const hosts: string[] = [];
  for (const part of raw.split(',')) {
    const entry = part.trim().toLowerCase().replace(/\.$/, '');
    if (entry.length === 0) continue;
    const labels = entry.split('.');
    if (entry.length > 253 || labels.length < 2 || !labels.every((label) => LABEL.test(label))) {
      throw new AllowedHostError(part.trim());
    }
    if (!hosts.includes(entry)) hosts.push(entry);
  }
  return hosts;
}
