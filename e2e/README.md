# E2E-1 (Playwright)

Vertical slice: web -> planner API -> Vikunja. This suite needs the dev
infrastructure from `AGENTS.md` (PostgreSQL on `127.0.0.1:55432`, Vikunja on
`127.0.0.1:3456`) and is intentionally **not** part of `pnpm run ci`.

## Run

```sh
pnpm exec playwright install chromium
DATABASE_URL=postgres://ohmydate:ohmydate-dev-only@127.0.0.1:55432/planner_test \
VIKUNJA_URL=http://127.0.0.1:3456 \
pnpm run e2e
```

`e2e/global-setup.ts` creates a throwaway PostgreSQL schema, runs the
migrations into it, registers a synthetic Vikunja user, mints a scoped API
token, creates the planner user with the `create-user` CLI, wires the owner
account and inbox mapping, then starts the API (`PROVIDER=vikunja`) and the
Vite dev server on random loopback ports. `e2e/global-teardown.ts` stops both
processes and drops the schema.

Artifacts:

- HTML report: `playwright-report/index.html`
- Traces/screenshots: `test-results/`
- Server logs and run state: `test-results/e2e/`

The suite covers the E2E-1 flow (create -> Vikunja check -> edit -> second
context edit -> 412 conflict dialog -> overwrite -> complete -> Vikunja check),
offline mutation gating, a Tab/Enter-only login + quick-add flow, and
`@axe-core/playwright` scans of login and inbox (zero critical/serious).
