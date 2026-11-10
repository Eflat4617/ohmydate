# Vikunja v2.8.0 — API v2 capability probe

- Probe date: 2026-11-11 (server clock 2026-11-10T16:54Z)
- Instance: `http://127.0.0.1:3456` (`GET /api/v2/info` → `version: "v2.8.0"`)
- Method: live probe with a synthetic user (`probe-<epoch>-<rand>@example.invalid`), a JWT
  session and a scoped API token. No upstream source was modified; no production data
  was read or written.
- Probe script: `scripts/probe/vikunja/probe.sh` (`bash scripts/probe/vikunja/probe.sh --check`)
- Probe result: 47 calls executed, 0 transport errors, 0 server (5xx) errors, `ok:true`,
  `incomplete:false`, exit 0. A missing feature is recorded as an observation; a
  register/login/project/task prerequisite failure instead yields `ok:false` +
  `incomplete:true` and a non-zero exit.
- Negative self-test: `bash scripts/probe/vikunja/probe.sh --self-test` starts a local
  node HTTP fixture on a random `127.0.0.1` port that returns `403` for
  `POST /api/v2/projects`; the child probe reports `ok:false` + `incomplete:true` and
  exits 1, proving the prerequisite-failure path (the wrapper mirrors that non-zero exit).
  Full machine-readable output is the JSON summary printed by the script.

## OpenAPI artifact

| Item | Value |
|---|---|
| Source | `GET http://127.0.0.1:3456/api/v2/openapi.json` (HTTP 200) |
| Local file | `docs/blueprint/vendor/vikunja-v2.8.0-openapi.json` |
| SHA-256 | `49a74af7e76501af001c4faa6bd2e2077debef773981a12599f4be16c049fd85` |
| Size | 600251 bytes (byte-exact download) |
| Spec | OpenAPI `3.1.0`, title `Vikunja API v2.8.0` |
| Paths | 146 |

## Authentication bootstrap (observed)

1. `POST /api/v2/register` with `{username,email,password}` → `201` + `User`. An
   `@example.invalid` address is accepted. Auth routes are rate-limited
   (`X-Ratelimit-Limit: 10` in the probe window).
2. `POST /api/v2/login` with `{username,password}` → `200` + `{token: <JWT>}`.
3. `GET /api/v2/routes` returns the authoritative permission catalogue
   (group → action → route). It is used to build the API-token permission map.
4. `POST /api/v2/tokens` with `{title, expires_at, permissions}` → `201` +
   `APIToken` including the cleartext `tk_…` token **once**. `expires_at` is
   mandatory (missing → `422`, `code: 2002`); permission groups must be real
   `/routes` groups (`"*"` → `400`, `code: 14002`). The scoped token authenticates
   as `Authorization: Bearer tk_…`.
5. Both JWT and API token are accepted on entity routes. A scoped API token could
   **not** call `GET /api/v2/tokens` (`401`, code 11) or `GET /api/v2/user/timezones`
   (`401`); those need a JWT/session.

## Capability matrix

