import {
  cpSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { runBoundaryCheck } from './check-boundaries.mjs';

const fixturesRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '__fixtures__/boundaries',
);

function check(fixture) {
  return runBoundaryCheck({ repoRoot: resolve(fixturesRoot, fixture) });
}

function filesFor(violations, rule) {
  return violations
    .filter((violation) => violation.rule === rule)
    .map((violation) => violation.file)
    .sort();
}

function walkFiles(dir) {
  const files = [];
  for (const entry of readdirSync(dir)) {
    const absolute = join(dir, entry);
    if (statSync(absolute).isDirectory()) {
      files.push(...walkFiles(absolute));
    } else {
      files.push(absolute);
    }
  }
  return files;
}

describe('check-boundaries', () => {
  test('allowed fixtures produce no violations', () => {
    const { checkedFiles, violations } = check('allowed');

    expect(checkedFiles).toBeGreaterThan(0);
    expect(violations).toEqual([]);
  });

  test('forbidden fixtures enforce rules (a)-(d) and type-only edge cases', () => {
    const { violations } = check('forbidden');

    expect(filesFor(violations, 'no-upstream-imports')).toEqual([
      'eslint.config.js',
      'packages/other/foo.config.js',
      'packages/other/src/upstream-value.ts',
      'scripts/tool.ts',
      'vitest.config.ts',
    ]);
    expect(filesFor(violations, 'web/no-service-imports')).toEqual([
      'apps/web/src/type-service.ts',
      'apps/web/src/value-service.ts',
      'apps/web/src/workspace-service.ts',
    ]);
    expect(filesFor(violations, 'packages/no-app-or-service-imports')).toEqual([
      'packages/domain/src/service-types.d.ts',
      'packages/domain/src/workspace-service.ts',
      'packages/other/src/type-service.ts',
      'packages/other/src/value-service.ts',
    ]);
    expect(filesFor(violations, 'domain/no-node-builtins')).toEqual([
      'packages/domain/src/node-builtin.ts',
    ]);
    expect(filesFor(violations, 'domain/no-runtime-external-import')).toEqual([
      'packages/domain/src/inline-named-type.ts',
      'packages/domain/src/mixed-import.ts',
      'packages/domain/src/runtime-external.ts',
    ]);

    expect(
      violations.some((violation) =>
        violation.file.endsWith('/packages/domain/src/type-only-import.ts'),
      ),
    ).toBe(false);
    expect(
      violations.some((violation) =>
        violation.file.endsWith('/packages/domain/src/import-type-allowed.ts'),
      ),
    ).toBe(false);

    for (const file of [
      'packages/domain/src/inline-named-type.ts',
      'packages/domain/src/mixed-import.ts',
    ]) {
      const violation = violations.find((entry) => entry.file === file);
      expect(violation?.rule).toBe('domain/no-runtime-external-import');
      expect(violation?.message).toContain('(typescript)');
    }
  });

  test('absolute service and upstream imports are rejected', () => {
    const tempRoot = mkdtempSync(join(tmpdir(), 'ohmydate-boundary-'));
    try {
      cpSync(resolve(fixturesRoot, 'absolute-template'), tempRoot, { recursive: true });
      const absoluteFixtureRoot = tempRoot.split(sep).join('/');
      for (const file of walkFiles(tempRoot)) {
        const text = readFileSync(file, 'utf8');
        if (text.includes('__FIXTURE_ROOT__')) {
          writeFileSync(file, text.replaceAll('__FIXTURE_ROOT__', absoluteFixtureRoot));
        }
      }

      const { violations } = runBoundaryCheck({ repoRoot: tempRoot });

      expect(filesFor(violations, 'packages/no-app-or-service-imports')).toContain(
        'packages/other/src/abs-service.ts',
      );
      expect(filesFor(violations, 'no-upstream-imports')).toContain(
        'packages/other/src/abs-upstream.ts',
      );
      expect(filesFor(violations, 'web/no-service-imports')).toContain(
        'apps/web/src/abs-service.ts',
      );
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});
