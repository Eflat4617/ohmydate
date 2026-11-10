import { readFileSync } from 'node:fs';

interface PackageManifest {
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly devDependencies?: Readonly<Record<string, string>>;
}

const manifest = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
) as PackageManifest;

test('scheduler is a test-only devDependency, not a production dependency', () => {
  expect(manifest.dependencies?.['@ohmydate/scheduler']).toBeUndefined();
  expect(manifest.devDependencies?.['@ohmydate/scheduler']).toBe('workspace:*');
});
