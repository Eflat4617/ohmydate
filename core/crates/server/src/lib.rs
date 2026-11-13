//! HTTP surface of the OhMyDate core.
//!
//! Serves the contract of `packages/contracts` (`openapi.json`) under
//! `/api/v1` on a loopback port, plus `/healthz` and `/readyz`. The desktop
//! shell embeds this crate as a library; the `ohmydate-core` binary runs it
//! headless for tests and development.
//!
//! One function, [`handle`], takes every request through the same steps:
//! health → host check → route lookup in the contract → launch token →
//! origin → header rules → contract validation → handler. Handlers never see
//! an unauthenticated or malformed request.

mod canonical;
pub mod contract;
mod dto;
mod handlers;
mod headers;
pub mod problem;
pub mod security;
pub mod system;

use std::collections::HashMap;
use std::future::Future;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

use axum::body::Body;
use axum::extract::State;
use axum::http::request::Parts;
use axum::http::{HeaderMap, Method, Request, Response, StatusCode, header};
use ohmydate_app::App;
use serde_json::{Value, json};

use crate::contract::{API_PREFIX, Contract};
use crate::handlers::{Call, Handler, Reply};
use crate::problem::Problem;
use crate::security::Guard;

/// Largest accepted request body (the TypeScript core's Fastify default).
pub const MAX_BODY_BYTES: usize = 1024 * 1024;

/// Everything a request needs; shared by all connections.
pub struct ServerState {
    app: Arc<App>,
    guard: Guard,
    contract: &'static Contract,
    handlers: HashMap<&'static str, Handler>,
    request_counter: AtomicU64,
}

impl std::fmt::Debug for ServerState {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("ServerState")
            .field("guard", &self.guard)
            .finish_non_exhaustive()
    }
}

impl ServerState {
    #[must_use]
    pub fn new(app: Arc<App>, guard: Guard) -> Self {
        Self {
            app,
            guard,
            contract: Contract::embedded(),
            handlers: handlers::table().into_iter().collect(),
            request_counter: AtomicU64::new(0),
        }
    }

    /// Operation ids this build serves, sorted.
    #[must_use]
    pub fn ported_operations(&self) -> Vec<&'static str> {
        let mut ids: Vec<&'static str> = self.handlers.keys().copied().collect();
        ids.sort_unstable();
        ids
    }
}

/// Serves requests on `listener` until `shutdown` resolves, then stops
/// accepting connections and lets requests in flight finish.
pub async fn serve(
    listener: tokio::net::TcpListener,
    state: Arc<ServerState>,
    shutdown: impl Future<Output = ()> + Send + 'static,
) -> std::io::Result<()> {
    let router = axum::Router::new().fallback(dispatch).with_state(state);
    axum::serve(listener, router)
        .with_graceful_shutdown(shutdown)
        .await
}

async fn dispatch(State(state): State<Arc<ServerState>>, request: Request<Body>) -> Response<Body> {
    handle(&state, request).await
}

/// Answers one request. Never panics and never returns an error: every
/// failure becomes a problem response.
pub async fn handle(state: &Arc<ServerState>, request: Request<Body>) -> Response<Body> {
    let started = std::time::Instant::now();
    let trace_id = format!(
        "req-{:x}",
        state.request_counter.fetch_add(1, Ordering::Relaxed) + 1
    );
    let (parts, body) = request.into_parts();
    let method = parts.method.clone();

    let mut operation = "-";
    let result = respond(state, &trace_id, parts, body, &mut operation).await;
    let status = match &result {
        Ok(reply) => reply.status,
        Err(problem) => problem.status,
    };
    // Log line of a request: ids and codes only. Paths can carry text typed
    // by the user (search queries), bodies always do; neither is logged.
    tracing::info!(
        target: "ohmydate::http",
        trace_id = %trace_id,
        method = %method,
        operation,
        status,
        duration_ms = u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX),
        "request"
    );
    into_response(&trace_id, result)
}

fn header_text<'a>(headers: &'a HeaderMap, name: &str) -> Option<&'a str> {
    headers.get(name).and_then(|value| value.to_str().ok())
}

