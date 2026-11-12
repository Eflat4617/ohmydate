#!/usr/bin/env node
// Hidden-input prompts for the local setup. The password is never echoed or logged.
import { createInterface } from 'node:readline/promises';

export const MIN_PASSWORD_LENGTH = 8;

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;

export function validateEmail(email) {
  return EMAIL_PATTERN.test(email);
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

export async function collectCredentials(env = process.env, values = new Map()) {
  let email = values.get('email') ?? env.OHMYDATE_LOCAL_EMAIL;
  let password = env.OHMYDATE_LOCAL_PASSWORD;

  if ((email === undefined) !== (password === undefined)) {
    throw new Error(
      '비대화형 실행에는 OHMYDATE_LOCAL_EMAIL 과 OHMYDATE_LOCAL_PASSWORD 를 함께 설정해야 합니다.',
    );
  }

  if (email === undefined || password === undefined) {
    if (!process.stdin.isTTY) {
      throw new Error(
        '대화형 터미널이 아닙니다. OHMYDATE_LOCAL_EMAIL 과 OHMYDATE_LOCAL_PASSWORD 를 설정하세요.',
      );
    }
    if (email === undefined) {
      email = await promptLine('이메일: ');
    }
    if (!validateEmail(email)) {
      throw new Error('이메일 형식이 올바르지 않습니다.');
    }
    password = await promptHidden('비밀번호: ');
    const confirmation = await promptHidden('비밀번호 확인: ');
    if (password !== confirmation) {
      throw new Error('비밀번호가 서로 일치하지 않습니다.');
    }
  }

  if (!validateEmail(email)) throw new Error('이메일 형식이 올바르지 않습니다.');
  if (password.length < MIN_PASSWORD_LENGTH) {
    throw new Error(`비밀번호는 ${String(MIN_PASSWORD_LENGTH)}자 이상이어야 합니다.`);
  }
  return { email: email.trim().toLowerCase(), password };
}
