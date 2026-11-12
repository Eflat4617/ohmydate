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
  renameSync,
  rmSync,
  statSync,
} from 'node:fs';
import { chmod, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  createContext,
  databaseUrl,
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
  waitForHttp,
  warn,
} from './common.mjs';
import { checkMigrationsCurrent, checkStack } from './stack.mjs';

export const BUILD_OUTPUTS = {
  api: join(repoRoot, 'services/api/dist/main.js'),
  web: join(repoRoot, 'apps/web/dist/index.html'),
};

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

function apiSources() {
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

function webSources() {
  return [
    join(repoRoot, 'apps/web/src'),
    join(repoRoot, 'apps/web/index.html'),
    join(repoRoot, 'apps/web/vite.config.ts'),
    join(repoRoot, 'apps/web/package.json'),
    join(repoRoot, 'tsconfig.base.json'),
  ];
}

export function needsBuild(kind) {
  const output = BUILD_OUTPUTS[kind];
  const outputInfo = statSync(output, { throwIfNoEntry: false });
  if (outputInfo === undefined) return true;
  const sources = kind === 'api' ? apiSources() : webSources();
  const newest = Math.max(...sources.map((path) => newestMtime(path)));
  return newest > outputInfo.mtimeMs;
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
      ok: true,
      warning: `LLM API 키 파일 권한이 ${mode.toString(8)} 입니다. chmod 600 ${path} 를 권장합니다.`,
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
  if (!fileExists(context.stackEnvPath)) missing.push('stack.env');
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
    if (!key.ok) return { ok: false, message: key.message };
    if (key.warning !== null) warnings.push(key.warning);
  }

  return { ok: true, databaseUrl: dbUrl, warnings };
}

function childEnv() {
  const env = { ...process.env };
  delete env.OHMYDATE_LOCAL_EMAIL;
  delete env.OHMYDATE_LOCAL_PASSWORD;
  return env;
}

function readPid(runDir, name) {
  try {
    const raw = readFileSync(join(runDir, `${name}.pid`), 'utf8').trim();
    const pid = Number.parseInt(raw, 10);
    return Number.isInteger(pid) ? pid : null;
  } catch {
    return null;
  }
}

async function writePid(runDir, name, pid) {
  await writeFile(join(runDir, `${name}.pid`), `${String(pid)}\n`, { mode: 0o600 });
  await chmod(join(runDir, `${name}.pid`), 0o600);
}

function rotateLog(logDir, name) {
  const path = join(logDir, `${name}.log`);
  if (!fileExists(path)) return path;
  const previous = `${path}.1`;
  rmSync(previous, { force: true });
  renameSync(path, previous);
  return path;
}

function spawnDetached(name, command, args, env, logDir) {
  const logPath = rotateLog(logDir, name);
  const fd = openSync(logPath, 'a');
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
    ...childEnv(),
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
  };
}

async function main() {
  const { flags } = parseFlags(process.argv.slice(2));
  if (flags.has('help')) {
    console.log(
      'usage: node scripts/local/start.mjs [--rebuild] [--fake-llm]\n' +
        'env: OHMYDATE_LOCAL_API_PORT, OHMYDATE_LOCAL_WEB_PORT, DATABASE_URL, VIKUNJA_URL',
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

  if (forceRebuild || needsBuild('api')) {
    log('API 빌드 중...');
    runPnpm(['--filter', '@ohmydate/api', 'build']);
  }
  if (forceRebuild || needsBuild('web')) {
    log('웹 빌드 중...');
    runPnpm(['--filter', '@ohmydate/web', 'build']);
  }

  await ensureDir(context.runDir, 0o700);
  await ensureDir(context.logDir, 0o700);

  let apiPid = readPid(context.runDir, 'api');
  if (apiPid !== null && processAlive(apiPid)) {
    log(`API가 이미 실행 중입니다 (pid ${String(apiPid)}).`);
  } else {
    apiPid = spawnDetached(
      'api',
      process.execPath,
      [join(repoRoot, 'services/api/dist/main.js')],
      apiEnvironment(context, preflight, { env, fakeLlm }),
      context.logDir,
    );
    await writePid(context.runDir, 'api', apiPid);
  }

  let webPid = readPid(context.runDir, 'web');
  if (webPid !== null && processAlive(webPid)) {
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
    webPid = spawnDetached(
      'web',
      invocation.command,
      invocation.args,
      {
        ...childEnv(),
        OHMYDATE_API_PROXY_TARGET: context.apiUrl,
        VITE_MOCK: '0',
      },
      context.logDir,
    );
    await writePid(context.runDir, 'web', webPid);
  }

  try {
    await waitForHttp(`${context.apiUrl}/healthz`, { timeoutMs: 60_000 });
    await waitForHttp(`${context.webUrl}/`, { timeoutMs: 60_000 });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `${message} 로그: ${context.logDir}/api.log, ${context.logDir}/web.log`,
      { cause: error },
    );
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
