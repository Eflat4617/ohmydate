use ohmydate_app::projects::ProjectPatch;
use ohmydate_app::{App, projects};
use serde_json::{Map, Value};

use super::{Call, Reply};
use crate::dto;
use crate::headers::{etag_for_body, etag_for_version};
use crate::problem::Problem;

/// `GET /projects`.
pub(super) fn list_projects(app: &App, call: &Call) -> Result<Reply, Problem> {
    let page = call.read(app, |unit| projects::list(unit, &call.page_query()))?;
    let owner_id = &app.owner().id;
    let body = dto::page(&page, |project| dto::project(project, owner_id));
    Ok(Reply::conditional(call, &etag_for_body(&body), &body))
}

/// `POST /projects`.
pub(super) fn create_project(app: &App, call: &Call) -> Result<Reply, Problem> {
    let title = call
        .body_object()?
        .get("title")
        .and_then(Value::as_str)
        .ok_or_else(Problem::internal)?;
    let owner_id = &app.owner().id;
    call.mutate(app, |unit| {
        let project = projects::create(unit, title)?;
        Ok(Reply::json(201, &dto::project(&project, owner_id))
            .header("ETag", etag_for_version(project.version)))
    })
}

// The dispatcher validated the body against the contract's `ProjectPatch`,
// so a field of the wrong type never reaches this reader.
fn project_patch(object: &Map<String, Value>) -> ProjectPatch {
    ProjectPatch {
        title: object
            .get("title")
            .and_then(Value::as_str)
            .map(str::to_owned),
        archived: object.get("archived").and_then(Value::as_bool),
    }
}

/// `PATCH /projects/{id}`: rename and/or archive a folder (FOLD-01).
pub(super) fn update_project(app: &App, call: &Call) -> Result<Reply, Problem> {
    let id = call.id()?;
    let expected = call.expected_version()?;
    let patch = project_patch(call.body_object()?);
    let owner_id = &app.owner().id;
    call.mutate(app, |unit| {
        let project = projects::update(unit, &id, &patch, expected)?;
        Ok(Reply::json(200, &dto::project(&project, owner_id))
            .header("ETag", etag_for_version(project.version)))
    })
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn object(value: Value) -> Map<String, Value> {
        value.as_object().cloned().unwrap()
    }

    #[test]
    fn a_patch_body_maps_both_fields() {
        assert_eq!(
            project_patch(&object(json!({"title": "Thesis", "archived": true}))),
            ProjectPatch {
                title: Some("Thesis".into()),
                archived: Some(true),
            }
        );
        assert_eq!(
            project_patch(&object(json!({"archived": false}))),
            ProjectPatch {
                title: None,
                archived: Some(false),
            }
        );
    }

    #[test]
    fn an_empty_body_is_an_empty_patch_and_other_fields_are_not_read() {
        assert!(project_patch(&Map::new()).is_empty());
        // The contract refuses these before a handler runs; the reader does
        // not turn them into a change either way.
        let stray = project_patch(&object(json!({"kind": "inbox", "version": 9})));
        assert!(stray.is_empty());
    }
}
