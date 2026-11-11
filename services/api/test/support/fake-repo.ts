import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

/**
 * Minimal stand-in for the repository, shaped like the inputs of
 * createApiBuildWorkspace. Its `build` script is tiny but goes through the same
 * path as the real one: the run shim, a nested `pnpm run`, and a `dist` written
 * relative to the working directory. Lets workspace tests run without compilers.
 */
export interface FakeRepo {
  readonly repoRoot: string;
  readonly apiRoot: string;
  /** Parent directory for build workspaces created from this repository. */
  readonly baseDir: string;
  /** Changes the source the fake build compiles into dist/main.js. */
  readonly setSource: (marker: string) => Promise<void>;
  readonly cleanup: () => Promise<void>;
}

export const fakeSharedDistMain = '// shared checkout dist: must never change\n';

const buildScript = `import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
mkdirSync('dist/db', { recursive: true });
const source = readFileSync('src/marker.txt', 'utf8').trim();
writeFileSync('dist/main.js', '// ' + source + '\\n');
writeFileSync('dist/db/migrate.js', '// migrate\\n');
writeFileSync('dist/npm-execpath.txt', String(process.env.npm_execpath));
`;

export async function makeFakeRepo(): Promise<FakeRepo> {
  const root = await mkdtemp(join(tmpdir(), 'ohmydate-fake-repo-'));
  const repoRoot = join(root, 'repo');
  const apiRoot = join(repoRoot, 'services', 'api');
  const files: Record<string, string> = {
    'package.json': '{"name":"fake-root","private":true}\n',
    'pnpm-workspace.yaml': 'packages:\n  - services/*\n',
    'pnpm-lock.yaml': "lockfileVersion: '9.0'\n",
    'tsconfig.base.json': '{}\n',
    'docs/readme.md': 'not a build input\n',
    'packages/domain/src/index.ts': 'export const domain = 1;\n',
    'node_modules/.modules.yaml': 'storeDir: /nowhere\n',
    'node_modules/.bin/placeholder': '',
    'node_modules/root-dep/index.js': 'export default 1;\n',
    'scripts/ci/build-smoke.mjs': '// smoke\n',
    'services/api/package.json': `${JSON.stringify({
      name: 'fake-api',
      private: true,
      type: 'module',
      scripts: {
        build: 'pnpm run build:api && pnpm run build:which',
        'build:api': 'node build.mjs',
        'build:which': 'command -v pnpm > dist/pnpm-path.txt',
      },
    })}\n`,
    'services/api/build.mjs': buildScript,
    'services/api/src/marker.txt': 'source-v1\n',
    'services/api/node_modules/.bin/placeholder': '',
    'services/api/node_modules/api-dep/index.js': 'export default 1;\n',
    'services/api/dist/main.js': fakeSharedDistMain,
    'services/api/test/support/fixture-app.mjs': "import '../../dist/main.js';\n",
    'services/api/test/support/helper.ts': 'export {};\n',
    'services/api/test/example.test.ts': 'export {};\n',
  };
  for (const [relative, content] of Object.entries(files)) {
    const path = join(repoRoot, relative);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content, 'utf8');
  }
  return {
    repoRoot,
    apiRoot,
    baseDir: join(root, 'workspaces'),
    setSource: (marker) => writeFile(join(apiRoot, 'src', 'marker.txt'), `${marker}\n`, 'utf8'),
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}
