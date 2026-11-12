# TASK PACKET: GU-1-GUIDE — Korean user guide for the GU-1 local try-out
Role: worker (Opus 5.5 xhigh — Korean UX writing that must match the real screens). Base: torgal/ohmydate HEAD (GU-1-PKG merged 06e686c).
Context: GU-1 (docs/blueprint/13-ADR.md, ADR-022, GD-3): the user (a Korean-speaking developer, owner of this laptop) will try OhMyDate locally with their own data before M7. They need ONE Korean guide that takes them from zero to daily use and tells them what to look at and how to report feedback. The coordinator will run the real stack and the real DeepSeek path; you write and verify against the UI.
Read: deploy/local/README.md and scripts/local/*.mjs (exact commands, Korean messages, flags), package.json local:* scripts; apps/web/src/views/*.vue + apps/web/src/i18n/messages/ko.ts (exact Korean labels — the guide must quote what the screens really say); apps/web/src/views/LlmSettingsView.vue + components/LlmConsentDialog.vue (AI consent + budget; defaults daily $0.2 / monthly $5 from services/api/src/config.ts); docs/blueprint/01 (product goals), 05 (what is sent to the LLM; privacy redaction in packages/llm/src/privacy.ts; notes grounding), 06 (planning/scheduler behaviour in user terms), 07 (adaptive UI), 08 §2.5.1 (block lock), 09 (local security notes); e2e/tests/*.spec.ts (the real user journeys E2E-1..6 — use them as the walkthrough backbone).


You are a supervised Orca worker on project OhMyDate. Your Task ID and Dispatch ID are in the Orca preamble.
RULES
1. Edit ONLY the "allowed paths" of this packet. Anything else: run `orca orchestration ask` and end your turn.
2. Never: sudo, global installs (npm -g, corepack enable), docker, git push, git rebase of shared branches,
   editing tests to make them pass, deleting tests, starting sub-workers, reading/writing outside your worktree,
   printing or storing secrets, calling paid external APIs other than your own model.
3. Commit your work on your branch with Conventional Commits; include "Task: <taskId>" in the body.
4. Run every command in "Exact tests" and paste the real exit codes and tail output. Never claim a test passed
   that you did not run. If you could not run something, say SKIPPED + reason.
5. Send heartbeat if Orca's preamble asks for it.
6. Finish with EXACTLY ONE:
   orca orchestration send --type worker_done --subject "<taskId> done" --task-id <taskId> --dispatch-id <dispatchId> \
     --outcome succeeded|failed --files-modified "<csv>" --body "<report>" --json
   (if your Orca preamble gives a different exact worker_done form, the preamble wins)
REPORT (body)
- taskId, dispatchId, worktree path, branch, commit SHA(s)
- changed paths (git diff --name-only <base>...HEAD) and 3–8 line diff summary
- requirement checklist: each acceptance item -> met / not met
- tests: command -> exit code -> key output lines
- risks, unverified items, new contracts needed by dependents, rollback method

HOST LOAD RULE: you only need the web dev server in mock mode (`VITE_MOCK=1 corepack pnpm --filter @ohmydate/web dev` on a free 127.0.0.1 port) to check labels/flows; stop it when done. No full ci needed (docs only) — run `pnpm run lint` if you touch anything lintable. Never read deploy/secrets/** or *api_key*, never run docker/sudo, never call the LLM gateway.

ALLOWED PATHS: docs/user/** (new), deploy/local/README.md (one link line to the guide only).
REQUIRED — write docs/user/GU-1-사용안내.md (Korean, clear headings, copy-pasteable commands, no secrets):
1) 개요: what OhMyDate does (adaptive AI planner on top of Vikunja), what GU-1 is for, what is in/out of scope now (M7 Native backend not yet), where data lives (local only, 127.0.0.1; Postgres + Vikunja volumes; deploy/secrets/local + volumes are a pair → back them up together; how to back up).
2) 처음 설치: exact order with the real commands: `corepack pnpm local:secrets` → `corepack pnpm local:stack up` (asks for the sudo password) → `corepack pnpm local:setup` (email/password, time zone default Asia/Seoul) → `corepack pnpm local:start` → open http://127.0.0.1:5180/ ; DeepSeek key file location/permission (`chmod 600`, path via deploy/local/local.env LLM_API_KEY_FILE; never paste the key anywhere); what each step prints when it works and the 3–5 most likely errors with the fix (stack down, key file mode, port in use, stale build → local:stop then local:start).
3) 매일 쓰기: local:status / local:stop / local:start, after a reboot (the stack restarts by itself; just local:start), updating after new code (local:stop → local:start rebuilds).
4) AI 사용 동의와 비용: the consent dialog (what it says, what is sent — redacted task/goal text and selected note excerpts, not passwords/secrets; Korean PII redaction), budget defaults and where to change them (LLM settings screen), what happens without consent or over budget (manual mode / Korean fallback draft), typical cost per decomposition (~$0.002–0.003, measured by the coordinator).
5) 둘러보기 (walkthrough mirroring E2E-1..6 with the real Korean labels): inbox capture → intake interview (questions, skip/모름) → AI decomposition draft → edit/approve → availability & commitments → plan candidates (diversity note) → approve plan → Today (start/finish/shrink/reschedule, focus mode) → block lock ("블록 고정", aria-pressed) → replan proposals (approve/reject, suppression) → notes and note-grounded decomposition → adaptive layout/patterns/settings. Keep each step short: where to click, what to expect, what to judge.
6) 피드백 방법: a short checklist of what the user should evaluate (planning quality, estimates, Korean wording, speed, AI usefulness, anything confusing) and a simple template to send back (date, screen, what you did, expected vs actual, screenshot optional — never include secrets).
7) 알려진 제한 (honest): GU-1 scope, Secure cookies on http://127.0.0.1 (Chrome/Firefox fine; Safari/WebKit not), Vikunja UI at http://127.0.0.1:3466 is optional and its account is created by setup, token lifetime 365 days and how to rotate (`local:setup --rotate-token`), registration open only on loopback, open follow-ups that affect the try-out (the coordinator will fill the exact list at merge — leave a short placeholder section titled "현재 알려진 이슈").
Verify every label/message you quote against ko.ts or the script source; list in the report any label you could not verify. Commit (Task trailer), clean git status, worker_done.
Retry limit 2. Rollback: delete branch.
