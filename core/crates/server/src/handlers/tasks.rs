use ohmydate_app::App;
use ohmydate_app::tasks::{self, TaskFilter};
use ohmydate_domain::{Id, SessionWindow, TaskCreate, TaskPatch, TaskPriority, TaskStatus};
use serde_json::{Map, Value, json};

use super::{Call, Reply};
use crate::dto;
use crate::headers::{etag_for_body, etag_for_version};
use crate::problem::Problem;

// The body and query values below were validated against the contract schema
// by the dispatcher, so the lenient readers here cannot hide a client error:
// a field of the wrong type never reaches them.

fn text(object: &Map<String, Value>, name: &str) -> Option<String> {
    object.get(name).and_then(Value::as_str).map(str::to_owned)
}

fn id_field(object: &Map<String, Value>, name: &str) -> Option<Id> {
    object.get(name).and_then(Value::as_str).and_then(Id::parse)
}

fn status(object: &Map<String, Value>) -> Option<TaskStatus> {
    object
        .get("status")
        .and_then(Value::as_str)
        .and_then(TaskStatus::parse)
}

fn priority(object: &Map<String, Value>) -> Option<TaskPriority> {
    object
        .get("priority")
        .and_then(Value::as_i64)
        .and_then(TaskPriority::new)
}

fn session(value: &Value) -> Option<SessionWindow> {
    let minutes = |name: &str| {
        value
            .get(name)
            .and_then(Value::as_u64)
            .and_then(|v| u16::try_from(v).ok())
    };
    Some(SessionWindow {
        min_minutes: minutes("minMinutes")?,
        max_minutes: minutes("maxMinutes")?,
    })
}

fn depends_on(object: &Map<String, Value>) -> Option<Vec<Id>> {
    object
        .get("dependsOn")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| item.as_str().and_then(Id::parse))
                .collect()
        })
}

/// `None` when the field is absent, `Some(None)` when it is `null`.
fn nullable<T>(
    object: &Map<String, Value>,
    name: &str,
    read: impl Fn(&Value) -> Option<T>,
) -> Option<Option<T>> {
    object
        .get(name)
        .map(|value| if value.is_null() { None } else { read(value) })
}

fn task_create(object: &Map<String, Value>) -> TaskCreate {
    TaskCreate {
        project_id: id_field(object, "projectId"),
        title: text(object, "title").unwrap_or_default(),
        description: text(object, "description"),
        status: status(object),
        due_at: text(object, "dueAt"),
        splittable: object.get("splittable").and_then(Value::as_bool),
        session: object.get("session").and_then(session),
        priority: priority(object),
        depends_on: depends_on(object),
    }
}

fn task_patch(object: &Map<String, Value>) -> TaskPatch {
    let string = |value: &Value| value.as_str().map(str::to_owned);
    TaskPatch {
        project_id: id_field(object, "projectId"),
        title: text(object, "title"),
        description: nullable(object, "description", string),
        status: status(object),
        due_at: nullable(object, "dueAt", string),
        splittable: object.get("splittable").and_then(Value::as_bool),
        session: nullable(object, "session", session),
        priority: priority(object),
        depends_on: depends_on(object),
    }
}

/// `GET /tasks`.
pub(super) fn list_tasks(app: &App, call: &Call) -> Result<Reply, Problem> {
    let filter = TaskFilter {
        project_id: id_field(&call.query, "projectId"),
        status: status(&call.query),
    };
    let page = call.read(app, |unit| tasks::list(unit, &filter, &call.page_query()))?;
    let owner_id = &app.owner().id;
    let body = dto::page(&page, |task| dto::task(task, owner_id));
    Ok(Reply::conditional(call, &etag_for_body(&body), &body))
}

/// `POST /tasks`.
pub(super) fn create_task(app: &App, call: &Call) -> Result<Reply, Problem> {
    let input = task_create(call.body_object()?);
    let owner_id = &app.owner().id;
    call.mutate(app, |unit| {
        let task = tasks::create(unit, &input)?;
        Ok(Reply::json(201, &dto::task(&task, owner_id))
            .header("ETag", etag_for_version(task.version)))
    })
}

/// `GET /tasks/{id}`.
pub(super) fn get_task(app: &App, call: &Call) -> Result<Reply, Problem> {
    let id = call.id()?;
    let task = call
        .read(app, |unit| tasks::get(unit, &id))?
        .ok_or_else(|| Problem::not_found(format!("task not found: {id}")))?;
    Ok(Reply::conditional(
        call,
        &etag_for_version(task.version),
        &dto::task(&task, &app.owner().id),
    ))
}

