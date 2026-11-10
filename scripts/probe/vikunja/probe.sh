#!/usr/bin/env bash
# Live capability probe for the Vikunja v2 API (target: v2.8.0).
#
# Creates a synthetic user, authenticates, mints an API token and exercises the
# endpoints OhMyDate's TaskRepository is expected to need.  Every call is
# recorded; a missing/unsupported feature is a recorded observation, not a
# failure.  The script exits 0 once all planned probe calls ran, and 1 only for
# setup failures or transport/5xx errors.
#
# Usage: bash scripts/probe/vikunja/probe.sh [--check]
# Env:   VIKUNJA_BASE_URL (default http://127.0.0.1:3456)
#
# No dependencies beyond bash, curl and node.  Synthetic data only.

set -uo pipefail

BASE="${VIKUNJA_BASE_URL:-http://127.0.0.1:3456}"
API="$BASE/api/v2"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/vikunja-probe.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT

case "${1:-}" in
  ""|--check) ;;
  *) echo "usage: $0 [--check]" >&2; exit 2 ;;
esac

RESULTS="$TMP/results.tsv"
: > "$RESULTS"

AUTH=""
NOTE=""
LAST_STATUS=""
LAST_BODY=""
LAST_HDR=""
SERVER_ERRORS=0
TRANSPORT_ERRORS=0
SETUP_OK=0
TOKEN_ACTIVE=0

# jget <dot.path> <json-file>  -> scalar or compact JSON, empty on failure
jget() {
  node -e '
    const fs = require("fs");
    try {
      const o = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
      let v = o;
      for (const k of process.argv[1].split(".")) v = (v == null ? v : v[k]);
      if (v === undefined) process.stdout.write("");
      else if (typeof v === "object") process.stdout.write(JSON.stringify(v));
      else process.stdout.write(String(v));
    } catch (e) { process.stdout.write(""); }
  ' "$1" "$2"
}

urlenc() {
  node -e 'process.stdout.write(encodeURIComponent(process.argv[1]))' "$1"
}

track_status() {
  case "$1" in
    000) TRANSPORT_ERRORS=$((TRANSPORT_ERRORS + 1)) ;;
    5*)  SERVER_ERRORS=$((SERVER_ERRORS + 1)) ;;
  esac
}

record() { # name method path status note
  local note="${5:-}"
  note="${note//$'\t'/ }"
  note="${note//$'\n'/ }"
  printf '%s\t%s\t%s\t%s\t%s\n' "$1" "$2" "$3" "$4" "$note" >> "$RESULTS"
}

api() { # name method path [extra curl args...]
  local name="$1" method="$2" path="$3"
  shift 3
  local out="$TMP/$name.body" hdr="$TMP/$name.hdr"
  local args=(-sS -o "$out" -D "$hdr" -w '%{http_code}' -X "$method" "$API$path")
  if [ -n "$AUTH" ]; then args+=(-H "Authorization: Bearer $AUTH"); fi
  args+=("$@")
  local status
  status="$(curl "${args[@]}")"
  LAST_STATUS="$status"
  LAST_BODY="$out"
  LAST_HDR="$hdr"
  track_status "$status"
  record "$name" "$method" "$path" "$status" "${NOTE:-}"
  NOTE=""
}

