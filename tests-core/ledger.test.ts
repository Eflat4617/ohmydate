/**
 * Keeps the parity ledger (`core/PARITY.md`, blueprint 15 §7.5) from going
 * stale. The ledger names every TypeScript test file of the reference core
 * and says how the Rust core keeps what that file kept. This test fails when
 *
 * - a `*.test.ts` / `*.spec.ts` file exists that the ledger does not name;
 * - the ledger names a file that is gone, or names one twice;
 * - a line has no known state, or lacks what its state must say;
 * - a line points at a Rust or harness test that does not exist;
 * - a "not yet" line points at a task that is finished or unknown;
 * - the totals no longer match the lines, or the task lists no longer match
 *   the plan;
 * - the E2E specs that run on the core target (`e2e/targets/core-specs.json`)
 *   are not the ones the ledger says pass there.
 *
 * No core process is needed. `LEDGER_WRITE_TOTALS=1 corepack pnpm run
 * core:ledger` rewrites the totals block from the lines.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const ledgerPath = join(repoRoot, 'core/PARITY.md');

/** Where the reference core's tests live, in the order of the ledger. */
const DIRECTORIES = [
  'services/api/test',
  'packages/scheduler/test',
  'packages/llm/test',
  'packages/domain/test',
  'packages/provider-native/test',
  'packages/provider-vikunja/test',
  'packages/contracts/test',
  'packages/testkit/test',
  'e2e/tests',
] as const;

const STATES = ['옮김', '대체', '해당 없음', '아직'] as const;

/** E2E specs are not ported; they are pointed at the core (blueprint 15 §7.3). */
const E2E_DIRECTORY = 'e2e/tests';
const coreSpecsPath = join(repoRoot, 'e2e/targets/core-specs.json');

/** What disagrees between the specs the core target runs and the ledger's E2E lines. */
function coreSpecProblems(coreSpecs: readonly string[], e2eLines: readonly Line[]): string[] {
  const problems: string[] = [];
  const byFile = new Map(e2eLines.map((line) => [line.file, line]));
  for (const spec of coreSpecs) {
    const line = byFile.get(spec);
    if (line === undefined) problems.push(`${spec} runs on the core target but is not a spec the ledger names`);
    else if (line.state !== '옮김' && line.state !== '아직') {
      problems.push(`${spec} runs on the core target but the ledger says "${line.state}"`);
    }
  }
  for (const line of e2eLines) {
    if (line.state === '옮김' && !coreSpecs.includes(line.file)) {
      problems.push(`${line.file} is "옮김" in the ledger but the core target does not run it`);
    }
  }
  if (new Set(coreSpecs).size !== coreSpecs.length) problems.push('a spec is listed twice');
  return problems;
}
type State = (typeof STATES)[number];

interface Line {
  readonly directory: string;
  readonly file: string;
  readonly state: string;
  readonly note: string;
}

/** Test files below `directory`, as paths relative to it. */
function testFiles(directory: string): string[] {
  const found: string[] = [];
  const walk = (relative: string): void => {
    for (const entry of readdirSync(join(repoRoot, directory, relative), { withFileTypes: true })) {
      const path = relative === '' ? entry.name : `${relative}/${entry.name}`;
      if (entry.isDirectory()) {
        if (entry.name !== 'node_modules') walk(path);
      } else if (/\.(?:test|spec)\.ts$/.test(entry.name)) {
        found.push(path);
      }
    }
  };
  walk('');
  return found.sort();
}

function between(text: string, name: string): string {
  const start = text.indexOf(`<!-- ${name}:start -->`);
  const end = text.indexOf(`<!-- ${name}:end -->`);
  if (start < 0 || end < start) throw new Error(`the ledger has no ${name} block`);
  return text.slice(start + `<!-- ${name}:start -->`.length, end).trim();
}

