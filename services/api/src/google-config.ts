import { readFileSync, statSync } from 'node:fs';
import { atRestKey, parseKeyMaterial, type AtRestKey } from './application/at-rest-crypto.js';
import type { AppConfig } from './config.js';

/**
 * CAL-03 boot-time secrets (ADR-024). Read exactly once; never logged, never
 * stored on AppConfig, never sent anywhere but Google's token endpoint.
 */
export interface GoogleOAuthSecrets {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly tokenKey: AtRestKey;
  readonly redirectUri: string;
  readonly webOrigin: string;
}

export interface SecretFileSystem {
  readonly read: (path: string) => string;
  readonly stat: (path: string) => { readonly mode: number };
}

const defaultFs: SecretFileSystem = {
  read: (path) => readFileSync(path, 'utf8'),
  stat: (path) => statSync(path),
};

/**
 * Error messages name the env variable and the rule only: never the path's
 * contents, a JSON parser message (V8 quotes a fragment of the input) or a key.
 */
function readSecretFile(name: string, path: string, fs: SecretFileSystem): string {
  let mode: number;
  try {
    mode = fs.stat(path).mode;
  } catch {
    throw new Error(`${name} does not exist or is not readable`);
  }
  if ((mode & 0o077) !== 0) {
    throw new Error(`${name} must not be group- or world-accessible (chmod 600)`);
  }
  try {
    return fs.read(path);
  } catch {
    throw new Error(`${name} could not be read`);
  }
}

const CLIENT_SHAPE_MESSAGE =
  'GOOGLE_OAUTH_CLIENT_FILE must be the downloaded OAuth client JSON with a "web" (or "installed") client_id and client_secret';

export function parseGoogleClientJson(raw: string): { clientId: string; clientSecret: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('GOOGLE_OAUTH_CLIENT_FILE is not valid JSON');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(CLIENT_SHAPE_MESSAGE);
  }
  const record = parsed as Record<string, unknown>;
  const client = record['web'] ?? record['installed'];
  if (client === null || typeof client !== 'object' || Array.isArray(client)) {
    throw new Error(CLIENT_SHAPE_MESSAGE);
  }
  const clientId = (client as Record<string, unknown>)['client_id'];
  const clientSecret = (client as Record<string, unknown>)['client_secret'];
  const valid = (value: unknown): value is string =>
    typeof value === 'string' && value.trim().length > 0 && value.length <= 1_024 && !/\s/u.test(value.trim());
  if (!valid(clientId) || !valid(clientSecret)) throw new Error(CLIENT_SHAPE_MESSAGE);
  return { clientId: clientId.trim(), clientSecret: clientSecret.trim() };
}

/**
 * Null = not configured (no client file or no token key): a normal state.
 * A configured file that is missing, group/world-readable or malformed fails
 * boot with a message naming the env variable.
 */
export function loadGoogleOAuthSecrets(
  config: Pick<
    AppConfig,
    'googleOAuthClientFile' | 'googleTokenKeyFile' | 'googleOAuthRedirectUri' | 'googleWebOrigin'
  >,
  fs: SecretFileSystem = defaultFs,
): GoogleOAuthSecrets | null {
  const clientFile = config.googleOAuthClientFile;
  const keyFile = config.googleTokenKeyFile;
  if (clientFile === null || keyFile === null) return null;
  const client = parseGoogleClientJson(readSecretFile('GOOGLE_OAUTH_CLIENT_FILE', clientFile, fs));
  const key = atRestKey(
    parseKeyMaterial(readSecretFile('GOOGLE_TOKEN_KEY_FILE', keyFile, fs), 'GOOGLE_TOKEN_KEY_FILE'),
  );
  if (config.googleOAuthRedirectUri === null || config.googleWebOrigin === null) {
    throw new Error(
      'GOOGLE_OAUTH_REDIRECT_URI and GOOGLE_WEB_ORIGIN are required when GOOGLE_OAUTH_CLIENT_FILE is set',
    );
  }
  return {
    ...client,
    tokenKey: key,
    redirectUri: config.googleOAuthRedirectUri,
    webOrigin: config.googleWebOrigin,
  };
}
