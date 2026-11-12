#!/usr/bin/env node
// Build (when stale) and start the built API + web preview detached. Logs and
// PID files live under .local/. Preflight never opens the LLM key file.
import { spawn } from 'node:child_process';
import {
  accessSync,
  closeSync,
  constants,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from 'node:fs';
import { chmod, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import {
  childProcessEnv,
  createContext,
  databaseUrl,
  describeTarget,
  ensureDir,
  fail,
  fileExists,
  isEntryPoint,
  log,
  parseFlags,
  processAlive,
  pnpmInvocation,
  repoRoot,
  runPnpm,
  STACK_DOWN_MESSAGE,
  warn,
} from './common.mjs';
import {
  createMarker,
  inspectProcess,
  removePidRecord,
  stopRecord,
  writePidRecord,
  PROCESS_MARKER_ENV,
} from './pid.mjs';
import { checkMigrationsCurrent, checkStack } from './stack.mjs';

export const BUILD_OUTPUTS = {
  api: join(repoRoot, 'services/api/dist/main.js'),
  web: join(repoRoot, 'apps/web/dist/index.html'),
};

export const BUILD_STAMP_PATH = join(repoRoot, '.local', 'build.stamp.json');

function newestMtime(path) {
  let newest = 0;
  const info = statSync(path, { throwIfNoEntry: false });
  if (info === undefined) return newest;
  if (info.isFile()) return info.mtimeMs;
  for (const entry of readdirSync(path)) {
    newest = Math.max(newest, newestMtime(join(path, entry)));
  }
  return newest;
}

function packageDirs() {
  return readdirSync(join(repoRoot, 'packages'))
    .map((entry) => join(repoRoot, 'packages', entry))
    .filter((path) => statSync(path, { throwIfNoEntry: false })?.isDirectory() === true);
}

export function apiSources() {
  const sources = [
    join(repoRoot, 'services/api/src'),
    join(repoRoot, 'services/api/tsconfig.build.json'),
    join(repoRoot, 'services/api/package.json'),
    join(repoRoot, 'tsconfig.base.json'),
  ];
  for (const dir of packageDirs()) {
    sources.push(join(dir, 'src'), join(dir, 'package.json'));
  }
  return sources;
}

export function webSources() {
  const sources = [
    join(repoRoot, 'apps/web/src'),
    join(repoRoot, 'apps/web/public'),
    join(repoRoot, 'apps/web/index.html'),
    join(repoRoot, 'apps/web/vite.config.ts'),
    join(repoRoot, 'apps/web/package.json'),
    join(repoRoot, 'tsconfig.base.json'),
    // Bundled from source by Vite, so changes must rebuild the web output.
    join(repoRoot, 'packages/ui-policy/src'),
    join(repoRoot, 'packages/ui-policy/package.json'),
  ];
  return sources;
}

export function readBuildStamp(path = BUILD_STAMP_PATH) {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export async function writeBuildStamp(kind, path = BUILD_STAMP_PATH, now = Date.now()) {
  const current = readBuildStamp(path) ?? {};
  const next = { ...current, [kind]: now, updatedAt: new Date(now).toISOString() };
  await ensureDir(dirname(path), 0o700);
  await writeFile(path, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  await chmod(path, 0o600);
  return next;
}

export function buildMark(stamp = readBuildStamp()) {
  if (stamp === null) return null;
  return `${String(stamp.api ?? 0)}:${String(stamp.web ?? 0)}`;
}

export function needsBuild(kind, options = {}) {
  const output = options.output ?? BUILD_OUTPUTS[kind];
  const sources =
    options.sources ?? (kind === 'api' ? apiSources() : webSources());
  const stampPath = options.stampPath ?? BUILD_STAMP_PATH;
  const outputInfo = statSync(output, { throwIfNoEntry: false });
  if (outputInfo === undefined) return true;
  // A stamp is written only after the whole build succeeds, so an interrupted
  // build (API dist written, workspace deps missing) is still stale.
  const stamp = readBuildStamp(stampPath);
  const reference =
    stamp !== null && typeof stamp[kind] === 'number' ? stamp[kind] : options.legacyReference;
  if (reference === undefined) return true;
  if (newestMtimeOf(sources) > reference) return true;
  return false;
}

export function newestMtimeOf(sources) {
  return Math.max(...sources.map((path) => newestMtime(path)));
}

export function checkLlmKeyFile(path, fsApi = {}) {
  const access = fsApi.access ?? ((target) => accessSync(target, constants.F_OK));
  const stat = fsApi.stat ?? ((target) => statSync(target));
  try {
    access(path);
  } catch {
    return {
      ok: false,
      message:
        `LLM API 키 파일이 없습니다: ${path}. ` +
        'deepseek_api_key.txt (또는 LLM_API_KEY_FILE)을 0600 으로 준비하세요.',
    };
  }
  let mode;
  try {
    mode = stat(path).mode & 0o777;
  } catch {
    mode = null;
  }
  if (mode !== null && (mode & 0o077) !== 0) {
    return {
      ok: false,
      message:
        `LLM API 키 파일 권한이 ${mode.toString(8)} 입니다. group/world 접근을 막아야 합니다. ` +
        `정확한 명령: chmod 600 ${path}`,
    };
  }
  return { ok: true, warning: null };
}

export async function runPreflight(options = {}) {
  const context = options.context ?? createContext(options.env ?? process.env);
  const env = options.env ?? process.env;
  const fakeLlm = options.fakeLlm === true;
  const deps = options.deps ?? {};
  const checkStackFn = deps.checkStack ?? checkStack;
  const checkMigrationsFn = deps.checkMigrationsCurrent ?? checkMigrationsCurrent;
  const checkKeyFn = deps.checkLlmKeyFile ?? checkLlmKeyFile;

  const missing = [];
  if (!fileExists(context.postgresEnvPath) && !fileExists(context.legacyStackEnvPath)) {
    missing.push('postgres.env');
  }
  if (!fileExists(context.vikunjaEnvPath)) missing.push('vikunja.env');
  if (!fileExists(context.pushKeyFile)) missing.push('push.key');
  if (!fileExists(context.sessionSecretFile)) missing.push('llm-session-secret');
  if (!fileExists(context.tokenFile)) missing.push('vikunja-tokens.json');
  if (missing.length > 0) {
    return {
      ok: false,
      message:
        `로컬 비밀 파일이 없습니다: ${missing.join(', ')}. ` +
        '먼저 `corepack pnpm local:setup` 을 실행하세요.',
    };
  }

  let dbUrl;
  try {
    dbUrl = databaseUrl(context, env);
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }

  if (!fakeLlm) {
    const key = checkKeyFn(context.keyFile);
    if (!key.ok) return { ok: false, message: key.message };
  }

  const health = await checkStackFn(dbUrl, context.vikunjaUrl);
  if (!health.ok) {
    return {
      ok: false,
      message: `${STACK_DOWN_MESSAGE} (postgres=${health.database ? 'ok' : 'down'}, vikunja=${health.vikunja ? 'ok' : 'down'})`,
    };
  }

  const migrations = await checkMigrationsFn(dbUrl);
  if (!migrations.current) {
    return {
      ok: false,
      message:
        `마이그레이션이 최신이 아닙니다: ${migrations.detail}. ` +
        '먼저 `corepack pnpm local:setup` 을 실행하세요.',
    };
  }

  const warnings = [];
  if (!fakeLlm) {
    const key = checkKeyFn(context.keyFile);
    if (key.warning !== null && key.warning !== undefined) warnings.push(key.warning);
  }

  return { ok: true, databaseUrl: dbUrl, warnings };
}

async function rotateLogFile(logDir, name) {
  const path = join(logDir, `${name}.log`);
  if (!fileExists(path)) return path;
  const previous = `${path}.1`;
  rmSync(previous, { force: true });
  const { rename } = await import('node:fs/promises');
  await rename(path, previous);
  return path;
}

async function spawnDetached(name, command, args, env, logDir) {
  const logPath = await rotateLogFile(logDir, name);
  const fd = openSync(logPath, 'a', 0o600);
  await chmod(logPath, 0o600).catch(() => undefined);
  const child = spawn(command, args, {
    cwd: repoRoot,
    detached: true,
    env,
    stdio: ['ignore', fd, fd],
  });
  child.unref();
  closeSync(fd);
  if (child.pid === undefined) throw new Error(`${name} 프로세스를 시작하지 못했습니다.`);
  return child.pid;
}

function apiEnvironment(context, preflight, options) {
  const env = options.env ?? process.env;
  const settings = context.settings;
  const fakeLlm = options.fakeLlm === true;
  const provider = fakeLlm ? 'fake' : (env.LLM_PROVIDER ?? settings.LLM_PROVIDER);
  return {
    ...childProcessEnv(env),
    HOST: '127.0.0.1',
    PORT: String(context.ports.api),
    NODE_ENV: fakeLlm ? 'development' : (env.NODE_ENV ?? settings.NODE_ENV ?? 'production'),
    PROVIDER: 'vikunja',
    DATABASE_URL: preflight.databaseUrl,
    VIKUNJA_URL: context.vikunjaUrl,
    VIKUNJA_TOKEN_FILE: context.tokenFile,
    VIKUNJA_SECRETS_DIR: context.secretsDir,
    PUSH_KEY_FILE: context.pushKeyFile,
    LLM_SESSION_SECRET_FILE: context.sessionSecretFile,
    LLM_API_KEY_FILE: context.keyFile,
    LLM_PROVIDER: provider,
    LLM_BASE_URL: env.LLM_BASE_URL ?? settings.LLM_BASE_URL,
    LLM_MODEL: env.LLM_MODEL ?? settings.LLM_MODEL,
    LLM_REASONING_EFFORT: env.LLM_REASONING_EFFORT ?? settings.LLM_REASONING_EFFORT,
    LLM_DAILY_BUDGET_USD: env.LLM_DAILY_BUDGET_USD ?? settings.LLM_DAILY_BUDGET_USD,
    LLM_MONTHLY_BUDGET_USD: env.LLM_MONTHLY_BUDGET_USD ?? settings.LLM_MONTHLY_BUDGET_USD,
    LOG_LEVEL: env.LOG_LEVEL ?? 'info',
    [PROCESS_MARKER_ENV]: options.marker,
  };
}

function webEnvironment(context, marker) {
  return {
    ...childProcessEnv(),
    OHMYDATE_API_PROXY_TARGET: context.apiUrl,
    VITE_MOCK: '0',
    [PROCESS_MARKER_ENV]: marker,
  };
}

function lastLogLine(path) {
  try {
    const text = readFileSync(path, 'utf8').trimEnd();
    const lines = text.split(/\r?\n/u);
    return lines[lines.length - 1] ?? '(로그 없음)';
  } catch {
    return '(로그 없음)';
  }
}

async function waitForHttpOrExit(url, pid, logPath, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastError = 'no response';
  while (Date.now() < deadline) {
    if (pid !== null && !processAlive(pid)) {
      throw new Error(
        `프로세스가 응답 전에 종료되었습니다 (pid ${String(pid)}). 마지막 로그: ${lastLogLine(logPath)}`,
      );
    }
    try {
      const response = await globalThis.fetch(url);
      if (response.status === 200) return response;
      lastError = `HTTP ${String(response.status)}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await delay(200);
  }
  throw new Error(`${url} 응답을 기다리다 시간 초과했습니다 (${lastError})`);
}

async function cleanupStarted(context, names, timeoutMs = 5_000) {
  for (const name of names) {
    const inspection = await inspectProcess(context.runDir, name);
    if (inspection.status === 'running') {
      await stopRecord(inspection.record, timeoutMs);
    }
    await removePidRecord(context.runDir, name);
  }
}

async function main() {
  const { flags } = parseFlags(process.argv.slice(2));
  if (flags.has('help')) {
    console.log(
      'usage: node scripts/local/start.mjs [--rebuild] [--fake-llm]\n' +
        'env: OHMYDATE_LOCAL_API_PORT, OHMYDATE_LOCAL_WEB_PORT, ' +
        'OHMYDATE_LOCAL_DATABASE_URL, OHMYDATE_LOCAL_VIKUNJA_URL',
    );
    return;
  }
  const env = process.env;
  const context = createContext(env);
  const fakeLlm = flags.has('fake-llm');
  const forceRebuild = flags.has('rebuild');

  const preflight = await runPreflight({ context, env, fakeLlm });
  if (!preflight.ok) throw new Error(preflight.message);
  for (const warning of preflight.warnings) warn(warning);

  log(describeTarget(context, preflight.databaseUrl));
  log(
    `실행 모드: NODE_ENV=${fakeLlm ? 'development' : (env.NODE_ENV ?? context.settings.NODE_ENV ?? 'production')}, ` +
      `LLM_PROVIDER=${fakeLlm ? 'fake' : (env.LLM_PROVIDER ?? context.settings.LLM_PROVIDER)}`,
  );

  const apiState = await inspectProcess(context.runDir, 'api');
  const webState = await inspectProcess(context.runDir, 'web');
  for (const [name, state] of [
    ['api', apiState],
    ['web', webState],
  ]) {
    if (state.status !== 'running') await removePidRecord(context.runDir, name);
  }

  const apiStale = forceRebuild || needsBuild('api');
  const webStale = forceRebuild || needsBuild('web');
  if (apiState.status === 'running' && apiStale) {
    throw new Error(
      'API가 이미 실행 중인데 빌드가 필요합니다. `corepack pnpm local:stop` 후 다시 `local:start` 하세요.',
    );
  }
  if (webState.status === 'running' && webStale) {
    throw new Error(
      '웹이 이미 실행 중인데 빌드가 필요합니다. `corepack pnpm local:stop` 후 다시 `local:start` 하세요.',
    );
  }

  if (apiStale) {
    log('API 빌드 중...');
    runPnpm(['--filter', '@ohmydate/api', 'build']);
    await writeBuildStamp('api');
  }
  if (webStale) {
    log('웹 빌드 중...');
    runPnpm(['--filter', '@ohmydate/web', 'build']);
    await writeBuildStamp('web');
  }

  const stamp = readBuildStamp() ?? {};
  for (const [name, state] of [
    ['api', apiState],
    ['web', webState],
  ]) {
    const expected = stamp[name] ?? null;
    if (state.status === 'running' && (state.record?.buildStamp ?? null) !== expected) {
      throw new Error(
        `${name} 프로세스가 현재 빌드보다 오래되었습니다. ` +
          '`corepack pnpm local:stop` 후 다시 `local:start` 하세요.',
      );
    }
  }

  await ensureDir(context.runDir, 0o700);
  await ensureDir(context.logDir, 0o700);

  const started = [];
  let apiPid = apiState.status === 'running' ? apiState.record.pid : null;
  let webPid = webState.status === 'running' ? webState.record.pid : null;
  try {
    if (apiPid !== null) {
      log(`API가 이미 실행 중입니다 (pid ${String(apiPid)}).`);
    } else {
      const marker = createMarker();
      apiPid = await spawnDetached(
        'api',
        process.execPath,
        [join(repoRoot, 'services/api/dist/main.js')],
        apiEnvironment(context, preflight, { env, fakeLlm, marker }),
        context.logDir,
      );
      started.push('api');
      await writePidRecord(context.runDir, 'api', apiPid, marker, { buildStamp: stamp.api ?? null });
    }

    if (webPid !== null) {
      log(`웹이 이미 실행 중입니다 (pid ${String(webPid)}).`);
    } else {
      const invocation = pnpmInvocation([
        '--filter',
        '@ohmydate/web',
        'exec',
        'vite',
        'preview',
        '--host',
        '127.0.0.1',
        '--port',
        String(context.ports.web),
        '--strictPort',
      ]);
      const marker = createMarker();
      webPid = await spawnDetached(
        'web',
        invocation.command,
        invocation.args,
        webEnvironment(context, marker),
        context.logDir,
      );
      started.push('web');
      await writePidRecord(context.runDir, 'web', webPid, marker, { buildStamp: stamp.web ?? null });
    }

    try {
      await waitForHttpOrExit(
        `${context.apiUrl}/healthz`,
        apiPid,
        join(context.logDir, 'api.log'),
        60_000,
      );
      await waitForHttpOrExit(
        `${context.webUrl}/`,
        webPid,
        join(context.logDir, 'web.log'),
        60_000,
      );
    } catch (error) {
      await cleanupStarted(context, started);
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        `${message} 로그: ${context.logDir}/api.log, ${context.logDir}/web.log`,
        { cause: error },
      );
    }
  } catch (error) {
    await cleanupStarted(context, started);
    throw error;
  }

  log(`OhMyDate 로컬 실행 준비 완료: ${context.webUrl}/`);
  log(`API: ${context.apiUrl} (로그: ${context.logDir}/api.log)`);
  log(`웹: ${context.webUrl}/ (로그: ${context.logDir}/web.log)`);
}

if (isEntryPoint(import.meta.url)) {
  await main().catch((error) => {
    fail(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
