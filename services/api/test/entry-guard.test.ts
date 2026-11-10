import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isEntryPoint } from '../src/db/migrate.js';
import { isDirectEntrypoint } from '../src/main.js';

describe('entry point guards', () => {
  let root: string;
  let realDir: string;
  let moduleFile: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'ohmydate-entry-'));
    realDir = join(root, 'release');
    await mkdir(realDir, { recursive: true });
    moduleFile = join(realDir, 'main.js');
    await writeFile(moduleFile, '// entry fixture\n');
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test.each([
    ['absolute path', () => moduleFile],
    ['extensionless path', () => moduleFile.replace(/\.js$/, '')],
  ])('isDirectEntrypoint accepts an %s', (_label, entry) => {
    expect(isDirectEntrypoint(entry(), pathToFileURL(moduleFile).href)).toBe(true);
  });

  test('isDirectEntrypoint accepts a symlinked release directory', async () => {
    const linkedDir = join(root, 'current');
    await symlink(realDir, linkedDir, 'dir');

    expect(
      isDirectEntrypoint(join(linkedDir, 'main.js'), pathToFileURL(moduleFile).href),
    ).toBe(true);
  });

  test('isDirectEntrypoint rejects unrelated and missing entries', () => {
    const other = join(root, 'other.js');
    expect(isDirectEntrypoint(undefined, pathToFileURL(moduleFile).href)).toBe(false);
    expect(isDirectEntrypoint(other, pathToFileURL(moduleFile).href)).toBe(false);
    expect(isDirectEntrypoint(join(root, 'missing'), pathToFileURL(moduleFile).href)).toBe(
      false,
    );
  });

  test.each([
    ['absolute path', () => moduleFile],
    ['extensionless path', () => moduleFile.replace(/\.js$/, '')],
  ])('isEntryPoint accepts an %s', (_label, entry) => {
    expect(isEntryPoint(entry(), pathToFileURL(moduleFile).href)).toBe(true);
  });

  test('isEntryPoint accepts a symlinked release directory', async () => {
    const linkedDir = join(root, 'current');
    await symlink(realDir, linkedDir, 'dir');

    expect(isEntryPoint(join(linkedDir, 'main.js'), pathToFileURL(moduleFile).href)).toBe(
      true,
    );
  });

  test('isEntryPoint rejects unrelated and missing entries', () => {
    const other = join(root, 'other.js');
    expect(isEntryPoint(undefined, pathToFileURL(moduleFile).href)).toBe(false);
    expect(isEntryPoint(other, pathToFileURL(moduleFile).href)).toBe(false);
    expect(isEntryPoint(join(root, 'missing'), pathToFileURL(moduleFile).href)).toBe(false);
  });
});
