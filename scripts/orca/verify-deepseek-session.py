#!/usr/bin/env python3
"""Orchestrator check: every assistant message of OpenCode v1 sessions run in <worktree> used
opencode-go/deepseek-v4.1-flash with variant high. Reads the host OpenCode DB read-only."""
import json, os, sqlite3, sys
wt = os.path.abspath(sys.argv[1])
db = os.path.expanduser("~/.local/share/opencode/opencode.db")
c = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
sess = [r[0] for r in c.execute("select id from session where directory = ?", (wt,))]
seen = {}
for s in sess:
    for (data,) in c.execute("select data from message where session_id = ?", (s,)):
        d = json.loads(data)
        if d.get("role") != "assistant":
            continue
        k = (d.get("providerID"), d.get("modelID"), d.get("variant"))
        seen[k] = seen.get(k, 0) + 1
ok = bool(seen) and set(seen) == {("opencode-go", "deepseek-v4.1-flash", "high")}
print(json.dumps({"worktree": wt, "sessions": sess, "assistantMessages": {"/".join(map(str, k)): v for k, v in seen.items()}, "ok": ok}))
sys.exit(0 if ok else 1)
