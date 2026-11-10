#!/usr/bin/env bash
# Orchestrator-only helper. Starts a supervised DeepSeek (OpenCode v1) worker for an existing Orca Task.
# Why: Orca 1.4.255 launches `opencode` with XDG_DATA_HOME/OPENCODE_DB pointing at the Orca-managed
# account dir, whose DB was migrated to the v2 schema by opencode2 -> v1 fails
# ("Database is not empty and has no session table"). opencode2 ignores repo opencode.jsonc and fell back
# to a free model, so it is not an acceptable substitute. We unset only those overrides so v1 uses the
# host data dir (~/.local/share/opencode, with OpenCode Go auth) and repo opencode.jsonc pins
# opencode-go/deepseek-v4.1-flash variant high.
# After worker_done, verify the session: (cd <wt> && opencode session list) + opencode export <id> -> variant must be "high".
# Usage: start-deepseek-worker.sh <task_id> <worktree-name> [--retry-of <dispatch_id>]
set -euo pipefail
TASK="$1"; NAME="$2"; shift 2
EXTRA=("$@")
WT_JSON=$(orca worktree create --name "$NAME" --parent-worktree active --base-branch "${BASE_REF:-torgal/ohmydate}" --setup skip --json)
WT_ID=$(printf '%s' "$WT_JSON" | python3 -I -c 'import json,sys;d=json.load(sys.stdin)["result"];w=d.get("worktree",d);print(w["id"])')
WT_PATH=${WT_ID#*::}
# Guard: the binding config must be present in the worker checkout (new worktrees once defaulted to the initial commit).
test -f "$WT_PATH/opencode.jsonc" || { echo "opencode.jsonc missing in $WT_PATH (wrong base?)" >&2; exit 2; }
TERM_JSON=$(orca terminal create --worktree "id:$WT_ID" --title "$NAME" \
  --command "env -u XDG_DATA_HOME -u XDG_STATE_HOME -u OPENCODE_DB -u OPENCODE_AUTH_CONTENT opencode -m opencode-go/deepseek-v4.1-flash" --json)
H=$(printf '%s' "$TERM_JSON" | python3 -I -c 'import json,sys;print(json.load(sys.stdin)["result"]["terminal"]["handle"])')
orca terminal wait --terminal "$H" --for tui-idle --timeout-ms 60000 --json >/dev/null
orca orchestration worker-start --task "$TASK" --terminal "$H" --worktree "id:$WT_ID" "${EXTRA[@]}" --json
