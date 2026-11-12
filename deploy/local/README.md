# GU-1 local run package

Local-only (127.0.0.1) OhMyDate stack for the user try-out. It is isolated from
the shared dev/test infra: project `ohmydate-local`, PostgreSQL on 55442,
Vikunja on 3466, API on 3100, web on 5180. All persistent state lives in named
Docker volumes (`pgdata`, `vikunja-files`), so `sudo docker compose` never
creates root-owned host directories and `HOME` does not matter.

User guide (Korean, install → daily use → feedback): [docs/user/GU-1-사용안내.md](../../docs/user/GU-1-사용안내.md)

## Prerequisites

- Node >= 24 and `corepack pnpm` from the repo root.
- Workers never run docker. The user runs the stack only through `corepack pnpm local:stack <up|down|ps|logs>` (sudo); restore/reset (volume removal) is a coordinator action.
- The product key file (`deepseek_api_key.txt`, or `LLM_API_KEY_FILE`) with
  mode strictly `0600` (the start preflight refuses group/world access and
  prints the exact `chmod 600 <path>`). Its contents are never read by the
  local scripts.

## First-time order

```sh
# 1) Generate local secrets (idempotent; never prints values):
corepack pnpm local:secrets

# 2) Coordinator starts the isolated stack through the wrapper:
corepack pnpm local:stack up

# 3) Ask for email/password (hidden, twice) and provision Vikunja + planner.
#    The Korean time-zone prompt defaults to the machine's IANA zone.
corepack pnpm local:setup

# 4) Build if stale and start API + web preview:
corepack pnpm local:start
# -> http://127.0.0.1:5180/
```

`local:stack` resolves absolute compose/env paths from the repo root and runs
`sudo docker compose -p ohmydate-local --env-file <abs>/deploy/local/local.env -f
<abs>/deploy/local/compose.yaml <up|down|ps|logs>`; cwd does not matter.
`down` never removes volumes: `-v`/`--volumes` is refused with exit 1.
`--dry-run` prints the command without running docker.

## Day-to-day

```sh
corepack pnpm local:status   # Korean summary: target, stack, migrations, secrets, key, token, API/web
corepack pnpm local:start    # apply pending migrations, rebuild only when sources are newer (or --rebuild)
corepack pnpm local:migrate  # apply pending planner migrations only (idempotent)
corepack pnpm local:stop     # SIGTERM then SIGKILL after 20 s; never touches docker
corepack pnpm local:stack ps # container status
corepack pnpm test:local     # local unit tests + dev-infra smoke
```

`local:start` applies pending planner migrations automatically (after updates
only `local:stop` + `local:start` are needed) and prints one Korean line with
the applied filenames; `local:migrate` does just that step.

`local:start --fake-llm` is for automated tests only (LLM_PROVIDER=fake,
NODE_ENV=development). Re-running `local:setup` with the same email is a no-op
(an existing user's time zone/locale is not modified); pass `--rotate-token` to
issue a new Vikunja API token, atomically replace the token/meta files and
delete the previous token. Then run `local:stop` and `local:start` so the API
picks up the new token. Non-interactive setup uses `OHMYDATE_LOCAL_EMAIL` and
`OHMYDATE_LOCAL_PASSWORD`; `--email` can be combined with an interactive
password prompt. `--time-zone <IANA>` and `--locale <locale>` override the
system default for the newly created planner user only.

### Target isolation

`local:setup/start/status/stop` ignore ambient `DATABASE_URL` and `VIKUNJA_URL`
so a shell that exported the dev/test values can never redirect the local run.
Only `OHMYDATE_LOCAL_DATABASE_URL` and `OHMYDATE_LOCAL_VIKUNJA_URL` change the
target (the smoke test maps the dev variables to these). Every command prints
the resolved `host:port/database` and Vikunja URL, never the password.

## Secrets and backups

- `deploy/secrets/local/` (0700, files 0600, gitignored) contains
  `postgres.env`, `vikunja.env`, `push.key`, `llm-session-secret` and the
  Vikunja token files.
- **This directory and the `ohmydate-local` volumes are one pair.** Losing the
  directory (for example `git clean -fdx` or deleting the worktree) loses the
  PostgreSQL password and locks you out of the existing database. Back up the
  secrets directory and the `pgdata`/`vikunja-files` volumes together. If the
  directory is missing while the stack volumes still exist, `local:status`
  warns about it.
- `deploy/secrets/local/vikunja-tokens.json` is the API token file
  (`ownerId -> token`); `vikunja-tokens.meta.json` records expiry and the
  Vikunja token id.

## Notes and risks

- Vikunja registration is enabled, but only reachable on 127.0.0.1. Use a real
  local account; do not expose these ports.
- Logs and PID files: `.local/logs/`, `.local/run/` (gitignored, 0600). Logs
  rotate at each start (previous file kept as `*.log.1`).
- PID files store the kernel start time and a random marker; `local:stop`
  signals a process only when both match, so a stale or foreign PID is never
  killed.
- To reset local data, stop the apps and remove the `ohmydate-local` compose
  project/volumes (coordinator action; `local:stack down -v` is intentionally
  not supported).
- `local:status` reports the token only by validity/expiry; it never prints the
  token, password or key contents.