| Feature | v2 path + method (or absent) | Key request / response fields | ETag / If-Match behaviour | Observed status codes | Notes |
|---|---|---|---|---|---|
| Instance info | `GET /api/v2/info` | resp: `version`, `max_items_per_page` (50), `task_attachments_enabled`, `webhooks_enabled`, `concurrent_writes`, `auth.local.registration_enabled` | n/a | 200 | Public (no auth). |
| Register | `POST /api/v2/register` | req: `username` (3–250), `email`, `password` (8–72), optional `language`, `invite_token`; resp: `User{id,username,name,created,updated}` | n/a | 201; 400/422 invalid | Synthetic `.invalid` mail accepted; ids are numeric `int64`. |
| Login | `POST /api/v2/login` | req: `username`, `password`, optional `long_token`, `totp_passcode`; resp: `{token: JWT}` | n/a | 200 | `Cache-Control: no-store`; refresh cookies set for v1 and v2 paths. |
| API token create | `POST /api/v2/tokens` | req: `title`, `expires_at` (non-zero), `permissions: {group:[action,…]}`, optional `owner_id`; resp: `APIToken` + one-time `token` | n/a | 201; 422 `code:2002`; 400 `code:14002` | Explicit scope map only; `"*"` group rejected. `TokenPresets` schema exists but no route references it. |
| API token list | `GET /api/v2/tokens` | `page`, `per_page`, `q`, `owner_id`; resp: `PaginatedAPIToken` | n/a | 200 with JWT; 401 with scoped token | Token management is not a `/routes` permission group. |
| Projects CRUD | `GET/POST /api/v2/projects`, `GET/PUT/PATCH/DELETE /api/v2/projects/{id}` | req: `title` (1–250), `description`, `identifier`, `hex_color`, `parent_project_id`, `is_archived`; resp: `Project` incl. `owner`, `views`, `max_permission` | No ETag/conditional params on writes; none enforced | 200, 201, 204 | New user gets `Inbox`; `/projects` also returns virtual `id:-4 "My Open Tasks"`. |
| Project trash | `GET /api/v2/projects/deleted`, `POST /api/v2/projects/{id}/restore`, `DELETE /api/v2/projects/{id}/permanent` | `deleted_at`, `deleted_by`; trash envelope | none | 200, 204 | `DELETE /projects/{id}` → 204 soft delete (30-day retention). |
| Task create | `POST /api/v2/projects/{project}/tasks` | req: `Task` fields (`title` min 1; `description`, dates, reminders, repeat, labels/assignees read-only); `project_id` comes from URL; resp: `Task` | n/a | 201 | Create response can have `created_by:null`, zeroed `created` for some fields. |
| Task list | `GET /api/v2/tasks`, `GET /api/v2/projects/{project}/tasks` | query: `page`, `per_page` (≤50), `q`, `filter`, `filter_timezone`, `filter_include_nulls`, `sort_by`, `order_by`, `expand`, `format`; resp: `PaginatedTask` | none on list | 200 | Envelope: `{items,total,page,per_page,total_pages}`. |
| Task get | `GET /api/v2/tasks/{task}` | resp: `TaskReadOneBody` + response header `ETag` | ETag opaque e.g. `"1794329691000000000-2"`, `Cache-Control: no-store`. Matching `If-Match` → 200; **stale `If-Match` → 304** (non-standard); matching `If-None-Match` → 304; stale `If-None-Match` → 200 | 200, 304 | `expand` supports `subtasks,buckets,reactions,comments,comment_count,time_entries_count,is_unread`. |
| Task update | `PUT /api/v2/tasks/{task}` (full replace), `PATCH /api/v2/tasks/{task}` (`application/json-patch+json`, `application/merge-patch+json`, `application/merge-patch+shorthand`) | req: `TaskReadOneBody` / patch doc; resp: `Task` | **Provider-side atomic CAS is unsupported**: stale `If-Match` is accepted on PUT (200), PATCH (200) and even DELETE (204); no 412/428; no `version` field in the payload | 200 (write), 204 (delete) | The single biggest gap for `update(expectedVersion)`; application-level serialization is required. |
| Task delete / trash | `DELETE /api/v2/tasks/{task}`, `GET /api/v2/tasks/deleted`, `POST /api/v2/tasks/{task}/restore`, `DELETE /api/v2/tasks/{task}/permanent` | `deleted_at`, `deleted_by`, `can_delete_permanently`; trash envelope | none | 204; 404 `code:4040`; 200; 204 | `DELETE` is a soft delete (30 days). GET after delete → 404 `"This task is in the trash."` with `details`. |
| Labels | `GET/POST /api/v2/labels`, `GET/PATCH/PUT/DELETE /api/v2/labels/{id}`, `GET/POST /api/v2/tasks/{task}/labels`, `DELETE /api/v2/tasks/{task}/labels/{label}`, `POST /api/v2/tasks/{task}/labels/bulk` | `Label{title,hex_color,description}`; `LabelTask{label_id}`; bulk body is the complete label set | none | 201, 200, 204 | `task.labels` is read-only on Task; manage via these routes. |
| Relations | `POST /api/v2/tasks/{task}/relations`, `DELETE /api/v2/tasks/{task}/relations/{relationKind}/{otherTask}` — **no GET relations route** | req: `{other_task_id, relation_kind}`; resp: `TaskRelation{task_id,other_task_id,relation_kind,created,created_by}`; inverse relation auto-created | none | 201, 204 | Read relations from `task.related_tasks` (grouped by kind). |
| Reminders | Task field `reminders[]` via PUT/PATCH | each: `reminder` (date-time), `relative_period` (int64 seconds), `relative_to` (string, e.g. `due_date`) | none | 200 | Absolute reminder returned verbatim; relative reminder is resolved server-side (`due_date -3600s` → absolute `reminder`), with `relative_period`/`relative_to` retained. |
| Repeat | Task fields `repeat_after` (seconds), `repeat_mode` | `repeat_mode`: `0` = after `repeat_after` seconds, `1` = monthly (ignores `repeat_after`), `2` = from current date rather than last set date | none | 200 | On completion a repeating task is re-opened and due date/reminders bumped automatically. |
| Attachments | `GET/POST /api/v2/tasks/{task}/attachments`, `GET/DELETE /api/v2/tasks/{task}/attachments/{attachment}` (plus `/preview`) | POST `multipart/form-data` with required repeated field **`files`**; resp: `AttachmentUploadResult{success:[TaskAttachment],errors}`; `TaskAttachment.file{name,mime,size}` | none | 201, 200, 204 | `max_file_size` = 20MB; download returns original bytes with `Content-Disposition`/`Content-Type`. |
| Comments | `GET/POST /api/v2/tasks/{task}/comments`, `GET/PUT/PATCH/DELETE /api/v2/tasks/{task}/comments/{commentid}` | `TaskComment{comment (HTML), author (read-only), created, updated, reactions}` | none | 201, 200, 204 | `PUT` response zeroes `author`/`created`; use GET afterwards. |
| Webhooks (v2) | `GET/POST /api/v2/projects/{project}/webhooks`, `PUT/DELETE /api/v2/projects/{project}/webhooks/{webhook}`, `GET /api/v2/webhooks/events` | req: `target_url`, `events[]`, optional `secret`, `basic_auth_user/password`; resp: `Webhook{id,project_id,user_id,target_url,events,created_by}` | none | 200, 201, 204 | **v2 paths exist**; `https://example.invalid/...` target accepted. Schema description stale-references `/api/v1/webhooks/events`. |
| Change detection | `GET /api/v2/tasks?filter=updated > <timestamp>&sort_by=updated&order_by=desc` (also project-scoped) | filter DSL: `=, !=, >, >=, <, <=, like, in, not in`, combine with `&&`/`||`; `sort_by`/`order_by` repeatable | none | 200 | Works, but list `updated` values have **second precision** and deleted tasks are excluded (see trash). |
| Pagination | `page`, `per_page` on all collection routes | `Paginated*{items,total,page,per_page,total_pages}` | n/a | 200 | `per_page` max 50 (`info.max_items_per_page`); page-based, no cursor. |
| Time zones | `date-time` fields on Task/Project/etc.; `GET /api/v2/user/timezones` | `due_date`/`reminder` accept and return RFC 3339 with offsets; `created`/`updated` are UTC `Z` | n/a | 200 (JWT); 401 (scoped token) | Server preserved `+09:00` verbatim rather than normalising to UTC. `/user/timezones` returns IANA names but is JWT-only. |
| Error format | all routes (`default` response) | `application/problem+json`; `VikunjaErrorModel{type,title,status,detail,code,errors[{location,message,value}],i18n_params,details,instance}` | n/a | 400, 401, 404, 422 | Numeric `code` is the stable discriminator (`4002` task not found, `4040` task in trash, `2002` validation, `14002` bad token permission). |
| Idempotency | **absent from the spec** | `Idempotency-Key` request header | n/a | two `201`s, different ids | Header is ignored; replay creates duplicates. |

