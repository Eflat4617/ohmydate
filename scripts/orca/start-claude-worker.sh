#!/usr/bin/env bash
# Orchestrator-only: start a Claude implementation worker (default Opus 5.5 xhigh, MODEL_BINDINGS §8/§9;
# MODEL=claude-fable-5-2 EFFORT=medium for breakthrough work, §10)
# in a NEW child worktree based on BASE_REF (default torgal/ohmydate).
# Usage: start-claude-worker.sh <task_id> <worktree-name>
set -euo pipefail
TASK="$1"; NAME="$2"
REPO_ID="dde48ef6-62e6-4539-9044-749943edc800"
orca worktree create --name "$NAME" --parent-worktree active --base-branch "${BASE_REF:-torgal/ohmydate}" --setup skip --json >/dev/null
WT_ID="$REPO_ID::/home/torgal/orca/workspaces/oh_my_date/$NAME"
orca orchestration worker-start --task "$TASK" --worktree "id:$WT_ID" --agent claude --model "${MODEL:-claude-opus-5-5}" --effort "${EFFORT:-xhigh}" --json
