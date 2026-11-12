#!/usr/bin/env node
// GU-1 local setup: secrets -> healthy stack -> migrations -> Vikunja user +
// token -> planner user -> owner account. Re-running with the same email is a
// no-op unless --rotate-token is passed. Never prints the password or token.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  createContext,
  databaseUrl,
  describeTarget,
  fail,
  isEntryPoint,
  log,
  parseFlags,
  repoRoot,
  warn,
} from './common.mjs';
import { collectCredentials, resolveLocale, resolveTimeZone } from './prompt.mjs';
import { initSecrets } from './secrets.mjs';
import {
  ensureMigrations,
  findUserByEmail,
  upsertOwnerAccount,
  waitForStack,
} from './stack.mjs';
import {
  readJsonObject,
  tokenExpiry,
  tokenMapOf,
  VIKUNJA_TOKEN_PERMISSIONS,
  writeTokenFile,
  writeTokenMetadata,
} from './vikunja-token.mjs';

function vikunjaBase(vikunjaUrl) {
  return `${vikunjaUrl.replace(/\/+$/u, '')}/api/v2`;
}

async function vikunjaRequest(vikunjaUrl, pathname, options = {}) {
  const headers = { accept: 'application/json' };
  if (options.token !== undefined) headers.authorization = `Bearer ${options.token}`;
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  const response = await globalThis.fetch(`${vikunjaBase(vikunjaUrl)}${pathname}`, {
    method: options.method ?? 'GET',
    headers,
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
  const text = await response.text();
  let json = null;
  if (text.length > 0) {
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
  }
  return { status: response.status, json };
}

function usernameFor(email) {
  const digest = createHash('sha256').update(email).digest('hex').slice(0, 20);
  return `local-${digest}`;
}

async function vikunjaUserId(vikunjaUrl, jwt) {
  const me = await vikunjaRequest(vikunjaUrl, '/user', { token: jwt });
  return me.status === 200 && typeof me.json?.id === 'number' ? me.json.id : null;
}

async function tokenIsAlive(vikunjaUrl, token) {
  const me = await vikunjaRequest(vikunjaUrl, '/user', { token });
  return me.status === 200;
}

async function ensureVikunjaUser(vikunjaUrl, email, password) {
  const username = usernameFor(email);
  const login = await vikunjaRequest(vikunjaUrl, '/login', {
    method: 'POST',
    body: { username, password },
  });
  if (login.status === 200 && typeof login.json?.token === 'string') {
    const userId = await vikunjaUserId(vikunjaUrl, login.json.token);
    return { username, jwt: login.json.token, userId, created: false };
  }

  const register = await vikunjaRequest(vikunjaUrl, '/register', {
    method: 'POST',
    body: { username, email, password },
  });
  if (register.status !== 201 && register.status !== 200) {
    throw new Error(
      'Vikunja 사용자 등록/로그인에 실패했습니다. ' +
        `같은 이메일의 사용자가 이미 있고 비밀번호가 다를 수 있습니다 (register HTTP ${String(register.status)}, login HTTP ${String(login.status)}).`,
    );
  }
  const after = await vikunjaRequest(vikunjaUrl, '/login', {
    method: 'POST',
    body: { username, password },
  });
  if (after.status !== 200 || typeof after.json?.token !== 'string') {
    throw new Error('Vikunja 사용자 등록 후 로그인에 실패했습니다.');
  }
  return {
    username,
    jwt: after.json.token,
    userId: (await vikunjaUserId(vikunjaUrl, after.json.token)) ?? register.json?.id ?? null,
    created: true,
  };
}

async function ensureInbox(vikunjaUrl, jwt) {
  const projects = await vikunjaRequest(vikunjaUrl, '/projects?per_page=50', { token: jwt });
  if (projects.status !== 200 || !Array.isArray(projects.json?.items)) {
    throw new Error(`Vikunja 프로젝트 목록을 읽지 못했습니다 (HTTP ${String(projects.status)}).`);
  }
  const inbox = projects.json.items.find(
    (project) =>
      typeof project?.id === 'number' &&
      project.id > 0 &&
      typeof project?.title === 'string' &&
      project.title.toLowerCase() === 'inbox',
  );
  if (inbox !== undefined) return inbox.id;
  const created = await vikunjaRequest(vikunjaUrl, '/projects', {
    method: 'POST',
    token: jwt,
    body: { title: 'Inbox' },
  });
  if (created.status !== 200 && created.status !== 201) {
    throw new Error(`Vikunja Inbox 프로젝트 생성에 실패했습니다 (HTTP ${String(created.status)}).`);
  }
  return created.json?.id ?? null;
}

async function createVikunjaToken(vikunjaUrl, jwt, expiresAt) {
  const created = await vikunjaRequest(vikunjaUrl, '/tokens', {
    method: 'POST',
    token: jwt,
    body: {
      title: `ohmydate local ${new Date().toISOString().slice(0, 10)}`,
      expires_at: expiresAt,
      permissions: VIKUNJA_TOKEN_PERMISSIONS,
    },
  });
  if (
    (created.status !== 200 && created.status !== 201) ||
    typeof created.json?.token !== 'string'
  ) {
    throw new Error(`Vikunja API 토큰 생성에 실패했습니다 (HTTP ${String(created.status)}).`);
  }
  return {
    token: created.json.token,
    id: typeof created.json.id === 'number' ? created.json.id : null,
  };
}

async function deleteVikunjaToken(vikunjaUrl, jwt, id) {
  if (typeof id !== 'number') return false;
  const removed = await vikunjaRequest(vikunjaUrl, `/tokens/${String(id)}`, {
    method: 'DELETE',
    token: jwt,
  });
  return removed.status === 200 || removed.status === 204;
}

function resolveTsx() {
  const candidates = [
    join(repoRoot, 'services/api/node_modules/.bin/tsx'),
    join(repoRoot, 'node_modules/.bin/tsx'),
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

function createPlannerUser(databaseUrlValue, email, password, options = {}) {
  const tsx = resolveTsx();
  const script = join(repoRoot, 'services/api/src/cli/create-user.ts');
  const command = tsx ?? process.execPath;
  const baseArgs = tsx === null ? ['--experimental-strip-types', script, email] : [script, email];
  const args = [...baseArgs];
  if (options.timeZone !== undefined) args.push('--time-zone', options.timeZone);
  if (options.locale !== undefined) args.push('--locale', options.locale);
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    input: `${password}\n`,
    env: { ...process.env, DATABASE_URL: databaseUrlValue },
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
  });
  if (result.status !== 0) {
    const message = (result.stderr || result.stdout || '').trim().split(/\r?\n/u).pop() ?? '';
    throw new Error(`planner 사용자 생성에 실패했습니다: ${message}`);
  }
  const match = /\(([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\)/u.exec(
    result.stdout,
  );
  if (match === null || match[1] === undefined) {
    throw new Error('create-user 가 사용자 id 를 보고하지 않았습니다.');
  }
  return match[1];
}

/** Fixed Korean message; never include JSON.parse text (it can quote content). */
export function malformedFileMessage(path) {
  return `${path} 형식이 올바르지 않습니다. 파일을 지우고 local:setup 을 다시 실행하세요.`;
}

export async function readOptionalJson(path) {
  if (!existsSync(path)) return { parsed: null, text: null };
  const text = await readFile(path, 'utf8');
  try {
    return { parsed: readJsonObject(text), text };
  } catch {
    throw new Error(malformedFileMessage(path));
  }
}

async function main() {
  const { flags, values } = parseFlags(process.argv.slice(2));
  if (flags.has('help')) {
    console.log(
      'usage: node scripts/local/setup.mjs [--rotate-token] [--email <email>] ' +
        '[--time-zone <IANA>] [--locale <locale>]\n' +
        'env: OHMYDATE_LOCAL_EMAIL, OHMYDATE_LOCAL_PASSWORD, OHMYDATE_LOCAL_SECRETS_DIR, ' +
        'OHMYDATE_LOCAL_DATABASE_URL, OHMYDATE_LOCAL_VIKUNJA_URL',
    );
    return;
  }
  const rotateToken = flags.has('rotate-token');
  const env = process.env;
  const context = createContext(env);

  const secrets = await initSecrets({ context, env });
  log(`비밀 디렉터리 준비 완료: ${secrets.secretsDir}`);
  if (secrets.created.length > 0) log(`새 비밀 파일: ${secrets.created.join(', ')}`);

  // Only validate env-provided credentials before the stack check; an
  // interactive password prompt must wait until the stack is known healthy.
  const envEmail = values.get('email') ?? env.OHMYDATE_LOCAL_EMAIL;
  let credentials =
    envEmail !== undefined && env.OHMYDATE_LOCAL_PASSWORD !== undefined
      ? await collectCredentials(env, values)
      : null;

  const dbUrl = databaseUrl(context);
  log(describeTarget(context, dbUrl));

  log('스택 상태를 확인하는 중입니다...');
  await waitForStack(dbUrl, context.vikunjaUrl);

  credentials = credentials ?? (await collectCredentials(env, values));

  log('planner 마이그레이션을 적용하는 중입니다...');
  const migrationOutput = ensureMigrations(dbUrl);
  if (migrationOutput.length > 0) console.log(migrationOutput);

  const existingUser = await findUserByEmail(dbUrl, credentials.email);
  const vikunja = await ensureVikunjaUser(
    context.vikunjaUrl,
    credentials.email,
    credentials.password,
  );
  const inboxId = await ensureInbox(context.vikunjaUrl, vikunja.jwt);
  if (vikunja.userId === null) {
    throw new Error('Vikunja 사용자 id 를 확인하지 못했습니다.');
  }

  // C2: new users get the machine's IANA zone (Korean prompt allows a change)
  // and ko-KR. Existing users are never modified by a re-run.
  let timeZone;
  let locale;
  if (existingUser === null) {
    timeZone = await resolveTimeZone(env, values);
    locale = resolveLocale(env, values);
  }

  const ownerId =
    existingUser?.id ??
    createPlannerUser(dbUrl, credentials.email, credentials.password, { timeZone, locale });
  await upsertOwnerAccount(dbUrl, ownerId, vikunja.userId);

  const tokenFile = await readOptionalJson(context.tokenFile);
  const existingTokens = tokenMapOf(tokenFile.parsed);
  const metaFile = await readOptionalJson(context.tokenMetaFile);
  const metadata =
    metaFile.parsed !== null && typeof metaFile.parsed === 'object' && !Array.isArray(metaFile.parsed)
      ? metaFile.parsed
      : {};

  const previousToken = existingTokens[ownerId] ?? null;
  const previousTokenId = metadata[ownerId]?.tokenId ?? null;
  let expiresAt = metadata[ownerId]?.expiresAt ?? null;
  const retainedTokenAlive =
    previousToken === null ? false : await tokenIsAlive(context.vikunjaUrl, previousToken);

  let token = previousToken;
  let tokenId = previousTokenId;
  let tokenCreated = false;
  let rotated = false;
  if (token === null || rotateToken || !retainedTokenAlive) {
    expiresAt = tokenExpiry();
    const created = await createVikunjaToken(context.vikunjaUrl, vikunja.jwt, expiresAt);
    token = created.token;
    tokenId = created.id;
    tokenCreated = true;
    rotated = previousToken !== null;
  }

  const mergedTokens = { ...existingTokens, [ownerId]: token };
  const mergedMetadata = {
    ...metadata,
    [ownerId]: {
      expiresAt,
      vikunjaUserId: vikunja.userId,
      tokenId,
      updatedAt: new Date().toISOString(),
    },
  };
  try {
    if (tokenCreated || tokenFile.text === null) {
      await writeTokenFile(context.tokenFile, mergedTokens);
    }
    if (tokenCreated || metadata[ownerId] === undefined) {
      await writeTokenMetadata(context.tokenMetaFile, mergedMetadata);
    }
  } catch (error) {
    // The new token is not recorded anywhere yet; revoke it instead of
    // leaving an unrecorded 365-day token behind.
    if (tokenId !== null) {
      await deleteVikunjaToken(context.vikunjaUrl, vikunja.jwt, tokenId).catch(() => undefined);
    }
    throw new Error(
      'Vikunja 토큰 파일을 저장하지 못했습니다. 파일 권한과 디스크 공간을 확인한 뒤 다시 실행하세요.',
      { cause: error },
    );
  }

  if (rotated && previousTokenId !== null && previousTokenId !== tokenId) {
    const removed = await deleteVikunjaToken(
      context.vikunjaUrl,
      vikunja.jwt,
      previousTokenId,
    ).catch(() => false);
    if (!removed) warn('이전 Vikunja 토큰을 삭제하지 못했습니다 (이미 만료되었거나 직접 삭제 필요).');
  }

  log('설정 완료');
  log(` - 이메일: ${credentials.email}`);
  log(` - planner owner id: ${ownerId}`);
  log(` - Vikunja 사용자: ${vikunja.username} (id ${String(vikunja.userId)})`);
  log(` - Inbox 프로젝트 id: ${String(inboxId)}`);
  if (timeZone !== undefined) log(` - 시간대: ${timeZone} · locale: ${locale}`);
  log(
    ` - API 토큰: ${tokenCreated ? (retainedTokenAlive ? '새로 발급 (교체)' : '새로 발급') : '기존 토큰 유지'} ` +
      `(만료 ${expiresAt ?? '알 수 없음'})`,
  );
  log('다음 명령: corepack pnpm local:start');
  if (tokenCreated) {
    log('로컬 앱이 이미 실행 중이라면 local:stop 후 local:start 로 재시작하세요.');
  }
  if (secrets.created.length > 0) {
    warn('스택이 아직 없다면 coordinator가 `corepack pnpm local:secrets` 1회 후 `local:stack up` 을 실행해야 합니다.');
  }
}

if (isEntryPoint(import.meta.url)) {
  await main().catch((error) => {
    fail(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