### Task relation kinds (complete enum from the spec)

`subtask`, `parenttask`, `related`, `duplicateof`, `duplicates`, `blocking`,
`blocked`, `precedes`, `follows`, `copiedfrom`, `copiedto`.

The inverse relation is created automatically. Relations can only be created and
deleted; there is no `GET /tasks/{task}/relations` route (read `related_tasks` on
the task).

### Webhook events

`GET /api/v2/webhooks/events` (project-directed webhooks) returns 23 events:

```
project.deleted, project.purged, project.restored, project.shared.team,
project.shared.user, project.updated, task.assignee.created,
task.assignee.deleted, task.attachment.created, task.attachment.deleted,
task.comment.created, task.comment.deleted, task.comment.edited,
task.created, task.deleted, task.overdue, task.purged, task.relation.created,
task.relation.deleted, task.reminder.fired, task.restored, task.updated,
tasks.overdue
```

`GET /api/v2/user/settings/webhooks/events` (user-directed webhooks, JWT only)
returns `task.overdue`, `task.reminder.fired`, `tasks.overdue`.

### API token scopes / permissions (`GET /api/v2/routes`)

| Group | Actions |
|---|---|
| `caldav` | access |
| `feeds` | access |
| `filters` | create, delete, read_one, update |
| `labels` | create, delete, read_all, read_one, update |
| `mcp` | access |
| `migration` | csv_detect, csv_migrate, csv_preview, csv_status, planka_migrate, planka_status, ticktick_migrate, ticktick_status, vikunja_file_migrate, vikunja_file_status, wekan_migrate, wekan_status |
| `notifications` | delete, mark_all_as_read, read_all, update |
| `other` | avatar, logout, routes, user, users, ws |
| `projects` | background, background_delete, backgrounds_upload, count, create, delete, deleted, deleted_count, deleted_delete, duplicate, permanent, projectusers, read_all, read_one, restore, tasks_by_index, update, users_search, views_buckets, views_buckets_create, views_buckets_delete, views_buckets_tasks, views_buckets_tasks_update, views_buckets_update |
| `projects_shares` | create, delete, read_all, read_one |
| `projects_teams` | create, delete, read_all, update |
| `projects_users` | create, delete, read_all, update |
| `projects_views` | create, delete, read_all, read_one, update |
| `projects_views_tasks` | read_all |
| `projects_webhooks` | create, delete, read_all, update |
| `reactions` | create, delete, read_all |
| `tasks` | attachments_preview, create, create_bulk, delete, deleted, deleted_count, deleted_delete, duplicate, permanent, position, read, read_all, read_one, restore, update, update_bulk |
| `tasks_assignees` | create, delete, read_all, update_bulk |
| `tasks_attachments` | create, delete, read_all, read_one |
| `tasks_comments` | create, delete, read_all, read_one, update |
| `tasks_labels` | create, delete, read_all, update_bulk |
| `tasks_relations` | create, delete |
| `teams` | create, delete, members_admin, read_all, read_one, update |
| `teams_members` | create, delete |
| `webhooks` | events |