print_summary() {
  PROBE_TRANSPORT_ERRORS="$TRANSPORT_ERRORS" \
  PROBE_SERVER_ERRORS="$SERVER_ERRORS" \
  PROBE_SETUP_OK="$SETUP_OK" \
  PROBE_TOKEN_ACTIVE="$TOKEN_ACTIVE" \
  PROBE_BASE="$BASE" \
  PROBE_USER="$PROBE_USERNAME" \
  PROBE_EMAIL="$PROBE_EMAIL" \
  node -e '
    const fs = require("fs");
    const dir = process.argv[1];
    const read = (n) => { try { return fs.readFileSync(dir + "/" + n, "utf8"); } catch (e) { return ""; } };
    const body = (n) => { try { return JSON.parse(read(n + ".body")); } catch (e) { return null; } };
    const lines = read("results.tsv").split("\n").filter(Boolean);
    const results = lines.map((l) => {
      const p = l.split("\t");
      return { name: p[0], method: p[1], path: p[2], status: Number(p[3]), note: p.slice(4).join("\t") };
    });
    const status = (n) => { const r = results.find((x) => x.name === n); return r ? r.status : null; };
    const hdr = read("task-get.hdr");
    const etagMatch = hdr.match(/^etag:\s*(.+)$/im);
    const errorRaw = (() => { try { return JSON.parse(read("task-get-404.body")); } catch (e) { return null; } })();
    const token = body("token-create");
    const filter = body("tasks-filter-updated");
    const page = body("tasks-pagination");
    const trash = body("tasks-trash-list");
    const events = body("webhook-events-get");
    const abs = body("task-put-reminder-absolute");
    const rel = body("task-put-reminder-relative");
    const att = body("attachment-upload");
    const wh = body("webhook-create");
    const idemIds = [body("idem-task-1") && body("idem-task-1").id, body("idem-task-2") && body("idem-task-2").id];
    const findings = {
      etag: etagMatch ? etagMatch[1].trim() : null,
      conditionalGet: {
        "if-match-matching": status("task-get-if-match"),
        "if-match-stale": status("task-get-if-match-stale"),
        "if-none-match-matching": status("task-get-if-none-match")
      },
      writePreconditions: {
        "put-matching-if-match": status("task-put"),
        "put-stale-if-match": status("task-put-stale-if-match"),
        "patch-stale-if-match": status("task-patch-stale-if-match")
      },
      idempotencyKey: {
        ignored: idemIds.length === 2 && idemIds[0] !== idemIds[1],
        observedIds: idemIds
      },
      relationKindsInSpec: ["subtask","parenttask","related","duplicateof","duplicates","blocking","blocked","precedes","follows","copiedfrom","copiedto"],
      relationCreate: body("relation-create"),
      reminders: {
        absolute: abs && abs.reminders,
        relative: rel && rel.reminders,
        repeatAfter: abs && abs.repeat_after,
        repeatMode: abs && abs.repeat_mode,
        dueDate: abs && abs.due_date
      },
      attachment: att && att.success && att.success[0],
      webhook: wh ? { id: wh.id, target_url: wh.target_url, events: wh.events, project_id: wh.project_id } : null,
      webhookEvents: events,
      changeDetection: filter ? { total: filter.total, sample: (filter.items || []).map((t) => ({ id: t.id, updated: t.updated })) } : null,
      pagination: page ? { total: page.total, page: page.page, per_page: page.per_page, total_pages: page.total_pages } : null,
      trash: trash ? { total: trash.total, items: (trash.items || []).map((t) => ({ id: t.id, deleted_at: t.deleted_at })) } : null,
      errorFormat: errorRaw,
      errorContentType: (read("task-get-404.hdr").match(/^content-type:\s*(.+)$/im) || [])[1] || null,
      tokenPermissions: token ? Object.keys(token.permissions || {}) : []
    };
    const summary = {
      ok: process.env.PROBE_SETUP_OK === "1" && Number(process.env.PROBE_TRANSPORT_ERRORS) === 0 && Number(process.env.PROBE_SERVER_ERRORS) === 0,
      base: process.env.PROBE_BASE,
      syntheticUser: { username: process.env.PROBE_USER, email: process.env.PROBE_EMAIL },
      authFlows: {
        jwt: status("login") === 200,
        apiTokenCreated: status("token-create") === 201,
        apiTokenUsedForProbe: process.env.PROBE_TOKEN_ACTIVE === "1"
      },
      counts: {
        executed: results.length,
        transportErrors: Number(process.env.PROBE_TRANSPORT_ERRORS),
        serverErrors: Number(process.env.PROBE_SERVER_ERRORS)
      },
      findings,
      results
    };
    process.stdout.write(JSON.stringify(summary, null, 2) + "\n");
  ' "$TMP"
}

