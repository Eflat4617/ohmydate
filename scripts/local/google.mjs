// CAL-03: Google Calendar sync wiring for the local run package. The OAuth
// client JSON and the token key are secret files: this module checks their
// presence, mode and JSON shape, and never prints a value from either file.
import { readFileSync, statSync } from 'node:fs';

export const GOOGLE_CALLBACK_PATH = '/api/v1/integrations/google/callback';
export const GOOGLE_CLIENT_FILE_NAME = 'google-oauth-client.json';
export const GOOGLE_TOKEN_KEY_NAME = 'google-token.key';

/** Non-secret knobs passed through to the API when set (deploy/local/local.env or env). */
export const GOOGLE_TUNABLES = ['GOOGLE_SYNC_INTERVAL_MS', 'GOOGLE_IMPORT_DAYS', 'GOOGLE_EXPORT_DAYS'];

function defaultFs() {
  return {
    stat: (path) => statSync(path),
    read: (path) => readFileSync(path, 'utf8'),
  };
}

function modeOf(fs, path) {
  try {
    return fs.stat(path).mode & 0o777;
  } catch {
    return null;
  }
}

/** True when the JSON is a downloaded OAuth client (web or installed) with an id and a secret. */
function clientShapeValid(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return false;
  }
  const client = parsed?.web ?? parsed?.installed;
  return (
    client !== null &&
    typeof client === 'object' &&
    typeof client.client_id === 'string' &&
    client.client_id.trim().length > 0 &&
    typeof client.client_secret === 'string' &&
    client.client_secret.trim().length > 0
  );
}

/**
 * - `not_configured`: no client file (the normal state until the user follows
 *   docs/user/Google-캘린더-연동-설정.md); the API runs without Google.
 * - `invalid`: the user placed the client file but something would make the
 *   API refuse to boot (mode, shape, missing/open token key): start refuses
 *   with the exact fix.
 * - `configured`: the env the API needs.
 */
export function inspectGoogleSetup(context, fsApi = defaultFs()) {
  const clientFile = context.googleClientFile;
  const keyFile = context.googleTokenKeyFile;
  const redirectUri = `${context.webUrl}${GOOGLE_CALLBACK_PATH}`;
  const clientMode = modeOf(fsApi, clientFile);
  if (clientMode === null) {
    return {
      state: 'not_configured',
      line: `Google 캘린더 동기화: 설정 안 됨 (OAuth 클라이언트 파일 없음: ${clientFile})`,
    };
  }
  if ((clientMode & 0o077) !== 0) {
    return {
      state: 'invalid',
      line:
        `Google OAuth 클라이언트 파일 권한이 ${clientMode.toString(8)} 입니다. group/world 접근을 막아야 합니다. ` +
        `정확한 명령: chmod 600 ${clientFile}`,
    };
  }
  let text;
  try {
    text = fsApi.read(clientFile);
  } catch {
    return { state: 'invalid', line: `Google OAuth 클라이언트 파일을 읽지 못했습니다: ${clientFile}` };
  }
  if (!clientShapeValid(text)) {
    return {
      state: 'invalid',
      line:
        `Google OAuth 클라이언트 파일 형식이 올바르지 않습니다: ${clientFile}. ` +
        'Google Cloud 콘솔에서 내려받은 "웹 애플리케이션" 클라이언트 JSON을 그대로 두세요.',
    };
  }
  const keyMode = modeOf(fsApi, keyFile);
  if (keyMode === null) {
    return {
      state: 'invalid',
      line: `Google 토큰 키 파일이 없습니다: ${keyFile}. 먼저 \`corepack pnpm local:secrets\` 를 실행하세요.`,
    };
  }
  if ((keyMode & 0o077) !== 0) {
    return {
      state: 'invalid',
      line:
        `Google 토큰 키 파일 권한이 ${keyMode.toString(8)} 입니다. ` +
        `정확한 명령: chmod 600 ${keyFile}`,
    };
  }
  return {
    state: 'configured',
    line: `Google 캘린더 동기화: 설정됨 (리디렉션 URI: ${redirectUri})`,
    env: {
      GOOGLE_OAUTH_CLIENT_FILE: clientFile,
      GOOGLE_TOKEN_KEY_FILE: keyFile,
      GOOGLE_OAUTH_REDIRECT_URI: redirectUri,
      GOOGLE_WEB_ORIGIN: context.webUrl,
    },
  };
}

/** GOOGLE_SYNC_INTERVAL_MS etc. from the process env, else local.env, when set. */
export function googleTunables(env, settings) {
  const result = {};
  for (const name of GOOGLE_TUNABLES) {
    const value = env[name] ?? settings[name];
    if (value !== undefined && String(value).trim() !== '') result[name] = String(value).trim();
  }
  return result;
}
