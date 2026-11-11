// @vitest-environment node
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';

/**
 * FU-77 — self-test of the owner-isolation lint rules (ADR-023 guardrail).
 * The real apps/web/eslint.config.js is applied to fixture sources as if they
 * were files in src/: direct browser storage and an unfenced runOwnerBound
 * task must fail, the storage module itself and the correct forms must pass.
 */
const webRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const fixture = (name: string): string => readFileSync(join(webRoot, 'test/fixtures/owner-isolation', name), 'utf8');

const eslint = new ESLint({ cwd: webRoot, overrideConfigFile: join(webRoot, 'eslint.config.js') });

async function lintAs(path: string, source: string) {
  const [result] = await eslint.lintText(source, { filePath: join(webRoot, path) });
  if (result === undefined) throw new Error(`${path} was not linted`);
  return result.messages.map((message) => ({ rule: message.ruleId, id: message.messageId, line: message.line, text: message.message }));
}

const STORAGE_RULES = ['no-restricted-globals', 'owner-isolation/no-raw-storage'];

describe('lint: browser storage only through session/ownerStorage.ts', () => {
  it('a view that uses localStorage / sessionStorage directly fails (negative)', async () => {
    const messages = await lintAs('src/views/RawStorageView.vue', fixture('RawStorageView.vue'));
    expect(messages.every((message) => STORAGE_RULES.includes(message.rule ?? ''))).toBe(true);
    // Reported on the lines of the .vue file itself: `localStorage.getItem` and `window.sessionStorage`.
    expect(messages.map((message) => message.line)).toEqual([6, 9]);
    expect(messages[0]?.text).toContain('src/session/ownerStorage.ts');
  }, 30_000);

  it('every way of reaching storage is caught: bare global, window/globalThis/self, brackets, destructuring (negative)', async () => {
    const messages = await lintAs('src/layout/rawStorage.ts', fixture('rawStorage.ts'));
    expect(messages.every((message) => STORAGE_RULES.includes(message.rule ?? ''))).toBe(true);
    expect([...new Set(messages.map((message) => message.line))]).toEqual([5, 7, 8, 9, 10, 11, 12]);
  }, 30_000);

  it('the storage module itself passes, and a test may read raw storage to check it', async () => {
    const [module] = await eslint.lintFiles([join(webRoot, 'src/session/ownerStorage.ts')]);
    expect(module?.messages).toEqual([]);
    expect(await lintAs('test/some-check.spec.ts', fixture('rawStorage.ts'))).toEqual([]);
  }, 30_000);

  it('the files that used to touch storage now pass', async () => {
    const migrated = [
      'src/session/owner.ts',
      'src/session/quarantine.ts',
      'src/session/clientId.ts',
      'src/session/journal.ts',
      'src/stores/session.ts',
      'src/composables/useAiWait.ts',
      'src/layout/localSignals.ts',
      'src/layout/prefs.ts',
    ];
    const results = await eslint.lintFiles(migrated.map((path) => join(webRoot, path)));
    expect(results).toHaveLength(migrated.length);
    expect(results.flatMap((result) => result.messages)).toEqual([]);
  }, 30_000);
});

describe('lint: storage through an alias of the browser global (FU-77R-1 H2)', () => {
  /** Lines of a fixture that carry a `// <n>` marker: each must be reported. */
  function numberedLines(source: string): number[] {
    return source
      .split('\n')
      .map((line, index) => (/\/\/ \d+( |$)/.test(line) ? index + 1 : 0))
      .filter((line) => line > 0);
  }

  it('TypeScript: alias, destructuring, window.window, self chains, defaultView, computed and reflective keys all fail (negative)', async () => {
    const source = fixture('aliasedStorage.ts');
    const messages = await lintAs('src/session/aliasedStorage.ts', source);
    const reported = new Set(messages.map((message) => message.line));
    expect(numberedLines(source)).toHaveLength(14);
    expect(numberedLines(source).filter((line) => !reported.has(line))).toEqual([]);
    expect(messages.every((message) => message.text.includes('src/session/ownerStorage.ts'))).toBe(true);
  }, 30_000);

  it('Vue script setup: the same aliases fail, on the lines of the .vue file (negative)', async () => {
    const source = fixture('AliasedStorageView.vue');
    const messages = await lintAs('src/views/AliasedStorageView.vue', source);
    const reported = new Set(messages.map((message) => message.line));
    expect(numberedLines(source)).toHaveLength(7);
    expect(numberedLines(source).filter((line) => !reported.has(line))).toEqual([]);
  }, 30_000);

  it('the reviewer’s three probes fail in both file kinds (negative)', async () => {
    const probes = [
      'const browser = window; browser.localStorage.setItem("unscoped", "A-private");',
      'const browser = globalThis; const { sessionStorage: store } = browser; store.setItem("x", "private");',
      'window.window.localStorage.setItem("unscoped", "A-private");',
    ];
    for (const probe of probes) {
      expect((await lintAs('src/session/review-probe.ts', `${probe}\nexport {};\n`)).length, probe).toBeGreaterThan(0);
      const vue = `<script setup lang="ts">\n${probe}\n</script>\n<template><p /></template>\n`;
      expect((await lintAs('src/views/ReviewProbe.vue', vue)).length, `vue: ${probe}`).toBeGreaterThan(0);
    }
  }, 30_000);

  it('the allowances are unchanged: ownerStorage.ts and tests may use the names; types and unrelated keys are not flagged', async () => {
    const [module] = await eslint.lintFiles([join(webRoot, 'src/session/ownerStorage.ts')]);
    expect(module?.messages).toEqual([]);
    expect(await lintAs('test/some-check.spec.ts', fixture('aliasedStorage.ts'))).toEqual([]);
    const harmless = [
      'export type Kept = Storage | IDBDatabase;',
      'export function open(database: IDBDatabase): IDBTransaction { return database.transaction("events"); }',
      'export const label = { storage: "기기에 저장", session: "세션" };',
    ].join('\n');
    expect(await lintAs('src/session/harmless.ts', harmless)).toEqual([]);
  }, 30_000);
});

describe('lint: owner-isolation/bound-await', () => {
  it('flags a bare await, an unguarded catch and a finally inside runOwnerBound, and in an OwnerScope helper (negative)', async () => {
    const messages = await lintAs('src/views/boundTask.ts', fixture('boundTask.ts'));
    expect(messages.map((message) => [message.rule, message.id, message.line])).toEqual([
      ['owner-isolation/bound-await', 'unbound', 12],
      ['owner-isolation/bound-await', 'unguardedCatch', 14],
      ['owner-isolation/bound-await', 'noFinally', 17],
      ['owner-isolation/bound-await', 'unbound', 26],
    ]);
  }, 30_000);

  it('accepts the correct form: owner.wait, rethrowIfStale first, cleanup in onSettled', async () => {
    const source = fixture('boundTask.ts');
    const right = source.slice(source.indexOf('export async function right'));
    const header = source.slice(0, source.indexOf('export async function wrong'));
    const messages = await lintAs('src/views/boundTaskRight.ts', header + right);
    expect(messages.filter((message) => message.rule === 'owner-isolation/bound-await')).toEqual([]);
  }, 30_000);
});