final_exit() {
  print_summary
  if [ "$SETUP_OK" != "1" ] || [ "$TRANSPORT_ERRORS" -ne 0 ] || [ "$SERVER_ERRORS" -ne 0 ]; then
    exit 1
  fi
  exit 0
}

SUFFIX="$(date +%s)-${RANDOM}${RANDOM}"
PROBE_USERNAME="probe-${SUFFIX}"
PROBE_EMAIL="${PROBE_USERNAME}@example.invalid"
PROBE_PASSWORD="Probe-Passw0rd!"

# --- 1. synthetic user + login -------------------------------------------------
NOTE="synthetic user ${PROBE_USERNAME}"
api register POST "/register" \
  -H 'Content-Type: application/json' \
  --data "{\"username\":\"${PROBE_USERNAME}\",\"email\":\"${PROBE_EMAIL}\",\"password\":\"${PROBE_PASSWORD}\"}"
if [ "$LAST_STATUS" != "201" ]; then
  NOTE="setup failed: cannot register synthetic user"
  final_exit
fi

NOTE="JWT auth"
api login POST "/login" \
  -H 'Content-Type: application/json' \
  --data "{\"username\":\"${PROBE_USERNAME}\",\"password\":\"${PROBE_PASSWORD}\"}"
JWT="$(jget token "$LAST_BODY")"
if [ -z "$JWT" ]; then
  NOTE="setup failed: no JWT from login"
  final_exit
fi
AUTH="$JWT"
SETUP_OK=1

# --- 2. API token: scopes come from /routes -----------------------------------
api routes-get GET "/routes"
node -e '
  const fs = require("fs");
  const routes = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  const permissions = {};
  for (const [group, actions] of Object.entries(routes)) permissions[group] = Object.keys(actions);
  fs.writeFileSync(process.argv[2], JSON.stringify({
    title: "probe-token",
    expires_at: "2027-01-01T00:00:00Z",
    permissions
  }));
' "$LAST_BODY" "$TMP/token-request.json"
NOTE="expires_at required; permissions built from /routes"
api token-create POST "/tokens" \
  -H 'Content-Type: application/json' \
  --data "@$TMP/token-request.json"
TOKEN="$(jget token "$LAST_BODY")"
if [ -n "$TOKEN" ]; then
  AUTH="$TOKEN"
  TOKEN_ACTIVE=1
fi
NOTE="scoped API token: token management is not a /routes permission group"
api tokens-list GET "/tokens?per_page=5"
api info GET "/info"

# --- 3. projects --------------------------------------------------------------
NOTE="title only"
api project-create POST "/projects" \
  -H 'Content-Type: application/json' \
  --data "{\"title\":\"Probe Project ${SUFFIX}\"}"
PID="$(jget id "$LAST_BODY")"
if [ -z "$PID" ]; then
  NOTE="setup failed: no project id"
  final_exit
fi
api projects-list GET "/projects"
api project-tasks-list GET "/projects/${PID}/tasks?per_page=5"

# --- 4. task CRUD -------------------------------------------------------------
api task-create POST "/projects/${PID}/tasks" \
  -H 'Content-Type: application/json' \
  --data '{"title":"probe task one","description":"probe description"}'
T1="$(jget id "$LAST_BODY")"
if [ -z "$T1" ]; then
  NOTE="setup failed: no task id"
  final_exit
fi

api task-get GET "/tasks/${T1}"
ETAG="$(grep -i '^etag:' "$LAST_HDR" | head -n1 | tr -d '\r' | sed 's/^[^:]*: *//')"
NOTE="etag=${ETAG}"

