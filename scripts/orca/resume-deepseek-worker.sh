#!/usr/bin/env bash
# Orchestrator-only: (re)start a DeepSeek OpenCode v1 worker for an existing Task in an EXISTING worktree
# (e.g. after a reboot abandoned the dispatch). Same env workaround as start-deepseek-worker.sh.
# Usage: resume-deepseek-worker.sh <task_id> <worktree-dir-name>
set -euo pipefail
TASK="$1"; NAME="$2"
WT_ID="dde48ef6-62e6-4539-9044-749943edc800::/home/torgal/orca/workspaces/oh_my_date/$NAME"
test -f "/home/torgal/orca/workspaces/oh_my_date/$NAME/opencode.jsonc" || { echo "opencode.jsonc missing" >&2; exit 2; }
H=$(orca terminal create --worktree "id:$WT_ID" --title "$NAME" \
  --command "env -u XDG_DATA_HOME -u XDG_STATE_HOME -u OPENCODE_DB -u OPENCODE_AUTH_CONTENT opencode -m opencode-go/deepseek-v4.1-flash" --json \
  | python3 -I -c 'import json,sys;print(json.load(sys.stdin)["result"]["terminal"]["handle"])')
orca terminal wait --terminal "$H" --for tui-idle --timeout-ms 60000 --json >/dev/null
orca orchestration worker-start --task "$TASK" --terminal "$H" --worktree "id:$WT_ID" --json
