# M6-03 report — Notes UI, RelatedNotes, wizard evidence, E2E-6 notes flow

- taskId: task_094ae0f54f49 · dispatchId: ctx_b426e7c8c2a0
- worktree: /home/torgal/orca/workspaces/oh_my_date/m6-03-notes-ui · branch: torgal/m6-03-notes-ui (not pushed)
- base: a2023ad · HEAD: f41d4afd74fc5d6709d346b91d599c843a524d83
- commits:
  - 16b5fbc feat(api): E2E-only LLM_FAKE_SCENARIO=e2e-grounded fake for note-grounded intake
  - d1ff400 feat(web): notes workspace with safe Markdown preview, links and AI usage history
  - 5875c07 test(web): notes workspace, links, promote, wizard evidence and RelatedNotes
  - b7bc6f7 fix(api): scope LLM_FAKE_SCENARIO to listed owners (LLM_FAKE_SCENARIO_OWNERS)
  - 5e8ee24 perf(web): load the notes workspace on demand; summaries skip a repeated title
  - f41d4af test(e2e): E2E-6 notes flow on the real stack, notes axe sweep and M6-03 screenshots

## Scope amendment (coordinator msg_c100877aa867), as implemented

- `services/api/src/config.ts`: `LLM_FAKE_SCENARIO=e2e-grounded`. It is refused at boot for an unknown name, with
  `LLM_PROVIDER` other than fake, or under `NODE_ENV=production`. `app.ts` has wiring only: 4 lines in `createConfiguredLlm`,
  plus a throw if a scenario is set without the fake provider.
- `services/api/src/adapters/fake-llm-scenarios.ts`: for `decomposition@v2` it builds a schema-valid output from the request
  input: steps from the intake title, one fact citing the first `<untrusted_document>` note block, one inference with a
  planted link, and one forged ref. The real grounded sanitiser strips the forged ref (`hallucinated_ref`) and the link
  (`[link removed]`). All other prompts keep FakeLlm behaviour.
- Two deviations, each needed to make it work, both inside the approved files:
  1. It also answers `type_detection@v1` (a schema-valid "new" classification, no reasons). With the plain fake, detection
     fails, the session turns manual, and decomposition never calls the LLM, so the grounded path could not run at all.
  2. `LLM_FAKE_SCENARIO_OWNERS` (comma-separated owner ids, validated, refused without a scenario) limits the scenario to
     the E2E notes owner. Unscoped, the answered type detection changed the wizard timing for every suite, and E2E-2's
     existing skip loop raced a disappearing question card (it failed twice). With the scope, every other owner and suite
     gets exactly the previous plain fake. I did not edit E2E-2.
- Tests in `services/api/test/fake-llm-scenarios.test.ts` (8, including negatives):
  - boot refusal: production, deepseek and unknown names;
  - owner-scope parsing;
  - both outputs validate against `llm.type_detection.v1` and `llm.decomposition.v2`;
  - the sanitiser strips the forged ref and the link;
  - other prompts and out-of-scope owners still get `LlmUnavailable`;
  - real PostgreSQL + `buildApp` pipeline: a goal-linked, llm_allowed note yields fact + inference evidence and one
    succeeded AI-usage row with the same section hash.

## Changed paths (git diff --name-only a2023ad...HEAD)

