#!/usr/bin/env node
// Korean status summary. Never prints the token, password or LLM key contents.
import { readFileSync } from 'node:fs';
import {
  createContext,
  databaseUrl,
  describeTarget,
  fail,
  fileExists,
  fileMode,
  isEntryPoint,
  log,
  parseFlags,
  warn,
} from './common.mjs';
import { checkMigrationsCurrent, checkStack } from './stack.mjs';
import { readJsonObject, tokenMapOf } from './vikunja-token.mjs';

async function httpStatus(url, options = {}) {
  try {
    const response = await globalThis.fetch(url, {
      signal: globalThis.AbortSignal.timeout(options.timeoutMs ?? 3_000),
      ...(options.token === undefined
        ? {}
        : { headers: { authorization: `Bearer ${options.token}` } }),
    });
    return response.status;
  } catch {
    return null;
  }
}

function readTokens(path) {
  if (!fileExists(path)) return { tokens: {}, malformed: false };
  try {
    return { tokens: tokenMapOf(readJsonObject(readFileSync(path, 'utf8'))), malformed: false };
  } catch {
    // Never echo JSON.parse's text: V8 quotes a fragment of the file.
    return { tokens: {}, malformed: true };
  }
}

function readMetadata(path) {
  try {
    const parsed = readJsonObject(readFileSync(path, 'utf8'));
    return parsed ?? {};
  } catch {
    return {};
  }
}

function expiryText(expiresAt) {
  if (typeof expiresAt !== 'string' || expiresAt.length === 0) return '만료일 알 수 없음';
  const remainingMs = Date.parse(expiresAt) - Date.now();
  if (!Number.isFinite(remainingMs)) return '만료일 알 수 없음';
  if (remainingMs <= 0) return '만료됨';
  const days = Math.ceil(remainingMs / (24 * 60 * 60 * 1000));
  return `만료까지 ${String(days)}일 (${expiresAt.slice(0, 10)})`;
}

async function main() {
  const { flags } = parseFlags(process.argv.slice(2));
  if (flags.has('help')) {
    console.log('usage: node scripts/local/status.mjs');
    return;
  }
  const env = process.env;
  const context = createContext(env);
  const failures = [];

  log('로컬 상태 요약');

  let dbUrl = null;
  try {
    dbUrl = databaseUrl(context, env);
  } catch (error) {
    failures.push('database');
    log(` - 스택: 설정 오류 (${error instanceof Error ? error.message : String(error)})`);
  }

  if (dbUrl !== null) {
    log(` ${describeTarget(context, dbUrl)}`);
    const stack = await checkStack(dbUrl, context.vikunjaUrl);
    if (stack.ok) {
      log(' - 스택: 정상 (PostgreSQL, Vikunja)');
    } else {
      failures.push('stack');
      log(
        ` - 스택: 실패 (PostgreSQL ${stack.database ? '정상' : '연결 안 됨'}, Vikunja ${stack.vikunja ? '정상' : '연결 안 됨'})`,
      );
    }

    try {
      const migrations = await checkMigrationsCurrent(dbUrl);
      if (migrations.current) {
        log(' - 마이그레이션: 최신');
      } else {
        failures.push('migrations');
        log(` - 마이그레이션: 최신 아님 (${migrations.detail})`);
      }
    } catch (error) {
      failures.push('migrations');
      log(` - 마이그레이션: 확인 실패 (${error instanceof Error ? error.message : String(error)})`);
    }
  }

  const secretFiles = [
    context.postgresEnvPath,
    context.vikunjaEnvPath,
    context.pushKeyFile,
    context.sessionSecretFile,
    context.tokenFile,
  ];
  const missingSecrets = secretFiles
    .filter((path) => !fileExists(path))
    .map((path) => path.slice(context.secretsDir.length + 1));
  if (missingSecrets.length === 0) {
    log(` - 비밀 파일: 정상 (${context.secretsDir})`);
  } else {
    failures.push('secrets');
    log(` - 비밀 파일: 누락 (${missingSecrets.join(', ')})`);
    if (fileExists(context.stackStateFile)) {
      warn(
        '비밀 디렉터리가 없지만 ohmydate-local 스택/볼륨이 존재합니다. ' +
          '비밀 디렉터리와 볼륨은 한 쌍이므로 함께 백업해야 하며, ' +
          '지금은 DB에 다시 접속할 수 없습니다.',
      );
    }
  }

  if (fileExists(context.keyFile)) {
    const mode = fileMode(context.keyFile);
    const modeText = mode === null ? '권한 확인 불가' : `mode ${mode.toString(8)}`;
    if (mode !== null && (mode & 0o077) !== 0) {
      log(` - LLM 키 파일: 있음 (${modeText}, chmod 600 권장)`);
    } else {
      log(` - LLM 키 파일: 있음 (${modeText})`);
    }
  } else {
    failures.push('llm-key');
    log(` - LLM 키 파일: 없음 (${context.keyFile})`);
  }

  const tokenData = readTokens(context.tokenFile);
  const owners = Object.keys(tokenData.tokens);
  if (tokenData.malformed) {
    failures.push('token');
    log(' - Vikunja 토큰: 파일을 읽지 못했습니다 (형식 오류). 파일을 지우고 local:setup 을 다시 실행하세요.');
  } else if (owners.length === 0) {
    failures.push('token');
    log(' - Vikunja 토큰: 없음');
  } else {
    const ownerId = owners[0];
    const token = tokenData.tokens[ownerId];
    const metadata = readMetadata(context.tokenMetaFile);
    const expiresAt = metadata[ownerId]?.expiresAt;
    const status = await httpStatus(`${context.vikunjaUrl.replace(/\/+$/u, '')}/api/v2/user`, {
      token,
    });
    if (status === 200) {
      log(` - Vikunja 토큰: 유효 (${expiryText(expiresAt)})`);
    } else {
      failures.push('token');
      log(` - Vikunja 토큰: 무효 (HTTP ${status === null ? '연결 실패' : String(status)})`);
    }
  }

  const apiStatus = await httpStatus(`${context.apiUrl}/healthz`);
  if (apiStatus === 200) {
    log(` - API: 정상 (${context.apiUrl})`);
  } else {
    failures.push('api');
    log(` - API: 중지됨 (${context.apiUrl})`);
  }

  const webStatus = await httpStatus(`${context.webUrl}/`);
  if (webStatus === 200) {
    log(` - 웹: 정상 (${context.webUrl}/)`);
  } else {
    failures.push('web');
    log(` - 웹: 중지됨 (${context.webUrl}/)`);
  }

  if (failures.length > 0) {
    log(`확인이 필요한 항목: ${failures.join(', ')}`);
    process.exitCode = 1;
  } else {
    log('모든 항목이 정상입니다.');
  }
}

if (isEntryPoint(import.meta.url)) {
  await main().catch((error) => {
    fail(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