NOTE="matching If-Match on GET"
api task-get-if-match GET "/tasks/${T1}" -H "If-Match: ${ETAG}"
NOTE="stale If-Match on GET"
api task-get-if-match-stale GET "/tasks/${T1}" -H 'If-Match: "stale-etag"'
NOTE="matching If-None-Match on GET"
api task-get-if-none-match GET "/tasks/${T1}" -H "If-None-Match: ${ETAG}"

NOTE="full replace with matching If-Match"
api task-put PUT "/tasks/${T1}" \
  -H 'Content-Type: application/json' -H "If-Match: ${ETAG}" \
  --data "{\"title\":\"probe task one updated\",\"project_id\":${PID}}"
NOTE="stale If-Match on PUT (probe expects 412 if enforced)"
api task-put-stale-if-match PUT "/tasks/${T1}" \
  -H 'Content-Type: application/json' -H 'If-Match: "stale-etag"' \
  --data "{\"title\":\"probe task one stale put\",\"project_id\":${PID}}"
NOTE="stale If-Match on PATCH merge-patch (probe expects 412 if enforced)"
api task-patch-stale-if-match PATCH "/tasks/${T1}" \
  -H 'Content-Type: application/merge-patch+json' -H 'If-Match: "stale-etag"' \
  --data '{"description":"patched"}'

api task2-create POST "/projects/${PID}/tasks" \
  -H 'Content-Type: application/json' \
  --data '{"title":"probe task two"}'
T2="$(jget id "$LAST_BODY")"

# Idempotency-Key replay (two identical creates with the same key)
NOTE="same Idempotency-Key sent twice"
api idem-task-1 POST "/projects/${PID}/tasks" \
  -H 'Content-Type: application/json' -H 'Idempotency-Key: probe-idem-1' \
  --data '{"title":"idem probe"}'
api idem-task-2 POST "/projects/${PID}/tasks" \
  -H 'Content-Type: application/json' -H 'Idempotency-Key: probe-idem-1' \
  --data '{"title":"idem probe"}'

# --- 5. relations -------------------------------------------------------------
NOTE="relation_kind=related, inverse auto-created"
api relation-create POST "/tasks/${T1}/relations" \
  -H 'Content-Type: application/json' \
  --data "{\"other_task_id\":${T2},\"relation_kind\":\"related\"}"

# --- 6. labels ---------------------------------------------------------------
api label-create POST "/labels" \
  -H 'Content-Type: application/json' \
  --data "{\"title\":\"probe-label-${SUFFIX}\",\"hex_color\":\"ff0000\"}"
LID="$(jget id "$LAST_BODY")"
api task-label-add POST "/tasks/${T1}/labels" \
  -H 'Content-Type: application/json' \
  --data "{\"label_id\":${LID}}"
api task-labels-list GET "/tasks/${T1}/labels"

# --- 7. reminders + repeat + time zone ---------------------------------------
NOTE="absolute reminder + repeat_after=3600 repeat_mode=2 + due_date with +09:00 offset"
api task-put-reminder-absolute PUT "/tasks/${T1}" \
  -H 'Content-Type: application/json' \
  --data "{\"title\":\"probe reminder task\",\"project_id\":${PID},\"due_date\":\"2026-12-01T10:00:00+09:00\",\"reminders\":[{\"reminder\":\"2026-11-30T10:00:00+09:00\"}],\"repeat_after\":3600,\"repeat_mode\":2}"
NOTE="relative reminder: relative_period=-3600 relative_to=due_date"
api task-put-reminder-relative PUT "/tasks/${T1}" \
  -H 'Content-Type: application/json' \
  --data "{\"title\":\"probe reminder task\",\"project_id\":${PID},\"due_date\":\"2026-12-01T10:00:00Z\",\"reminders\":[{\"relative_period\":-3600,\"relative_to\":\"due_date\"}],\"repeat_after\":0,\"repeat_mode\":0}"