/** The lines of the ledger: table rows below a `## <directory>` heading. */
function parseLines(text: string): Line[] {
  const lines: Line[] = [];
  let directory: string | undefined;
  for (const raw of text.split('\n')) {
    const heading = /^## (.+)$/.exec(raw);
    if (heading !== null) {
      directory = (DIRECTORIES as readonly string[]).includes(heading[1] ?? '') ? heading[1] : undefined;
      continue;
    }
    if (directory === undefined || !raw.startsWith('| `')) continue;
    const cells = raw.split('|').slice(1, -1).map((cell) => cell.trim());
    lines.push({
      directory,
      file: (cells[0] ?? '').replace(/`/g, ''),
      state: cells[1] ?? '',
      note: cells.slice(2).join('|').trim(),
    });
  }
  return lines;
}

function taskList(text: string, label: string): string[] {
  const line = between(text, 'tasks')
    .split('\n')
    .find((entry) => entry.startsWith(`- ${label}:`));
  if (line === undefined) throw new Error(`the ledger has no "${label}" list`);
  return line
    .slice(`- ${label}:`.length)
    .split(',')
    .map((task) => task.trim())
    .filter((task) => task.length > 0);
}

const TASK = /RC-\d+[A-Za-z]?/g;

/** The task a "not yet" line is waiting for: the first one it names. */
function owningTask(line: Line): string | undefined {
  return line.note.match(TASK)?.[0];
}

function totalsBlock(lines: readonly Line[]): string {
  const count = (subset: readonly Line[], state: State): number =>
    subset.filter((line) => line.state === state).length;
  const row = (label: string, subset: readonly Line[]): string =>
    `| ${label} | ${subset.length} | ${STATES.map((state) => count(subset, state)).join(' | ')} |`;
  const waiting = new Map<string, number>();
  for (const line of lines) {
    if (line.state !== '아직') continue;
    const task = owningTask(line) ?? '?';
    waiting.set(task, (waiting.get(task) ?? 0) + 1);
  }
  const byTask = [...waiting.entries()]
    .sort(([left], [right]) => left.localeCompare(right, 'en', { numeric: true }))
    .map(([task, files]) => `${task} ${files}`)
    .join(' · ');
  return [
    `| 위치 | 파일 | ${STATES.join(' | ')} |`,
    '|---|---|---|---|---|---|',
    ...DIRECTORIES.map((directory) =>
      row(`\`${directory}\``, lines.filter((line) => line.directory === directory)),
    ),
    row('합계', lines),
    '',
    `"아직"을 맡은 Task별 파일 수: ${byTask}`,
  ].join('\n');
}

let ledger = readFileSync(ledgerPath, 'utf8');
if (process.env['LEDGER_WRITE_TOTALS'] === '1') {
  const start = ledger.indexOf('<!-- totals:start -->') + '<!-- totals:start -->'.length;
  const end = ledger.indexOf('<!-- totals:end -->');
  ledger = `${ledger.slice(0, start)}\n${totalsBlock(parseLines(ledger))}\n${ledger.slice(end)}`;
  writeFileSync(ledgerPath, ledger);
}
const lines = parseLines(ledger);

describe('parity ledger (15 §7.5)', () => {
  test('names every TypeScript test file exactly once, and no file that is gone', () => {
    for (const directory of DIRECTORIES) {
      const onDisk = testFiles(directory);
      const named = lines.filter((line) => line.directory === directory).map((line) => line.file);
      expect(onDisk.length, `${directory} has test files`).toBeGreaterThan(0);
      expect(
        onDisk.filter((file) => !named.includes(file)),
        `test files under ${directory} that core/PARITY.md does not name — add a line for each`,
      ).toEqual([]);
      expect(
        named.filter((file) => !onDisk.includes(file)),
        `core/PARITY.md names files under ${directory} that do not exist — remove or rename the lines`,
      ).toEqual([]);
      expect(
        named.filter((file, index) => named.indexOf(file) !== index),
        `files named twice under ${directory}`,
      ).toEqual([]);
    }
  });

  test('every line has one of the four states and says what that state must say', () => {
    for (const line of lines) {
      const where = `${line.directory}/${line.file}`;
      expect(STATES as readonly string[], where).toContain(line.state);
      expect(line.note.length, `${where} needs a note`).toBeGreaterThan(0);
      if (line.state === '옮김' || line.state === '대체') {
        expect(line.note, `${where}: say where it went, after "→"`).toMatch(/^→ /);
      }
      if (line.state === '옮김' && line.directory === E2E_DIRECTORY) {
        // An E2E spec is not rewritten: the same file runs on the core target.
        expect(line.note, `${where}: say that it passes with E2E_TARGET=core`).toContain('`E2E_TARGET=core`');
      } else if (line.state === '옮김') {
        expect(line.note, `${where}: name the Rust or harness test file`).toMatch(/`(?:core|tests-core)\/[^`]+`/);
      }
      if (line.state === '아직') {
        expect(line.note, `${where}: start with the task that will do it`).toMatch(/^RC-\d+[A-Za-z]?/);
      }
    }
  });

  test('every test a line points at exists', () => {
    for (const line of lines) {
      for (const match of line.note.matchAll(/`((?:core|tests-core)\/[^`\s]+)`/g)) {
        const [path = '', name] = (match[1] ?? '').split('::');
        const where = `${line.directory}/${line.file} → ${match[1] ?? ''}`;
        expect(existsSync(join(repoRoot, path)), `${where}: no such file`).toBe(true);
        if (name !== undefined) {
          expect(
            readFileSync(join(repoRoot, path), 'utf8').includes(`fn ${name}(`),
            `${where}: no test of that name in the file`,
          ).toBe(true);
        }
      }
    }
  });

  test('"not yet" lines wait for a task that is still open', () => {
    const finished = taskList(ledger, '끝난 Task');
    const open = taskList(ledger, '남은 Task');
    expect(finished.filter((task) => open.includes(task))).toEqual([]);
    for (const line of lines.filter((entry) => entry.state === '아직')) {
      const task = owningTask(line) ?? '';
      const where = `${line.directory}/${line.file}`;
      expect(finished, `${where} waits for ${task}, which is finished — reclassify the line`).not.toContain(task);
      expect(open, `${where} waits for ${task}, which is not a task of the plan`).toContain(task);
    }
  });

  test('the task lists are the tasks of the plan (15 §10)', () => {
    const plan = readFileSync(join(repoRoot, 'docs/blueprint/15-DESKTOP-RUST-CORE.md'), 'utf8');
    const section = plan.slice(plan.indexOf('## 10. 단계 계획'), plan.indexOf('## 11. 위험과 모르는 것'));
    const planned = [...section.matchAll(/^\| (RC-\d+[A-Za-z]?) \|/gm)].map((match) => match[1] ?? '');
    expect(planned.length).toBeGreaterThan(10);
    const listed = [...taskList(ledger, '끝난 Task'), ...taskList(ledger, '남은 Task')];
    expect([...listed].sort()).toEqual([...planned].sort());
  });

  test('the totals are the totals of the lines', () => {
    expect(
      between(ledger, 'totals'),
      'run `LEDGER_WRITE_TOTALS=1 corepack pnpm run core:ledger` to rewrite the totals block',
    ).toBe(totalsBlock(lines));
    expect(lines.length).toBe(DIRECTORIES.reduce((sum, directory) => sum + testFiles(directory).length, 0));
  });

  test('the E2E specs the core target runs are the ones the ledger says pass there', () => {
    const coreSpecs = JSON.parse(readFileSync(coreSpecsPath, 'utf8')) as string[];
    const e2eLines = lines.filter((line) => line.directory === E2E_DIRECTORY);
    expect(coreSpecs.length).toBeGreaterThan(0);
    expect(
      coreSpecProblems(coreSpecs, e2eLines),
      'e2e/targets/core-specs.json and the e2e/tests table of core/PARITY.md disagree',
    ).toEqual([]);
  });

  test('the checks themselves notice what they are for (negative)', () => {
    const sample = [
      '## services/api/test',
      '| `a.test.ts` | 옮김 | → `core/crates/app/src/tasks.rs` |',
      '| `b.test.ts` | 아직 | RC-40 |',
      '## not/a/ledger/directory',
      '| `ignored.test.ts` | 옮김 | → nowhere |',
    ].join('\n');
    const parsed = parseLines(sample);
    expect(parsed.map((line) => [line.file, line.state])).toEqual([
      ['a.test.ts', '옮김'],
      ['b.test.ts', '아직'],
    ]);
    expect(owningTask(parsed[1] as Line)).toBe('RC-40');
    expect(totalsBlock(parsed)).toContain('| 합계 | 2 | 1 | 0 | 0 | 1 |');
    expect(totalsBlock(parsed)).toContain('RC-40 1');
    expect(() => between('no markers here', 'totals')).toThrow();
    expect(() => taskList('<!-- tasks:start -->\n- 끝난 Task: RC-00\n<!-- tasks:end -->', '남은 Task')).toThrow();
    // The core target's list and the ledger: each way of disagreeing is noticed.
    const e2e = (file: string, state: string): Line => ({ directory: E2E_DIRECTORY, file, state, note: 'x' });
    const table = [e2e('a.spec.ts', '옮김'), e2e('b.spec.ts', '아직'), e2e('c.spec.ts', '해당 없음'), e2e('d.spec.ts', '아직')];
    expect(coreSpecProblems(['a.spec.ts', 'b.spec.ts'], table)).toEqual([]);
    expect(coreSpecProblems(['b.spec.ts'], table)).toEqual(['a.spec.ts is "옮김" in the ledger but the core target does not run it']);
    expect(coreSpecProblems(['a.spec.ts', 'c.spec.ts'], table)).toEqual(['c.spec.ts runs on the core target but the ledger says "해당 없음"']);
    expect(coreSpecProblems(['a.spec.ts', 'zz.spec.ts'], table)).toEqual(['zz.spec.ts runs on the core target but is not a spec the ledger names']);
    expect(coreSpecProblems(['a.spec.ts', 'a.spec.ts'], table)).toEqual(['a spec is listed twice']);
    // The walker finds nested files and ignores everything that is not a test.
    expect(testFiles('services/api/test')).toContain('db/migrate.test.ts');
    expect(testFiles('services/api/test')).not.toContain('support/test-context.ts');
  });
});
