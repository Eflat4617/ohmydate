#!/usr/bin/env node
// Shared helpers for the GU-1 local run package. No secret value is ever
// printed here: callers print paths/names only.
import { spawnSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL, URL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

export const LOCAL_ENV_DEFAULTS = {
  POSTGRES_PORT: '55442',
  VIKUNJA_PORT: '3466',
  API_PORT: '3100',
  WEB_PORT: '5180',
  HOST: '127.0.0.1',
  NODE_ENV: 'production',
  LLM_PROVIDER: 'deepseek',
  LLM_BASE_URL: 'https://opencode.ai/inference/go/openai/v1',
  LLM_MODEL: 'deepseek-v4.1-flash',
  LLM_REASONING_EFFORT: 'medium',
  LLM_API_KEY_FILE: 'deepseek_api_key.txt',
  LLM_DAILY_BUDGET_USD: '0.2',
  LLM_MONTHLY_BUDGET_USD: '5',
};

export function parseEnvText(text) {
  const result = {};
  for (const rawLine of text.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith('#')) continue;
    const separator = line.indexOf('=');
    if (separator < 0) continue;
    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key.length > 0) result[key] = value;
  }
  return result;
}

export function readEnvFile(path) {
  try {
    return parseEnvText(readFileSync(path, 'utf8'));
  } catch {
    return {};
  }
}

export function localEnvPath(env = process.env) {
  return resolve(repoRoot, env.OHMYDATE_LOCAL_ENV_FILE ?? 'deploy/local/local.env');
}

export function localSettings(env = process.env) {
  return { ...LOCAL_ENV_DEFAULTS, ...readEnvFile(localEnvPath(env)) };
}

export function resolveFromRepo(value) {
  return isAbsolute(value) ? value : resolve(repoRoot, value);
}

export function createContext(env = process.env) {
  const settings = localSettings(env);
  const secretsDir = resolveFromRepo(env.OHMYDATE_LOCAL_SECRETS_DIR ?? 'deploy/secrets/local');
  const runDir = resolveFromRepo(env.OHMYDATE_LOCAL_RUN_DIR ?? '.local/run');
  const logDir = resolveFromRepo(env.OHMYDATE_LOCAL_LOG_DIR ?? '.local/logs');
  const ports = {
    postgres: Number.parseInt(
      env.OHMYDATE_LOCAL_POSTGRES_PORT ?? settings.POSTGRES_PORT ?? LOCAL_ENV_DEFAULTS.POSTGRES_PORT,
      10,
    ),
    vikunja: Number.parseInt(
      env.OHMYDATE_LOCAL_VIKUNJA_PORT ?? settings.VIKUNJA_PORT ?? LOCAL_ENV_DEFAULTS.VIKUNJA_PORT,
      10,
    ),
    api: Number.parseInt(
      env.OHMYDATE_LOCAL_API_PORT ?? settings.API_PORT ?? LOCAL_ENV_DEFAULTS.API_PORT,
      10,
    ),
    web: Number.parseInt(
      env.OHMYDATE_LOCAL_WEB_PORT ?? settings.WEB_PORT ?? LOCAL_ENV_DEFAULTS.WEB_PORT,
      10,
    ),
  };
  const vikunjaUrl = env.VIKUNJA_URL ?? `http://127.0.0.1:${String(ports.vikunja)}`;
  const apiUrl = `http://127.0.0.1:${String(ports.api)}`;
  const webUrl = `http://127.0.0.1:${String(ports.web)}`;
  const stackEnvPath = join(secretsDir, 'stack.env');
  const pushKeyFile = join(secretsDir, 'push.key');
  const sessionSecretFile = join(secretsDir, 'llm-session-secret');
  const tokenFile = join(secretsDir, 'vikunja-tokens.json');
  const tokenMetaFile = join(secretsDir, 'vikunja-tokens.meta.json');
  const keyFile = resolveFromRepo(
    env.LLM_API_KEY_FILE ?? settings.LLM_API_KEY_FILE ?? LOCAL_ENV_DEFAULTS.LLM_API_KEY_FILE,
  );
  return {
    settings,
    secretsDir,
    runDir,
    logDir,
    ports,
    vikunjaUrl,
    apiUrl,
    webUrl,
    stackEnvPath,
    pushKeyFile,
    sessionSecretFile,
    tokenFile,
    tokenMetaFile,
    keyFile,
  };
}

