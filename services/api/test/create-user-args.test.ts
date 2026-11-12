import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { isCreateUserEntrypoint, parseCreateUserArgs } from '../src/cli/create-user.js';

const exitCodeAfterImport = process.exitCode;

describe('create-user argument parsing', () => {
  test('keeps the existing email-only behaviour', () => {
    expect(parseCreateUserArgs(['a@example.com'])).toEqual({ email: 'a@example.com' });
  });

  test('accepts optional --time-zone and --locale in both forms', () => {
    expect(
      parseCreateUserArgs(['a@example.com', '--time-zone', 'Asia/Seoul', '--locale', 'ko-KR']),
    ).toEqual({ email: 'a@example.com', timeZone: 'Asia/Seoul', locale: 'ko-KR' });
    expect(
      parseCreateUserArgs(['--time-zone=UTC', '--locale=en', 'a@example.com']),
    ).toEqual({ email: 'a@example.com', timeZone: 'UTC', locale: 'en' });
  });

  test('rejects an invalid IANA time zone and an invalid locale', () => {
    expect(() => parseCreateUserArgs(['a@example.com', '--time-zone', 'Mars/Olympus'])).toThrow(
      /invalid IANA time zone/u,
    );
    expect(() => parseCreateUserArgs(['a@example.com', '--locale', 'not a locale'])).toThrow(
      /invalid locale/u,
    );
  });

  test('rejects missing values and unknown options', () => {
    expect(() => parseCreateUserArgs(['a@example.com', '--time-zone'])).toThrow(
      /requires a value/u,
    );
    expect(() => parseCreateUserArgs(['a@example.com', '--nope'])).toThrow(/unknown option/u);
    expect(() => parseCreateUserArgs([])).toThrow(/usage/u);
  });

  test('importing the CLI module never executes main()', () => {
    expect(exitCodeAfterImport).not.toBe(1);
    expect(isCreateUserEntrypoint(fileURLToPath(import.meta.url))).toBe(false);
    expect(
      isCreateUserEntrypoint(fileURLToPath(new URL('../src/cli/create-user.ts', import.meta.url))),
    ).toBe(true);
  });
});