- services/api: `src/config.ts`, `src/app.ts`, `src/adapters/fake-llm-scenarios.ts` (new), `test/fake-llm-scenarios.test.ts` (new)
- apps/web: `package.json` (markdown-it 15.0.3), `App.vue`, `router.ts`, `api/client.ts`, `api/index.ts`, NavRail, BottomNav,
  TaskItem, `layout/AdaptiveFrame.vue`, `layout/RelatedNotesPanel.vue`, `components/notes/*` (new: EvidenceList, LinkPickerDialog,
  LinkedNotesList, MarkdownView, NoteAiUsage, NoteConfirmDialog, NoteConflictDialog, NoteEditor, NoteLinks, WizardNotesPanel,
  markdown.ts, summary.ts), `ui/icons.ts`, `composables/{notes,relatedNotes,useMediaQuery}.ts` (new), `i18n/messages/ko.ts`,
  `mocks/{browser,db,intake-handlers,server}.ts`, `mocks/{notes,notes-seed}.ts` (new), `styles/screens.css`,
  `views/{NotesView,TaskDetailView}.vue` (new), `views/NotesPlaceholderView.vue` (deleted), `views/{PlanningWizardView,ProjectDetailView}.vue`,
  `scripts/ui-screenshots.mjs`, `docs/ui-polish/README.md`, `docs/ui-polish/m6-03/*` (34 PNGs + sweep-report.json),
  `test/m6-03-{markdown,notes,notes-links}.spec.ts`, `test/m6-03-notes-utils.ts`
- e2e: `global-setup.ts`, `helpers/state.ts`, `tests/e2e-6-notes.spec.ts` (new), `README.md`
- pnpm-lock.yaml: only the `apps/web` importer entry `markdown-it 15.0.3` and its own transitive dependencies: argparse 3.0.4,
  entities 8.1.0, linkify-it 6.1.0, mdurl 2.1.0, punycode.js 2.3.1, uc.micro 3.0.0.
- 89 files changed, +8236 / −61.

## Diff summary

- `/notes`, `/notes/new` and `/notes/:id` are one lazily loaded `NotesView` (page `NotesWorkspace`). It has a searchable, paged
  list beside the editor on desktop; on mobile, list and note are separate steps. Notes routes use the stacked frame variant.
- NoteEditor:
  - title, and the body with edit/preview/split (desktop) or edit/preview (mobile);
  - P1/P2, and the "AI에 보내기 허용" switch, default off, explaining what is sent and that masking is best-effort;
  - saves with If-Match + a UUIDv7 Idempotency-Key; a 412 opens a dialog (reload / keep mine as a copy / keep editing);
  - confirmed soft delete, a 65,536 code-point counter, an unsaved-changes guard, Ctrl/⌘+S, and an aria-live save status.
- Preview: markdown-it parses with html, linkify and typographer off, and the tokens go to Vue VNodes through an allowlist, with
  no v-html or innerHTML. http(s)/mailto links are text, then the visible address, then a separate "열기" link
  (`rel="noopener noreferrer nofollow"`, `target="_blank"`, `referrerpolicy="no-referrer"`); other schemes are never anchors.
  Images are never loaded (alt text + address shown as text). Headings are demoted two levels. Past markdown-it's nesting
  limit the note is shown verbatim, because markdown-it would silently drop that text (found by a test).
- Links: a project/task picker; goal links are shown and can be unlinked. If-Match is the note version, and unsaved text is
  kept across the version bump. The AI usage history shows purpose, status, time, sections and hashes, bytes, version and
  stale, never text.
- Project 노트 tab (ARIA tablist, `?tab=notes`). A new task detail at `/tasks/:id` (opened from the task title) shows the
  description as text only and offers "설명을 노트로 승격" (If-Match on the task version); a 409 opens the existing promoted
  note, and 412/422 are explained.
- Wizard: "이 계획에 참고할 노트" links notes to the session goal, the only grounding target, and says which notes may be sent.
  The draft step shows evidence as 사실/추론 badges, statement as text, source title + 구간 #hash, the note time, "그 뒤
  노트가 수정됐어요", the related steps and 노트 열기. The draft-edit comparison now ignores server-only evidence.
- RelatedNotes{limit}: context is the focus/running session's task and its project, else the planning goal, else the open
  note's targets (itself excluded), else the next Today block's task and its project. It shows titles only, at most `limit`,
  newest first, with an empty state.
- Owner scope (ADR-023): all note cache keys start with the owner, and every async write captures the OwnerBinding and drops
  its continuation after an owner change.

## Requirement checklist