## Raw observed payloads

Task GET/ETag:

```
HTTP/1.1 200 OK
Cache-Control: no-store
Content-Type: application/json
Etag: "1794329691000000000-2"
```

Conditional GET matrix (observed, task unchanged):

| Request header | Status | Body |
|---|---|---|
| `If-Match: "1794329691000000000-2"` | 200 | task |
| `If-Match: "stale-etag"` | 304 | empty |
| `If-None-Match: "1794329691000000000-2"` | 304 | empty |
| `If-None-Match: "stale-etag"` | 200 | task |

Write preconditions (`PUT`/`PATCH`/`DELETE`, task unchanged) — **no provider-side CAS**:

| Request | Status |
|---|---|
| `PUT` + matching `If-Match` | 200 |
| `PUT` + stale `If-Match` | 200 |
| `PATCH` merge-patch + stale `If-Match` | 200 |
| `DELETE` + stale `If-Match` | 204 |

The delete with a stale `If-Match` was confirmed by the reviewer and is now also
covered by the probe (`task-delete` records the observed status).

404 error (raw, `Content-Type: application/problem+json`):

```json
{
  "$schema": "http://127.0.0.1:3456/api/v2/schemas/VikunjaErrorModel.json",
  "title": "Not Found",
  "status": 404,
  "detail": "This task does not exist",
  "code": 4002
}
```

Deleted task error (raw excerpt):

```json
{"title":"Not Found","status":404,"detail":"This task is in the trash.","code":4040,
 "details":{"id":2,"project_id":3,"deleted_at":"2026-11-10T16:52:30Z"}}
```

Pagination envelope (raw):

```json
{"$schema":"…/PaginatedTask.json","items":[…],"total":4,"page":1,"per_page":1,"total_pages":4}
```

Time-zone representation (raw, values round-tripped through PUT):

```json
{
  "due_date": "2026-12-01T10:00:00+09:00",
  "reminders": [
    {"reminder": "2026-11-30T10:00:00+09:00", "relative_period": 0, "relative_to": ""}
  ],
  "created": "2026-11-10T16:54:51.583…Z",
  "updated": "2026-11-10T16:54:51Z"
}
```

Relative reminder, after server resolution:

```json
{"reminder":"2026-12-01T09:00:00Z","relative_period":-3600,"relative_to":"due_date"}
```

Trash (raw excerpt):

```json
{"items":[{"id":2,"title":"probe task two","deleted_at":"2026-11-10T16:52:30Z"}],"total":1,"page":1,"per_page":5,"total_pages":1}
```

Attachment upload result (raw excerpt):

