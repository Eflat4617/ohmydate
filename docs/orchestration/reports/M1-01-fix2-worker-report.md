# M1-01R2 — Final boundary-checker fixes — worker report

- taskId: `task_ee21e7d4cf5d`
- dispatchId: `ctx_30b8cf248c31`
- worktree: `/home/torgal/orca/workspaces/oh_my_date/m1-01-monorepo`
- branch: `torgal/m1-01-monorepo`
- base for this round: `d5d055a790649e2b238c7d221ff44ad146e21be2`
- fix commit: `4630821c89ea02e3ee218c809f7ad6dd21602740` — `fix(m1-01): close boundary checker bypasses`
- review read: `docs/orchestration/reviews/M1-01R-2.md` on `torgal/ohmydate`

## Changed paths (`git diff --name-only d5d055a...HEAD`, 22 files)

- `scripts/check-boundaries.mjs`
- `scripts/check-boundaries.test.mjs`
- `scripts/__fixtures__/boundaries/absolute-template/{apps/web/src/abs-service.ts,packages/other/src/abs-service.ts,packages/other/src/abs-upstream.ts,services/api/src/index.ts,upstream/vikunja/foo.ts}`
- `scripts/__fixtures__/boundaries/allowed/{apps/web/package.json,services/api/package.json,packages/domain/package.json,packages/other/package.json,packages/domain/src/external-types.d.ts,packages/other/allowed.config.js,packages/other/src/index.ts}`
- `scripts/__fixtures__/boundaries/forbidden/{apps/web/package.json,services/api/package.json,packages/domain/package.json,packages/other/package.json,apps/web/src/workspace-service.ts,packages/domain/src/service-types.d.ts,packages/domain/src/workspace-service.ts,packages/other/foo.config.js}`

Diff summary: 22 files, +145/-15. Source collection now uses the full source extension set (`.ts/.tsx/.mts/.cts/.d.ts/.js/.mjs/.cjs/.jsx`) under `apps/**`,
`services/**`, `packages/**`, root files, and `scripts/**`, excluding `node_modules`, `dist`, `coverage`,
`upstream/**`, and `scripts/__fixtures__/**`. Declaration files are treated as type-only for rule (a) while
rules (b)/(c)/(d) still apply. Absolute specifiers are resolved and made repository-relative before zone
classification; targets outside the repo are external. Fixtures now include package manifests for
workspace-name classification, plus .d.ts, package JS config, workspace-name, and absolute-path cases.

## Requirement checklist

1. [x] Declaration files and JS configs inside workspace roots are collected. `collectDefaultFiles` scans all
   owned roots with `ALL_SOURCE`; `collectSourceFiles` no longer excludes `.d.ts`; root and `scripts/**`
   scans use the same extension set. Exclusions remain `node_modules`, `dist`, `coverage`, `upstream`, and
   `scripts/__fixtures__`.
   - `.d.ts` rule-(a) exception preserved: imports in declaration files are treated as type-only.
   - Rules (b)/(c)/(d) still apply to declaration files. Regression fixture:
     `packages/domain/src/service-types.d.ts` with `typeof import('../../../services/api/src/index.js')`
     produces `packages/no-app-or-service-imports`.
   - Package JS config regression: `packages/other/foo.config.js` importing `../../upstream/vikunja/foo.js`
     produces `no-upstream-imports`.
2. [x] Absolute import specifiers are resolved against the filesystem and normalized with
   `path.relative(repoRoot, abs)`. In-repo absolute targets are classified by zone; outside-repo targets are
   external. Regression fixtures cover absolute service targets (package d + web c) and absolute upstream
   targets (b).
3. [x] Fixture package manifests were added so workspace package-name classification is exercised:
   `@ohmydate/api` imports from packages/domain and apps/web are rejected; an allowed
   `@ohmydate/domain` import from packages/other passes.
4. [x] All regression fixtures live under `scripts/__fixtures__/boundaries/**`, which is excluded from the
   real scan and ESLint. The absolute-path fixtures are committed templates; the test materializes them in
   a temporary repo because absolute paths depend on the checkout location.

## Tests actually executed

1. `pnpm install` — exit `0`
   - `Scope: all 11 workspace projects`
   - `Already up to date`
   - `Done in 3ms using pnpm v12.18.0`
2. `pnpm run ci` — exit `0`
   - `typecheck`: all 10 workspace package `tsc --noEmit` runs `Done`
   - `lint`: `eslint .` exit 0
   - `test`: `Test Files 11 passed (11)`, `Tests 13 passed (13)`
   - `check:boundaries`: `Boundary check passed: 24 file(s), 0 violations.`
3. `pnpm exec vitest run scripts/check-boundaries.test.mjs --reporter=verbose` — exit `0`
   - `allowed fixtures produce no violations`
   - `forbidden fixtures enforce rules (a)-(d) and type-only edge cases`
   - `absolute service and upstream imports are rejected`
   - `Test Files 1 passed (1)`, `Tests 3 passed (3)`

## Risks / unverified / dependents / rollback

- Risk: the absolute-path test materializes fixtures in `os.tmpdir()` and cleans them up in `finally`; a
  crash before cleanup could leave a temporary directory, but it cannot affect the repository.
- Risk: static analysis still cannot resolve computed import strings or future TS path aliases; those would
  need additional checker logic.
- Unverified: no application/runtime behavior is added or changed; this round only touches the boundary
  checker, its fixtures/tests, and no dependency versions or lockfile content.
- Dependents: M1-02 can add source files under the owned roots and rely on `.d.ts`, JS config, workspace
  package-name, and absolute-path boundary coverage.
- Rollback: revert commit `4630821` or delete branch `torgal/m1-01-monorepo`; no shared branch was modified.
