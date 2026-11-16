# REVIEW PACKET: RC-10BR — independent, narrow review of RC-10B (the web's desktop mode and the launch token's path)
Role: reviewer (GPT-6.1 Sol medium via Codex). READ-ONLY: do not modify, create or delete tracked files; do not commit. Running the listed commands is allowed.
Target worktree: this worktree. Branch: torgal/rc-10b-web-on-core. Base: 914fc1e. Head: 3515433.
Original packet: `git show torgal/ohmydate:docs/orchestration/packets/RC-10B.md`. Background: `docs/blueprint/15-DESKTOP-RUST-CORE.md` §1.3 (boot hand-off, launch cookie, CSP) and §7.3.

KEEP IT NARROW. This is not a full re-verification: the coordinator re-runs the test suites. Spend your effort on the four questions below, in this order, reading the diff (`git diff 914fc1e...3515433 -- <paths>`), and stop when they are answered. Do not explore beyond the listed paths unless a finding requires it.

Q1 — Can desktop mode leak into a server build? Server mode is the deployed web: login form, sessions, CSRF, owner isolation and the hard reset on owner change. Desktop mode skips the login and trusts whoever answers `GET /me`. Read `apps/web/src/platform/mode.ts`, `apps/web/src/main.ts`, `apps/web/src/router.ts`, `apps/web/src/session/ownerQuery.ts`, `apps/web/vite.config.ts`, `apps/web/package.json` scripts, and every `isDesktop`/`appMode` call site (`grep -rn "appMode\|isDesktop" apps/web/src`). Is there any run-time input (URL, storage, cookie, response body, env var read at run time) that can turn a server build into desktop behaviour, or any server-mode guard (redirect to login when signed out, owner epoch / hard reset, CSRF header) that this change weakened or bypassed? Is the guard test in `apps/web/test/rc-10b-desktop-mode.spec.ts` able to fail (would it catch a server bundle that skips the login)?
Q2 — Does the "501 = this place is not ready" handling (`apps/web/src/platform/notReady.ts` and its call sites, the retry rules, `apps/web/src/i18n/problem.ts`, `apps/web/src/notifications/useNotifications.ts`) change anything in server mode? In particular: could a real server error now be shown as "not ready", be swallowed, or stop a retry/poll that server mode relies on?
Q3 — The launch token (a bearer secret for the local core): `scripts/core/dev.mjs` (+ `dev.test.mjs`), `e2e/targets/core-setup.ts`, `core-teardown.ts`, `e2e/helpers/driver.ts`, `e2e/helpers/state.ts`, `e2e/helpers/test.ts`. Can the token end up in terminal output, a log, a process argument or environment of a child, the browser bundle, a Playwright trace/report/screenshot name, or a file that is not 0600 / not removed? Is the ready file's mode checked? Is the Vite proxy the only place that attaches it in `core:dev`, and does it refuse to forward to anything but the loopback core?
Q4 — Owner data on the device in desktop mode: is device state still namespaced by the id `/me` returns, and is a changed id still a hard reset (read the tests that claim it)?

Run only these (paste exit codes): `corepack pnpm install --offline` if node_modules is missing; `corepack pnpm --filter @ohmydate/web exec vitest run test/rc-10b-desktop-mode.spec.ts --maxWorkers=2`; `node --test scripts/core/dev.test.mjs` (or the command its header names); `corepack pnpm --filter @ohmydate/web build` and then show that the server bundle's mode function is constant-folded to "server" (`grep -o 'return"server"' -r apps/web/dist/assets | head -3` or the equivalent you find). Do not run E2E, cargo or the full web test suite. 15 GB laptop: one command at a time.

Finish with exactly one worker_done (`orca orchestration send --type worker_done --subject "<taskId> done" --task-id <taskId> --dispatch-id <dispatchId> --outcome succeeded --body "<review>" --json`) whose body is:
REVIEW VERDICT: APPROVE | REQUEST_CHANGES | BLOCKED
Findings (most severe first):
  [CRITICAL|HIGH|MEDIUM|LOW] <title>
    Evidence: <file>:<line> + reproduction or reasoning
    Required change | Suggestion
Answers: Q1 <one paragraph> / Q2 / Q3 / Q4
Verification actually executed: exact commands + exit codes
git status --porcelain after review: <must be empty of tracked changes>
Residual risks: <list>

--- WORKER CLAIMS (unverified) ---
- Desktop mode is the Vite mode only (`vite build --mode desktop` → apps/web/desktop/dist); `appMode()` reads only `import.meta.env.MODE`; in the server bundle it is literally `return "server"`. No address, storage, cookie, response or VITE_ variable can change it. A guard test fails if a server bundle does not send a signed-out visitor to the login form.
- In desktop mode a 401/403 from `/me` shows one plain page with no form; there is no /login route; sign-out, push opt-in and the service worker are absent.
- 501 is "not ready": never retried, the notification list stops polling after one ask, nothing throws. Server mode is unchanged; the default E2E target (login form, owner reset) passes unchanged.
- The token goes core → ready file (0600) → the Vite proxy's closure → the upstream header only; measured absent from launcher output, all three processes' arguments and environment, and served modules. In E2E the token is in no recorded step, report or message, and not in the run state file.
- Device state stays under the id `/me` returns; a different id is still a hard reset.
