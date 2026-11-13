use ohmydate_app::App;

use super::{Call, Reply};
use crate::dto;
use crate::problem::Problem;

/// `GET /me`: the single local owner. The tag is `W/"<id>:<version>"`, as in
/// the TypeScript core.
pub(super) fn get_me(app: &App, call: &Call) -> Result<Reply, Problem> {
    let owner = app.owner();
    let etag = format!("W/\"{}:{}\"", owner.id, owner.version);
    Ok(Reply::conditional(call, &etag, &dto::user(owner))
        .header("Cache-Control", "private, no-store")
        .header("Vary", "Cookie"))
}
