//! Handlers, one per contract `operationId`.
//!
//! A handler receives a request the dispatcher has already authenticated,
//! routed and validated against the contract (headers, path, query, body), so
//! it only translates between JSON and use-cases. Adding an operation means
//! writing its function and listing it in [`table`]; paths, header rules and
//! shapes come from the contract.

mod me;
mod projects;
mod tasks;

use std::collections::BTreeMap;

use ohmydate_app::{App, AppError, IdempotentRequest, PageQuery, StoredResponse, Unit};
use ohmydate_domain::{Id, Version};
use serde_json::{Map, Value};

use crate::canonical::request_hash;
use crate::headers::if_none_match;
use crate::problem::Problem;

/// A routed and validated request.
#[derive(Debug, Clone)]
pub struct Call {
    pub trace_id: String,
    pub method: String,
    /// Request path without the query string, e.g. `/api/v1/tasks`.
    pub path: String,
    /// Contract path template, e.g. `/tasks/{id}`.
    pub route: String,
    pub params: BTreeMap<String, String>,
    pub query: Map<String, Value>,
    pub body: Option<Value>,
    /// The number inside a required `If-Match` tag.
    pub if_match: Option<u32>,
    pub if_none_match: Option<String>,
    pub idempotency_key: Option<String>,
}

/// What a handler answers.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Reply {
    pub status: u16,
    pub headers: Vec<(String, String)>,
    /// JSON text; `None` for an empty body.
    pub body: Option<String>,
}

impl Reply {
    #[must_use]
    pub fn json(status: u16, body: &Value) -> Self {
        Self {
            status,
            headers: Vec::new(),
            body: Some(body.to_string()),
        }
    }

    #[must_use]
    pub fn empty(status: u16) -> Self {
        Self {
            status,
            headers: Vec::new(),
            body: None,
        }
    }

    #[must_use]
    pub fn header(mut self, name: &str, value: impl Into<String>) -> Self {
        self.headers.push((name.to_owned(), value.into()));
        self
    }

    /// Answers a read: 304 when `If-None-Match` names `etag`, else 200.
    #[must_use]
    pub fn conditional(call: &Call, etag: &str, body: &Value) -> Self {
        if if_none_match(call.if_none_match.as_deref(), etag) {
            Self::empty(304).header("ETag", etag)
        } else {
            Self::json(200, body).header("ETag", etag)
        }
    }
}

pub type Handler = fn(&App, &Call) -> Result<Reply, Problem>;

/// Operations this build serves. Every other contract operation answers 501.
#[must_use]
pub fn table() -> Vec<(&'static str, Handler)> {
    vec![
        ("getMe", me::get_me),
        ("listProjects", projects::list_projects),
        ("createProject", projects::create_project),
        ("updateProject", projects::update_project),
        ("listTasks", tasks::list_tasks),
        ("createTask", tasks::create_task),
        ("getTask", tasks::get_task),
        ("updateTask", tasks::update_task),
        ("completeTask", tasks::complete_task),
        ("deleteTask", tasks::delete_task),
        ("createTaskDependency", tasks::create_task_dependency),
    ]
}

/// Contract operations the desktop core will never serve (blueprint 15 §2):
/// there are no accounts to log in to, and native notifications replace Web
/// Push. They answer 404 like any unknown route.
pub const DROPPED_OPERATIONS: [&str; 4] = [
    "login",
    "logout",
    "createPushSubscription",
    "deletePushSubscription",
];

impl Call {
    /// Runs read-only use-cases.
    pub fn read<T>(
        &self,
        app: &App,
        work: impl FnOnce(&Unit<'_>) -> Result<T, AppError>,
    ) -> Result<T, Problem> {
        app.read(work).map_err(|error| Problem::from(&error))
    }

    /// Runs a mutation once per `Idempotency-Key` (08 §1) and returns its
    /// reply, or the stored reply of the first request with the same key.
    pub fn mutate(
        &self,
        app: &App,
        operation: impl FnOnce(&Unit<'_>) -> Result<Reply, AppError>,
    ) -> Result<Reply, Problem> {
        // The dispatcher enforces the header for every operation that
        // declares it; a mutation handler on any other operation is a bug.
        let key = self
            .idempotency_key
            .as_deref()
            .ok_or_else(Problem::internal)?;
        let hash = request_hash(&self.method, &self.path, self.body.as_ref());
        let request = IdempotentRequest {
            key,
            route: &self.route,
            request_hash: &hash,
        };
        let storable = |error: &AppError| {
            let problem = Problem::from(error);
            problem.is_storable().then(|| StoredResponse {
                status: problem.status,
                headers: vec![(
                    "Content-Type".to_owned(),
                    "application/problem+json".to_owned(),
                )],
                body: Some(problem.body(&self.trace_id).to_string()),
            })
        };
        let outcome = app
            .mutate_idempotent(request, storable, |unit| {
                operation(unit).map(|reply| StoredResponse {
                    status: reply.status,
                    headers: reply.headers,
                    body: reply.body,
                })
            })
            .map_err(|error| Problem::from(&error))?;
        Ok(Reply {
            status: outcome.response.status,
            headers: outcome.response.headers,
            body: outcome.response.body,
        })
    }

    /// The `id` path parameter.
    fn id(&self) -> Result<Id, Problem> {
        self.params
            .get("id")
            .and_then(|text| Id::parse(text))
            .ok_or_else(Problem::internal)
    }

    /// The version named by `If-Match`.
    fn expected_version(&self) -> Result<Version, Problem> {
        self.if_match
            .and_then(Version::new)
            .ok_or_else(Problem::internal)
    }

    fn page_query(&self) -> PageQuery {
        PageQuery {
            cursor: self
                .query
                .get("cursor")
                .and_then(Value::as_str)
                .map(str::to_owned),
            limit: self
                .query
                .get("limit")
                .and_then(Value::as_u64)
                .and_then(|v| u32::try_from(v).ok()),
        }
    }

    fn body_object(&self) -> Result<&Map<String, Value>, Problem> {
        self.body
            .as_ref()
            .and_then(Value::as_object)
            .ok_or_else(Problem::internal)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::contract::Contract;

    #[test]
    fn every_handler_and_dropped_operation_names_a_contract_operation() {
        let contract = Contract::embedded();
        for (id, _) in table() {
            assert!(
                contract.operation(id).is_some(),
                "handler for unknown operation {id}"
            );
        }
        for id in DROPPED_OPERATIONS {
            assert!(
                contract.operation(id).is_some(),
                "dropped operation {id} is not in the contract"
            );
        }
    }

    #[test]
    fn no_operation_is_both_served_and_dropped_or_registered_twice() {
        let mut ids: Vec<&str> = table().into_iter().map(|(id, _)| id).collect();
        assert!(ids.iter().all(|id| !DROPPED_OPERATIONS.contains(id)));
        ids.sort_unstable();
        let before = ids.len();
        ids.dedup();
        assert_eq!(ids.len(), before);
    }
}