```json
{"success":[{"id":1,"task_id":1,"file":{"name":"attachment.txt","mime":"text/plain; charset=utf-8","size":23}}],"errors":null}
```

## Gaps for OhMyDate

`TaskRepository` port: `create / get / list / update(expectedVersion) / complete /
softDelete / listChangedSince`.

| Port method | Mapping status | Gap / required adaptation |
|---|---|---|
| `create` | Partial | Create is project-scoped (`POST /projects/{project}/tasks`), not a top-level `POST /tasks`. IDs are numeric `int64`, not UUIDv7; needs an external id mapping or a project-accepted deviation. Create responses can omit `created_by` and zero some date fields, so a follow-up GET is advisable. |
| `get` | Met | `GET /tasks/{task}` returns the aggregate plus an ETag (but not a writable version). |
| `list` | Partial | Page-based pagination (`page`/`per_page`, max 50), filter DSL instead of typed predicates, and no stable ordering guarantee without `sort_by`. Envelope must be unpacked. |
| `update(expectedVersion)` | **Not met** | **Provider-side atomic compare-and-swap (CAS) is unsupported.** The API exposes an ETag but does not enforce `If-Match` on any write: stale versions are accepted by PUT (200), PATCH (200) and DELETE (204), and there is no `version` column. Read-compare-write in OhMyDate is only **best-effort with a race window** between our read and write. Correctness therefore assumes a **single writer / externally serialized writer** for each task; direct writes through the Vikunja UI, CalDAV, other API clients or webhooks cannot be fenced by OhMyDate. A local version/lock table or an outbox that serializes all writes is required, or the guarantee must be explicitly downgraded. |
| `complete` | Not met | Two independent gaps: there is no completion endpoint (set `done:true` via PUT/PATCH), and **the update carries no `expectedVersion` precondition** (stale `If-Match` is accepted), so a completion cannot be fenced against a concurrent edit. Completing a repeating task also re-opens it and bumps due dates/reminders server-side, which may surprise an idempotent `complete` use-case; `done_at` is server-set and cannot be supplied. |
| `softDelete` | Partial — expectedVersion not met | `DELETE /tasks/{task}` soft-deletes for 30 days (restore and permanent purge exist), but **the delete accepts a stale `If-Match` and returns 204**, so `softDelete(expectedVersion)` cannot be enforced by the provider. Treat it as an unconditional delete gated only by our own serialization. |
| `listChangedSince` | Partial | `filter=updated > <ts>` + `sort_by=updated&order_by=desc` works, but list `updated` has second precision (same-second changes are indistinguishable / can be missed with a strict `>` cursor), there is no cursor token, and soft-deleted tasks are excluded from `/tasks` — deletions must be discovered via `GET /tasks/deleted` (which has no `deleted_since` filter). |

### Concurrency implications

- **Provider-side atomic CAS: UNSUPPORTED.** There is no conditional write and no
  version token that the server checks. `If-Match` is honoured (partially, and
  non-standardly) only on GET. A stale version succeeds on `PUT` (200), `PATCH`
  (200) and `DELETE` (204).
- Any read-compare-write OhMyDate performs is **best-effort and has a race window**
  between the read and the write; two of our own writers can still lose an update
  unless they are serialized.
- The design therefore relies on a **single-writer / serialization assumption**
  (one writer per task, or an application-level lock/queue/version table in
  OhMyDate).
- **Direct writers cannot be fenced**: edits made through the Vikunja UI, CalDAV,
  another API client, migrations or automations bypass any OhMyDate-side
  precondition and may be overwritten by our next write. ETags cannot detect that
  race because writes ignore them.

Additional cross-cutting gaps:

- No `Idempotency-Key` support (header ignored, duplicate creates observed), while
  OhMyDate requires it on every mutating API.
- Error `code` values are upstream numeric codes, not OhMyDate's `code` enum;
  dependents need a translation layer.
- ETag/`If-Match` semantics on GET are non-standard (stale `If-Match` → 304), so
  do not rely on them for fetches either.
- Webhook delivery is fire-once (upstream docs; not exercised here) and requires a
  subscription/consumer design on our side; `task.*` events cover the update stream
  but not deleted payloads beyond `task.deleted`.
- User-level endpoints (`/user/*`, e.g. timezones) are JWT-only; scoped API tokens
  get 401. A server-to-server integration should budget for a session bootstrap or
  use only `/routes`-scoped entity operations.
