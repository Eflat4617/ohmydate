import { dirname, resolve } from 'node:path';
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
      'packages/other/src/upstream-value.ts',
      'scripts/tool.ts',
      'vitest.config.ts',
    ]);
    expect(filesFor(violations, 'web/no-service-imports')).toEqual([
      'apps/web/src/type-service.ts',
      'apps/web/src/value-service.ts',
    ]);
    expect(filesFor(violations, 'packages/no-app-or-service-imports')).toEqual([
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
});
