use ohmydate_app::{App, projects};
use serde_json::Value;

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