async fn respond(
    state: &Arc<ServerState>,
    trace_id: &str,
    parts: Parts,
    body: Body,
    operation_label: &mut &'static str,
) -> Result<Reply, Problem> {
    let path = parts.uri.path();
    let is_get = parts.method == Method::GET;

    // Liveness and readiness carry no user data and need no token, so a
    // supervisor can probe them.
    if is_get && path == "/healthz" {
        *operation_label = "healthz";
        return Ok(Reply::json(200, &json!({"status": "ok"})));
    }
    if is_get && path == "/readyz" {
        *operation_label = "readyz";
        let app = state.app.clone();
        let ready = tokio::task::spawn_blocking(move || app.is_ready())
            .await
            .unwrap_or(false);
        return Ok(if ready {
            Reply::json(200, &json!({"status": "ok", "checks": {"database": "ok"}}))
        } else {
            Reply::json(
                503,
                &json!({"status": "unavailable", "checks": {"database": "failed"}}),
            )
        });
    }

    state.guard.check_host(&parts.headers)?;

    if is_get && path == "/__boot" {
        *operation_label = "boot";
        return boot(state, parts.uri.query());
    }

    let api_path = path
        .strip_prefix(API_PREFIX)
        .filter(|rest| rest.is_empty() || rest.starts_with('/'))
        .ok_or_else(|| Problem::not_found("no route matches this request"))?;
    let (operation, params) = state
        .contract
        .route(parts.method.as_str(), api_path)
        .ok_or_else(|| Problem::not_found("no route matches this request"))?;
    let handler = state.handlers.get_key_value(operation.id.as_str());
    if let Some((id, _)) = handler {
        *operation_label = id;
    }

    state.guard.check_token(&parts.headers)?;
    state.guard.check_origin(&parts.method, &parts.headers)?;
    let Some((_, handler)) = handler else {
        return Err(Problem::not_implemented(&operation.id));
    };

    // 08 §1 header table, in the order of the TypeScript core: If-Match,
    // then Idempotency-Key, then path, body and query shapes.
    let if_match =
        headers::require_if_match(header_text(&parts.headers, "if-match"), operation.if_match)?;
    let idempotency_key = if operation.idempotency_key {
        Some(headers::require_idempotency_key(header_text(
            &parts.headers,
            "idempotency-key",
        ))?)
    } else {
        None
    };

    let malformed = |errors| Problem::malformed("request validation failed", errors);
    let param_errors = operation.validate_params(&params);
    if !param_errors.is_empty() {
        return Err(malformed(param_errors));
    }

    let body = if operation.has_body_schema() {
        let body = read_json_body(&parts.headers, body).await?;
        let body_errors = operation.validate_body(body.as_ref());
        if !body_errors.is_empty() {
            return Err(malformed(body_errors));
        }
        body
    } else {
        None
    };
    let query = operation
        .validate_query(parts.uri.query())
        .map_err(malformed)?;

    let call = Call {
        trace_id: trace_id.to_owned(),
        method: parts.method.as_str().to_owned(),
        path: path.to_owned(),
        route: operation.path.clone(),
        params,
        query,
        body,
        if_match,
        if_none_match: header_text(&parts.headers, "if-none-match").map(str::to_owned),
        idempotency_key,
    };
    let app = state.app.clone();
    let handler = *handler;
    // Use-cases are synchronous (SQLite); keep them off the async workers.
    tokio::task::spawn_blocking(move || handler(&app, &call))
        .await
        .unwrap_or_else(|_| {
            tracing::error!(target: "ohmydate::http", "a handler panicked");
            Err(Problem::internal())
        })
}

/// Hands the launch token to the webview as a cookie. The shell opens
/// `/__boot?token=<secret>` once; everything after that is same-origin.
fn boot(state: &ServerState, query: Option<&str>) -> Result<Reply, Problem> {
    let token = query
        .into_iter()
        .flat_map(|query| query.split('&'))
        .find_map(|pair| pair.strip_prefix("token="))
        .unwrap_or("");
    if !state.guard.token_matches(token) {
        return Err(Problem::unauthenticated());
    }
    Ok(Reply::empty(303)
        .header("Location", "/")
        .header("Set-Cookie", state.guard.launch_cookie())
        .header("Cache-Control", "no-store")
        .header("Referrer-Policy", "no-referrer"))
}

async fn read_json_body(headers: &HeaderMap, body: Body) -> Result<Option<Value>, Problem> {
    let bytes = axum::body::to_bytes(body, MAX_BODY_BYTES)
        .await
        .map_err(|_| {
            Problem::malformed("the request body is too large or was cut off", Vec::new())
        })?;
    if bytes.is_empty() {
        return Ok(None);
    }
    let is_json = header_text(headers, "content-type")
        .and_then(|value| value.split(';').next())
        .is_some_and(|media_type| media_type.trim().eq_ignore_ascii_case("application/json"));
    if !is_json {
        return Err(Problem::malformed(
            "the request body must be application/json",
            Vec::new(),
        ));
    }
    serde_json::from_slice(&bytes)
        .map(Some)
        .map_err(|_| Problem::malformed("the request body is not valid JSON", Vec::new()))
}

fn into_response(trace_id: &str, result: Result<Reply, Problem>) -> Response<Body> {
    let (status, headers, body, default_type) = match result {
        Ok(reply) => (
            reply.status,
            reply.headers,
            reply.body,
            "application/json; charset=utf-8",
        ),
        Err(problem) => {
            let body = problem.body(trace_id).to_string();
            (
                problem.status,
                problem.headers,
                Some(body),
                "application/problem+json; charset=utf-8",
            )
        }
    };
    let mut builder = Response::builder()
        .status(StatusCode::from_u16(status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR))
        .header("x-trace-id", trace_id);
    let has_type = headers
        .iter()
        .any(|(name, _)| name.eq_ignore_ascii_case("content-type"));
    for (name, value) in &headers {
        builder = builder.header(name.as_str(), value.as_str());
    }
    if body.is_some() && !has_type {
        builder = builder.header(header::CONTENT_TYPE, default_type);
    }
    builder
        .body(body.map_or_else(Body::empty, Body::from))
        .unwrap_or_else(|_| {
            // Only reachable with a header value that is not valid HTTP.
            let mut response = Response::new(Body::empty());
            *response.status_mut() = StatusCode::INTERNAL_SERVER_ERROR;
            response
        })
}