/// `PATCH /tasks/{id}`.
pub(super) fn update_task(app: &App, call: &Call) -> Result<Reply, Problem> {
    let id = call.id()?;
    let expected = call.expected_version()?;
    let patch = task_patch(call.body_object()?);
    let owner_id = &app.owner().id;
    call.mutate(app, |unit| {
        let task = tasks::update(unit, &id, &patch, expected)?;
        Ok(Reply::json(200, &dto::task(&task, owner_id))
            .header("ETag", etag_for_version(task.version)))
    })
}

/// `POST /tasks/{id}:complete`.
pub(super) fn complete_task(app: &App, call: &Call) -> Result<Reply, Problem> {
    let id = call.id()?;
    let expected = call.expected_version()?;
    let owner_id = &app.owner().id;
    call.mutate(app, |unit| {
        let task = tasks::complete(unit, &id, expected)?;
        Ok(Reply::json(200, &dto::task(&task, owner_id))
            .header("ETag", etag_for_version(task.version)))
    })
}

/// `DELETE /tasks/{id}` (soft delete).
pub(super) fn delete_task(app: &App, call: &Call) -> Result<Reply, Problem> {
    let id = call.id()?;
    let expected = call.expected_version()?;
    call.mutate(app, |unit| {
        tasks::delete(unit, &id, expected)?;
        Ok(Reply::empty(204))
    })
}

/// `POST /tasks/{id}/dependencies`. The `ETag` is the task's new version.
pub(super) fn create_task_dependency(app: &App, call: &Call) -> Result<Reply, Problem> {
    let id = call.id()?;
    let expected = call.expected_version()?;
    let depends_on_task_id =
        id_field(call.body_object()?, "dependsOnTaskId").ok_or_else(Problem::internal)?;
    call.mutate(app, |unit| {
        let task = tasks::add_dependency(unit, &id, &depends_on_task_id, expected)?;
        let body = json!({
            "taskId": task.id.as_str(),
            "dependsOnTaskId": depends_on_task_id.as_str(),
        });
        Ok(Reply::json(201, &body).header("ETag", etag_for_version(task.version)))
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn object(value: Value) -> Map<String, Value> {
        value.as_object().cloned().unwrap()
    }

    #[test]
    fn a_create_body_maps_every_field() {
        let input = task_create(&object(json!({
            "projectId": "0193a8f2-6c1e-7b41-9a2e-1f1d6a0b3c55",
            "title": "Read papers",
            "description": "five of them",
            "status": "in_progress",
            "dueAt": "2026-11-20T23:59:00+09:00",
            "splittable": true,
            "session": {"minMinutes": 30, "maxMinutes": 90},
            "priority": 1,
            "dependsOn": ["0193a8f2-6c1e-7b41-9a2e-1f1d6a0b3c56"],
        })));
        assert_eq!(input.title, "Read papers");
        assert_eq!(
            input.project_id.unwrap().as_str(),
            "0193a8f2-6c1e-7b41-9a2e-1f1d6a0b3c55"
        );
        assert_eq!(input.status, Some(TaskStatus::InProgress));
        assert_eq!(input.due_at.as_deref(), Some("2026-11-20T23:59:00+09:00"));
        assert_eq!(
            input.session,
            Some(SessionWindow {
                min_minutes: 30,
                max_minutes: 90
            })
        );
        assert_eq!(input.priority.map(TaskPriority::get), Some(1));
        assert_eq!(input.depends_on.unwrap().len(), 1);
    }

    #[test]
    fn a_minimal_create_body_leaves_the_rest_unset() {
        let input = task_create(&object(json!({"title": "x"})));
        assert_eq!(
            input,
            TaskCreate {
                title: "x".into(),
                ..TaskCreate::default()
            }
        );
    }

    #[test]
    fn a_patch_distinguishes_absent_null_and_value() {
        let patch = task_patch(&object(json!({
            "description": null,
            "dueAt": "2026-11-20T14:59:00Z",
            "session": null,
        })));
        assert_eq!(patch.title, None);
        assert_eq!(patch.description, Some(None));
        assert_eq!(patch.due_at, Some(Some("2026-11-20T14:59:00Z".into())));
        assert_eq!(patch.session, Some(None));
        assert_eq!(patch.depends_on, None);

        let empty = task_patch(&Map::new());
        assert_eq!(empty, TaskPatch::default());
    }
}