1. Notes workspace: list / search (server q) / paging / empty / loading / error / offline, the editor with edit/preview/split
   and mobile tabs, P1/P2, llm_allowed with its explanation (default off), If-Match + Idem save, 412 conflict (reload /
   keep mine as a copy), soft delete with confirm, the 65,536 counter — **met**
2. Links goal/project/task (project and task via the picker; goal via the wizard, since there is no goal list endpoint, as
   agreed), unlink, the Project 노트 tab, task detail linked notes, promote with 409 → open existing — **met**
3. AI usage history per note (run, time, hashes, never text); wizard evidence (fact/inference, source title + section,
   updatedAt, note link) — **met**
4. RelatedNotes{limit} panel (focus/adaptive), max limit, empty state — **met**
5. ko catalog, Intl formatters, a11y (labels, focus, aria-live, keyboard), mobile + desktop, owner-scoped caches + OwnerBinding
   on every write — **met**
6. Component tests (XSS negatives, save/412/409/delete, links, promote, AI usage, wizard evidence, RelatedNotes, owner-change
   drops) with MSW fixtures; E2E-6 on the real API with the real grounded pipeline; axe on the notes screens (0
   critical/serious); screenshots in `apps/web/docs/ui-polish/m6-03/` — **met**

## Tests (real exit codes)

All with `DATABASE_URL=postgres://ohmydate:ohmydate-dev-only@127.0.0.1:55432/planner_test VIKUNJA_URL=http://127.0.0.1:3456`.

- `pnpm --filter @ohmydate/web test` → exit 0 — Test Files 45 passed (45), Tests 402 passed (402)
- `pnpm --filter @ohmydate/web build` → exit 0 — index 637.17 kB (gzip 186.57), NotesView chunk 146.19 kB (gzip 55.50); the
  existing >500 kB chunk advisory remains
- `pnpm run ci` → exit 0 on the 3rd run — root vitest 163 files passed, 2007 passed | 29 skipped; web 402/402; Boundary check
  0 violations; build-smoke `/healthz` 200
  - Runs 1 and 2 exited 1 only on scheduler property-test timeouts (`packages/scheduler/test/fu41.test.ts` 180 s, and in run 1
    also `generate.property.test.ts` 240 s). Load average was 20–30 on 20 cores from other workers. Both pass alone (13/13,
    122 s). There are no changes under `packages/` on this branch.
- `pnpm run e2e` → exit 0 — 27 passed (7.7 m): E2E-1..5R, E2E-6 layout, E2E-6 notes ×2, a11y screens, plan-edit helpers
  - An earlier full run had E2E-2 failing; diagnosed as the unscoped scenario (deviation 2 above) and fixed by b7bc6f7.
- Also run: `fake-llm-scenarios.test.ts` + `config.test.ts` → 19 passed; services/api tsc clean; eslint clean.
- Screenshots: `node scripts/ui-screenshots.mjs --label m6-03 --flows notes` → 60 visits, 0 with overflow or critical/serious
  axe violations.

## Risks / unverified / follow-ups

- Dependency licences: markdown-it is MIT. Its transitive dependency argparse 3.0.4 is PSF-2.0; it is used only by markdown-it's
  CLI and is not in the web bundle, and the repo already has argparse 2.0.1. entities is BSD-2-Clause; the rest are MIT.
- Goals have no list endpoint, so the notes editor picker offers only projects and tasks. Goal links come from the wizard and
  show a name only when that planning session is cached on the device. A future `GET /goals` would allow a goal picker.
- `Task.description` from Vikunja is shown as text through an inert DOMParser. Promotion's HTML→Markdown conversion is the
  server's (M6-01).
- RelatedNotes on Today adds one `GET /tasks/{id}` and up to 2 `GET /documents` per context change (60 s cache for the task).
- The link picker loads up to 500 projects and 500 tasks (5 pages × 100); fine for a personal planner, not for huge accounts.
- No new contracts were needed; the generated API client is unchanged (check:api-client clean).
- Rollback: delete branch `torgal/m6-03-notes-ui` (nothing pushed).