# --- 8. attachments -----------------------------------------------------------
printf 'hello probe attachment\n' > "$TMP/attachment.txt"
up_status="$(curl -sS -o "$TMP/attachment-upload.body" -D "$TMP/attachment-upload.hdr" -w '%{http_code}' \
  -X POST "$API/tasks/${T1}/attachments" \
  -H "Authorization: Bearer $AUTH" \
  -F "files=@$TMP/attachment.txt;type=text/plain")"
LAST_STATUS="$up_status"; LAST_BODY="$TMP/attachment-upload.body"; LAST_HDR="$TMP/attachment-upload.hdr"
track_status "$up_status"
record attachment-upload POST "/tasks/${T1}/attachments" "$up_status" "multipart field 'files'"
AID="$(jget success.0.id "$LAST_BODY")"
api attachments-list GET "/tasks/${T1}/attachments"
dl_status="$(curl -sS -o "$TMP/attachment-download.bin" -D "$TMP/attachment-download.hdr" -w '%{http_code}' \
  "$API/tasks/${T1}/attachments/${AID}" -H "Authorization: Bearer $AUTH")"
LAST_STATUS="$dl_status"; LAST_BODY="$TMP/attachment-download.bin"; LAST_HDR="$TMP/attachment-download.hdr"
track_status "$dl_status"
ATT_DL_TYPE="$(grep -i '^content-type:' "$LAST_HDR" | head -n1 | tr -d '\r')"
record attachment-download GET "/tasks/${T1}/attachments/${AID}" "$dl_status" "content-type=${ATT_DL_TYPE}"
NOTE=""
api attachment-delete DELETE "/tasks/${T1}/attachments/${AID}"

# --- 9. comments --------------------------------------------------------------
api comment-create POST "/tasks/${T1}/comments" \
  -H 'Content-Type: application/json' \
  --data '{"comment":"probe comment"}'
CID="$(jget id "$LAST_BODY")"
api comments-list GET "/tasks/${T1}/comments"
api comment-update PUT "/tasks/${T1}/comments/${CID}" \
  -H 'Content-Type: application/json' \
  --data '{"comment":"probe comment updated"}'
api comment-delete DELETE "/tasks/${T1}/comments/${CID}"

# --- 10. webhooks -------------------------------------------------------------
api webhook-events-get GET "/webhooks/events"
api webhook-create POST "/projects/${PID}/webhooks" \
  -H 'Content-Type: application/json' \
  --data "{\"target_url\":\"https://example.invalid/probe-${SUFFIX}\",\"events\":[\"task.created\",\"task.updated\"]}"
WID="$(jget id "$LAST_BODY")"
api webhooks-list GET "/projects/${PID}/webhooks"
api webhook-delete DELETE "/projects/${PID}/webhooks/${WID}"

# --- 11. change detection / pagination / error shape --------------------------
FILTER_ENC="$(urlenc 'updated > 2026-01-01T00:00:00Z')"
NOTE="filter=updated > 2026-01-01T00:00:00Z, sort_by=updated, order_by=desc"
api tasks-filter-updated GET "/tasks?filter=${FILTER_ENC}&sort_by=updated&order_by=desc&per_page=2"
api tasks-pagination GET "/tasks?page=1&per_page=1"
NOTE="unknown task id"
api task-get-404 GET "/tasks/999999999"
ERROR_CT="$(grep -i '^content-type:' "$LAST_HDR" | head -n1 | tr -d '\r')"
NOTE=""

# --- 12. soft delete / trash / restore ---------------------------------------
api task-delete DELETE "/tasks/${T2}"
api task-get-deleted GET "/tasks/${T2}"
api tasks-trash-list GET "/tasks/deleted?per_page=5"
api task-restore POST "/tasks/${T2}/restore"

# --- 13. project soft delete --------------------------------------------------
api project-delete DELETE "/projects/${PID}"
api projects-trash-list GET "/projects/deleted?per_page=5"

final_exit
