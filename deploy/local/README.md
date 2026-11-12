# GU-1 local run package

Local-only (127.0.0.1) OhMyDate stack for the user try-out. It is isolated from
the shared dev/test infra: project `ohmydate-local`, PostgreSQL on 55442,
Vikunja on 3466, API on 3100, web on 5180, and its own pgdata volume/files dir
(`${HOME}/.local/share/ohmydate-local/vikunja-files`).

## Prerequisites

- Node >= 24 and `corepack pnpm` from the repo root.
- Docker is operated by the coordinator; workers/users never run docker.
- The product key file (`deepseek_api_key.txt`, or `LLM_API_KEY_FILE`) with
  mode 0600. Only `access(2)`/mode is checked — its contents are never read by
  the local scripts.

## First-time order

```sh
# 1) Generate local secrets (idempotent; never prints values). This also
#    creates deploy/secrets/local/stack.env needed by compose.
corepack pnpm local:setup

# 2) Coordinator starts the isolated stack (do this after step 1):
docker compose --env-file deploy/local/local.env -f deploy/local/compose.yaml up -d

# 3) Ask for email/password (hidden, twice) and provision Vikunja + planner:
corepack pnpm local:setup

# 4) Build if stale and start API + web preview:
corepack pnpm local:start
# -> http://127.0.0.1:5180/
```

If step 1 stops with a stack error, that is expected: it created the secret
files, and step 2 must run before step 3.

## Day-to-day

```sh
corepack pnpm local:status   # Korean summary: stack, migrations, secrets, key, token, API/web
corepack pnpm local:start    # rebuild only when sources are newer (or --rebuild)
corepack pnpm local:stop     # SIGTERM then SIGKILL after a bound; never touches docker
corepack pnpm test:local     # local unit tests + dev-infra smoke (needs DATABASE_URL/VIKUNJA_URL)
```

`local:start --fake-llm` is for automated tests only (LLM_PROVIDER=fake,
NODE_ENV=development). Re-running `local:setup` with the same email is a no-op;
pass `--rotate-token` to rotate the Vikunja API token. Non-interactive setup
uses `OHMYDATE_LOCAL_EMAIL` and `OHMYDATE_LOCAL_PASSWORD`.

## Notes and risks

- Vikunja registration is enabled, but only reachable on 127.0.0.1. Use a real
  local account; do not expose these ports.
- Secrets: `deploy/secrets/local/` (0700, files 0600, gitignored). The stack
  password is shared by Postgres and Vikunja's DB user, as in deploy/dev.
- `deploy/secrets/local/vikunja-tokens.json` is the API token file
  (`ownerId -> token`); `vikunja-tokens.meta.json` records only the expiry.
- Logs and PID files: `.local/logs/`, `.local/run/` (gitignored). Logs rotate
  at each start (previous file kept as `*.log.1`).
- To reset local data, stop the apps and remove the `ohmydate-local` compose
  project/volumes and `${HOME}/.local/share/ohmydate-local` (coordinator action).
- `local:status` reports the token only by validity/expiry; it never prints the
  token, password or key contents.