export function readStackEnv(context) {
  return readEnvFile(context.stackEnvPath);
}

export function databaseUrl(context, env = process.env) {
  if (env.DATABASE_URL !== undefined && env.DATABASE_URL.length > 0) return env.DATABASE_URL;
  const stack = readStackEnv(context);
  const password = stack.POSTGRES_PASSWORD;
  if (password === undefined || password.length === 0) {
    throw new Error(
      'deploy/secrets/local/stack.env 에 POSTGRES_PASSWORD 가 없습니다. ' +
        '먼저 `corepack pnpm local:setup` 을 실행해 비밀 파일을 만드세요.',
    );
  }
  const url = new URL(`postgres://ohmydate@127.0.0.1:${String(context.ports.postgres)}/planner`);
  url.password = password;
  return url.toString();
}

export const STACK_DOWN_MESSAGE =
  '먼저 coordinator가 deploy/local 스택을 올려야 합니다. ' +
  `정확한 명령: cd ${repoRoot} && docker compose --env-file deploy/local/local.env -f deploy/local/compose.yaml up -d`;

export function composeCommand() {
  return `cd ${repoRoot} && docker compose --env-file deploy/local/local.env -f deploy/local/compose.yaml up -d`;
}

export function parseFlags(argv) {
  const flags = new Set();
  const values = new Map();
  const positionals = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === undefined) continue;
    if (arg.startsWith('--')) {
      const separator = arg.indexOf('=');
      if (separator > 2) {
        values.set(arg.slice(2, separator), arg.slice(separator + 1));
      } else {
        const name = arg.slice(2);
        const next = argv[index + 1];
        if (next !== undefined && !next.startsWith('--')) {
          values.set(name, next);
          index += 1;
        } else {
          flags.add(name);
        }
      }
    } else {
      positionals.push(arg);
    }
  }
  return { flags, values, positionals };
}

export function isEntryPoint(importMetaUrl, entry = process.argv[1]) {
  if (entry === undefined) return false;
  return importMetaUrl === pathToFileURL(entry).href;
}

export function pnpmInvocation(args) {
  const execPath = process.env.npm_execpath;
  if (execPath === undefined || execPath.length === 0) {
    return { command: 'pnpm', args };
  }
  if (/\.(c|m)?js$/u.test(execPath)) {
    return { command: process.execPath, args: [execPath, ...args] };
  }
  return { command: execPath, args };
}

export function runPnpm(args, options = {}) {
  const invocation = pnpmInvocation(args);
  const result = spawnSync(invocation.command, invocation.args, {
    cwd: options.cwd ?? repoRoot,
    stdio: options.stdio ?? 'inherit',
    env: options.env ?? process.env,
    maxBuffer: 20 * 1024 * 1024,
  });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) {
    throw new Error(`pnpm ${args.join(' ')} exited ${String(result.status)}`);
  }
  return result;
}

export async function ensureDir(path, mode = 0o755) {
  await mkdir(path, { recursive: true, mode });
}

export async function writeFileExclusive(path, content, mode = 0o600) {
  await writeFile(path, content, { flag: 'wx', mode });
}

export function fileExists(path) {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

export function fileMode(path) {
  try {
    return statSync(path).mode & 0o777;
  } catch {
    return null;
  }
}

export function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function waitForHttp(url, options = {}) {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const deadline = Date.now() + timeoutMs;
  let lastError = 'no response';
  while (Date.now() < deadline) {
    try {
      const response = await globalThis.fetch(url);
      if (response.status === (options.status ?? 200)) return response;
      lastError = `HTTP ${String(response.status)}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await delay(200);
  }
  throw new Error(`${url} 응답을 기다리다 시간 초과했습니다 (${lastError})`);
}

export function requirePg() {
  const require = createRequire(join(repoRoot, 'services/api/package.json'));
  return require('pg');
}

export function tailLines(text, count = 20) {
  const lines = text.trimEnd().split(/\r?\n/u);
  return lines.slice(Math.max(0, lines.length - count)).join('\n');
}

export function log(message) {
  console.log(`[local] ${message}`);
}

export function warn(message) {
  console.warn(`[local] ${message}`);
}

export function fail(message) {
  console.error(`[local] ${message}`);
}
