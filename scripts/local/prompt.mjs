#!/usr/bin/env node
// Hidden-input prompts for the local setup. The password is never echoed or logged.
import { createInterface } from 'node:readline/promises';

export const MIN_PASSWORD_LENGTH = 8;

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;

export function validateEmail(email) {
  return EMAIL_PATTERN.test(email);
}

export function isInteractive() {
  return process.stdin.isTTY === true && process.stdout.isTTY === true;
}

export function isValidTimeZone(value) {
  if (typeof value !== 'string' || value.length === 0) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

const LOCALE_PATTERN = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/u;

export function isValidLocale(value) {
  return (
    typeof value === 'string' &&
    value.length >= 2 &&
    value.length <= 35 &&
    LOCALE_PATTERN.test(value)
  );
}

/**
 * Coordinator C2: default the new planner user to the machine's IANA time
 * zone. In an interactive run the Korean prompt shows that default and lets
 * the user change it.
 */
export async function resolveTimeZone(env = process.env, values = new Map(), options = {}) {
  const system =
    options.systemTimeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'UTC';
  const fallback = isValidTimeZone(system) ? system : 'UTC';
  let value = values.get('time-zone') ?? env.OHMYDATE_LOCAL_TIME_ZONE ?? fallback;
  if (!isValidTimeZone(value)) {
    throw new Error(`시간대가 올바른 IANA 식별자가 아닙니다: ${value}`);
  }
  const interactive = options.interactive ?? isInteractive();
  if (interactive) {
    const answer = (await promptLine(`시간대 [${value}]: `)).trim();
    if (answer.length > 0) value = answer;
  }
  if (!isValidTimeZone(value)) {
    throw new Error(`시간대가 올바른 IANA 식별자가 아닙니다: ${value}`);
  }
  return value;
}

export function resolveLocale(env = process.env, values = new Map()) {
  const value = values.get('locale') ?? env.OHMYDATE_LOCAL_LOCALE ?? 'ko-KR';
  if (!isValidLocale(value)) {
    throw new Error(`locale 형식이 올바르지 않습니다: ${value}`);
  }
  return value;
}

export async function promptLine(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}

export async function promptHidden(question) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error(
      '비밀번호는 대화형 터미널에서 입력해야 합니다. ' +
        '테스트/자동화는 OHMYDATE_LOCAL_EMAIL 과 OHMYDATE_LOCAL_PASSWORD 를 설정하세요.',
    );
  }
  process.stdout.write(question);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding('utf8');
  let value = '';
  let escape = false;
  return await new Promise((resolve, reject) => {
    const cleanup = () => {
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdin.removeListener('data', onData);
    };
    const onData = (chunk) => {
      for (const char of chunk) {
        if (escape) {
          escape = false;
          continue;
        }
        if (char === '\u001b') {
          escape = true;
          continue;
        }
        if (char === '\r' || char === '\n') {
          cleanup();
          process.stdout.write('\n');
          resolve(value);
          return;
        }
        if (char === '\u0003') {
          cleanup();
          process.stdout.write('\n');
          reject(new Error('입력이 취소되었습니다.'));
          return;
        }
        if (char === '\u007f' || char === '\b') {
          value = value.slice(0, -1);
          continue;
        }
        if (char >= ' ') value += char;
      }
    };
    process.stdin.on('data', onData);
  });
}

export async function collectCredentials(env = process.env, values = new Map(), options = {}) {
  let email = values.get('email') ?? env.OHMYDATE_LOCAL_EMAIL;
  let password = env.OHMYDATE_LOCAL_PASSWORD;
  const interactive = options.interactive ?? isInteractive();

  if (!interactive) {
    if (email === undefined || password === undefined) {
      throw new Error(
        '비대화형 실행에는 OHMYDATE_LOCAL_EMAIL 과 OHMYDATE_LOCAL_PASSWORD 를 함께 설정해야 합니다.',
      );
    }
  } else {
    if (email === undefined) {
      email = await promptLine('이메일: ');
    }
    if (!validateEmail(email)) {
      throw new Error('이메일 형식이 올바르지 않습니다.');
    }
    // `--email` is usable interactively: only the missing password is asked.
    if (password === undefined) {
      password = await promptHidden('비밀번호: ');
      const confirmation = await promptHidden('비밀번호 확인: ');
      if (password !== confirmation) {
        throw new Error('비밀번호가 서로 일치하지 않습니다.');
      }
    }
  }

  if (!validateEmail(email)) throw new Error('이메일 형식이 올바르지 않습니다.');
  if (password.length < MIN_PASSWORD_LENGTH) {
    throw new Error(`비밀번호는 ${String(MIN_PASSWORD_LENGTH)}자 이상이어야 합니다.`);
  }
  return { email: email.trim().toLowerCase(), password };
}
