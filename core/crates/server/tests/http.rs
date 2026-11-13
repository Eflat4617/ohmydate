//! End-to-end tests of the HTTP surface, driven through `handle` without a
//! socket. The black-box parity harness (`tests-core/`) repeats the contract
//! checks against the real binary; these tests pin the behaviour close to
//! the code and run with `cargo test`.

// Test code: a failed unwrap is a failed test.
#![allow(clippy::unwrap_used, clippy::expect_used)]

use std::path::PathBuf;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

use axum::body::Body;
use axum::http::{HeaderMap, Request};
use ohmydate_app::{App, OwnerDefaults};
use ohmydate_domain::UuidV7Generator;
use ohmydate_server::security::Guard;
use ohmydate_server::system::{OsRandom, SystemClock};
use ohmydate_server::{ServerState, handle};
use ohmydate_store::Store;
use serde_json::{Value, json};

const TOKEN: &str = "5f3c9a1e5f3c9a1e5f3c9a1e5f3c9a1e5f3c9a1e5f3c9a1e5f3c9a1e5f3c9a1e";
const HOST: &str = "127.0.0.1:4310";
const UNKNOWN_ID: &str = "0193a8f2-6c1e-7b41-9a2e-1f1d6a0b3c55";

struct TestServer {
    state: Arc<ServerState>,
    directory: PathBuf,
    keys: AtomicU32,
}

struct Answer {
    status: u16,
    headers: HeaderMap,
    body: Value,
}

impl Answer {
    fn header(&self, name: &str) -> Option<&str> {
        self.headers.get(name).and_then(|value| value.to_str().ok())
    }

    fn code(&self) -> &str {
        self.body["code"].as_str().unwrap_or("")
    }
}

impl TestServer {
    fn new() -> Self {
        static COUNTER: AtomicU32 = AtomicU32::new(0);
        captured_logs();
        let directory = std::env::temp_dir().join(format!(
            "ohmydate-server-{}-{}",
            std::process::id(),
            COUNTER.fetch_add(1, Ordering::SeqCst)
        ));
        std::fs::create_dir_all(&directory).unwrap();
        let store = Store::open(&directory.join("ohmydate.db")).unwrap();
        let app = App::open(
            store,
            Arc::new(SystemClock),
            Arc::new(UuidV7Generator::new(SystemClock, OsRandom)),
            &OwnerDefaults {
                email: "owner@ohmydate.local".into(),
                time_zone: "Asia/Seoul".into(),
                locale: "ko-KR".into(),
            },
        )
        .unwrap();
        let guard = Guard::new(TOKEN.to_owned(), 4310, &[]);
        Self {
            state: Arc::new(ServerState::new(Arc::new(app), guard)),
            directory,
            keys: AtomicU32::new(0),
        }
    }

    /// A fresh `Idempotency-Key`.
    fn key(&self) -> String {
        format!(
            "0193a8f2-6c1e-4b41-9a2e-{:012x}",
            self.keys.fetch_add(1, Ordering::SeqCst)
        )
    }

    async fn send(&self, request: Request<Body>) -> Answer {
        let response = handle(&self.state, request).await;
        let status = response.status().as_u16();
        let headers = response.headers().clone();
        let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let body = if bytes.is_empty() {
            Value::Null
        } else {
            serde_json::from_slice(&bytes).unwrap()
        };
        Answer {
            status,
            headers,
            body,
        }
    }

    /// An authenticated request; `headers` are added on top.
    async fn call(
        &self,
        method: &str,
        path: &str,
        headers: &[(&str, &str)],
        body: Option<Value>,
    ) -> Answer {
        let mut builder = Request::builder()
            .method(method)
            .uri(path)
            .header("host", HOST)
            .header("authorization", format!("Bearer {TOKEN}"));
        for (name, value) in headers {
            builder = builder.header(*name, *value);
        }
        let request = match body {
            Some(body) => builder
                .header("content-type", "application/json")
                .body(Body::from(body.to_string()))
                .unwrap(),
            None => builder.body(Body::empty()).unwrap(),
        };
        self.send(request).await
    }

    async fn get(&self, path: &str) -> Answer {
        self.call("GET", path, &[], None).await
    }

    async fn create_task(&self, body: Value) -> Answer {
        self.call(
            "POST",
            "/api/v1/tasks",
            &[("idempotency-key", &self.key())],
            Some(body),
        )
        .await
    }

    async fn mutate(&self, method: &str, path: &str, version: u32, body: Option<Value>) -> Answer {
        let if_match = format!("W/\"{version}\"");
        self.call(
            method,
            path,
            &[("if-match", &if_match), ("idempotency-key", &self.key())],
            body,
        )
        .await
    }
}

impl Drop for TestServer {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.directory);
    }
}

fn assert_problem(answer: &Answer, status: u16, code: &str) {
    assert_eq!(
        (answer.status, answer.code()),
        (status, code),
        "{}",
        answer.body
    );
    assert!(
        answer
            .header("content-type")
            .unwrap()
            .starts_with("application/problem+json")
    );
    assert_eq!(answer.body["type"], "about:blank");
    assert_eq!(answer.body["status"], status);
    assert!(answer.body["title"].is_string());
    assert_eq!(answer.body["traceId"].as_str(), answer.header("x-trace-id"));
}

#[tokio::test]
async fn health_and_readiness_need_no_token() {
    let server = TestServer::new();
    for (path, expected) in [
        ("/healthz", json!({"status": "ok"})),
        (
            "/readyz",
            json!({"status": "ok", "checks": {"database": "ok"}}),
        ),
    ] {
        let request = Request::builder().uri(path).body(Body::empty()).unwrap();
        let answer = server.send(request).await;
        assert_eq!((answer.status, &answer.body), (200, &expected));
    }
    let post = Request::builder()
        .method("POST")
        .uri("/healthz")
        .header("host", HOST)
        .body(Body::empty())
        .unwrap();
    assert_problem(&server.send(post).await, 404, "not_found");
}

#[tokio::test]
async fn the_api_requires_the_launch_token_and_the_loopback_host() {
    let server = TestServer::new();
    let no_token = Request::builder()
        .uri("/api/v1/me")
        .header("host", HOST)
        .body(Body::empty())
        .unwrap();
    assert_problem(&server.send(no_token).await, 401, "unauthenticated");

    let wrong_token = Request::builder()
        .uri("/api/v1/tasks")
        .header("host", HOST)
        .header("authorization", "Bearer wrong")
        .body(Body::empty())
        .unwrap();
    assert_problem(&server.send(wrong_token).await, 401, "unauthenticated");

    let rebinding = Request::builder()
        .uri("/api/v1/me")
        .header("host", "attacker.example:4310")
        .header("authorization", format!("Bearer {TOKEN}"))
        .body(Body::empty())
        .unwrap();
    assert_problem(&server.send(rebinding).await, 403, "forbidden");

    let cross_origin = server
        .call(
            "POST",
            "/api/v1/projects",
            &[
                ("origin", "https://evil.example"),
                ("idempotency-key", &server.key()),
            ],
            Some(json!({"title": "x"})),
        )
        .await;
    assert_problem(&cross_origin, 403, "forbidden");
    assert_eq!(
        server.get("/api/v1/projects").await.body["items"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
}

#[tokio::test]
async fn boot_exchanges_the_token_for_a_cookie_that_authenticates() {
    let server = TestServer::new();
    let boot = Request::builder()
        .uri(format!("/__boot?token={TOKEN}"))
        .header("host", HOST)
        .body(Body::empty())
        .unwrap();
    let answer = server.send(boot).await;
    assert_eq!(answer.status, 303);
    assert_eq!(answer.header("location"), Some("/"));
    let cookie = answer
        .header("set-cookie")
        .unwrap()
        .split(';')
        .next()
        .unwrap()
        .to_owned();

    let with_cookie = Request::builder()
        .uri("/api/v1/me")
        .header("host", HOST)
        .header("cookie", &cookie)
        .body(Body::empty())
        .unwrap();
    assert_eq!(server.send(with_cookie).await.status, 200);

    let wrong = Request::builder()
        .uri("/__boot?token=nope")
        .header("host", HOST)
        .body(Body::empty())
        .unwrap();
    let refused = server.send(wrong).await;
    assert_problem(&refused, 401, "unauthenticated");
    assert!(refused.header("set-cookie").is_none());
}

#[tokio::test]
async fn unknown_routes_and_unported_operations_are_distinguished() {
    let server = TestServer::new();
    assert_problem(
        &server.get("/api/v1/does-not-exist").await,
        404,
        "not_found",
    );
    assert_problem(&server.get("/somewhere-else").await, 404, "not_found");
    assert_problem(&server.get("/api/v1x/me").await, 404, "not_found");
    // A known path with a method the contract does not define is not a route.
    assert_problem(
        &server.call("PUT", "/api/v1/tasks", &[], None).await,
        404,
        "not_found",
    );

    // In the contract, not yet served by this build.
    let unported = server.get("/api/v1/availability").await;
    assert_eq!((unported.status, unported.code()), (501, "internal_error"));
    assert!(
        unported.body["detail"]
            .as_str()
            .unwrap()
            .contains("getAvailability")
    );
}

#[tokio::test]
async fn me_is_the_local_owner_with_a_conditional_etag() {
    let server = TestServer::new();
    let me = server.get("/api/v1/me").await;
    assert_eq!(me.status, 200);
    assert_eq!(me.body["email"], "owner@ohmydate.local");
    assert_eq!(me.body["timeZone"], "Asia/Seoul");
    assert_eq!(me.body["locale"], "ko-KR");
    assert_eq!(me.body["version"], 1);
    let etag = me.header("etag").unwrap().to_owned();
    assert_eq!(etag, format!("W/\"{}:1\"", me.body["id"].as_str().unwrap()));
    assert_eq!(me.header("cache-control"), Some("private, no-store"));

    let cached = server
        .call("GET", "/api/v1/me", &[("if-none-match", &etag)], None)
        .await;
    assert_eq!((cached.status, &cached.body), (304, &Value::Null));
    assert_eq!(cached.header("etag"), Some(etag.as_str()));
    let stale = server
        .call(
            "GET",
            "/api/v1/me",
            &[("if-none-match", "W/\"other\"")],
            None,
        )
        .await;
    assert_eq!(stale.status, 200);
}

#[tokio::test]
async fn a_task_goes_through_its_whole_life() {
    let server = TestServer::new();
    let created = server
        .create_task(json!({"title": "Read papers", "dueAt": "2026-11-20T23:59:00+09:00"}))
        .await;
    assert_eq!(created.status, 201, "{}", created.body);
    assert_eq!(created.header("etag"), Some("W/\"1\""));
    assert_eq!(
        created.header("content-type"),
        Some("application/json; charset=utf-8")
    );
    assert_eq!(created.body["dueAt"], "2026-11-20T14:59:00.000Z");
    assert_eq!(created.body["status"], "todo");
    assert_eq!(created.body["external"], json!([]));
    let id = created.body["id"].as_str().unwrap().to_owned();
    let path = format!("/api/v1/tasks/{id}");

    let inbox = &server.get("/api/v1/projects").await.body["items"][0];
    assert_eq!(inbox["kind"], "inbox");
    assert_eq!(created.body["projectId"], inbox["id"]);
    assert_eq!(
        created.body["ownerId"],
        server.get("/api/v1/me").await.body["id"]
    );

    let read = server.get(&path).await;
    assert_eq!((read.status, read.header("etag")), (200, Some("W/\"1\"")));
    assert_eq!(read.body, created.body);
    assert_eq!(
        server
            .call("GET", &path, &[("if-none-match", "W/\"1\"")], None)
            .await
            .status,
        304
    );

    let patched = server
        .mutate(
            "PATCH",
            &path,
            1,
            Some(json!({"title": "Read five papers", "dueAt": null})),
        )
        .await;
    assert_eq!(
        (patched.status, patched.header("etag")),
        (200, Some("W/\"2\""))
    );
    assert_eq!(patched.body["title"], "Read five papers");
    assert!(patched.body.get("dueAt").is_none());

    let stale = server
        .mutate("PATCH", &path, 1, Some(json!({"title": "Lost update"})))
        .await;
    assert_problem(&stale, 412, "version_conflict");

    let done = server
        .mutate("POST", &format!("{path}:complete"), 2, None)
        .await;
    assert_eq!((done.status, done.header("etag")), (200, Some("W/\"3\"")));
    assert_eq!(done.body["status"], "done");

    let deleted = server.mutate("DELETE", &path, 3, None).await;
    assert_eq!((deleted.status, &deleted.body), (204, &Value::Null));
    assert!(deleted.header("content-type").is_none());
    assert_problem(&server.get(&path).await, 404, "not_found");
    assert_eq!(server.get("/api/v1/tasks").await.body["items"], json!([]));
}

#[tokio::test]
async fn mutations_follow_the_header_table() {
    let server = TestServer::new();
    let id = server.create_task(json!({"title": "x"})).await.body["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let path = format!("/api/v1/tasks/{id}");
    let key = server.key();

    let no_key = server
        .call("POST", "/api/v1/tasks", &[], Some(json!({"title": "x"})))
        .await;
    assert_problem(&no_key, 400, "validation_failed");
    let bad_key = server
        .call(
            "POST",
            "/api/v1/tasks",
            &[("idempotency-key", "not-a-uuid")],
            Some(json!({"title": "x"})),
        )
        .await;
    assert_problem(&bad_key, 400, "validation_failed");

    // Missing If-Match wins over a malformed body and a missing key.
    let no_if_match = server
        .call("PATCH", &path, &[], Some(json!({"unexpectedField": true})))
        .await;
    assert_problem(&no_if_match, 428, "version_conflict");
    let bad_if_match = server
        .call(
            "PATCH",
            &path,
            &[("if-match", "\"1\""), ("idempotency-key", &key)],
            Some(json!({"title": "y"})),
        )
        .await;
    assert_problem(&bad_if_match, 400, "validation_failed");
    let no_key_on_patch = server
        .call(
            "PATCH",
            &path,
            &[("if-match", "W/\"1\"")],
            Some(json!({"title": "y"})),
        )
        .await;
    assert_problem(&no_key_on_patch, 400, "validation_failed");
    for action in ["", ":complete", "/dependencies"] {
        let method = if action.is_empty() { "DELETE" } else { "POST" };
        let answer = server
            .call(
                method,
                &format!("{path}{action}"),
                &[("idempotency-key", &server.key())],
                None,
            )
            .await;
        assert_problem(&answer, 428, "version_conflict");
    }
    // Nothing above changed the task.
    assert_eq!(server.get(&path).await.body["version"], 1);
}

#[tokio::test]
async fn requests_are_validated_against_the_contract() {
    let server = TestServer::new();
    let unexpected = server
        .create_task(json!({"title": "x", "unexpectedField": true}))
        .await;
    assert_problem(&unexpected, 400, "validation_failed");
    assert_eq!(unexpected.body["errors"].as_array().unwrap().len(), 1);

    let wrong_type = server.create_task(json!({"title": 7})).await;
    assert_problem(&wrong_type, 400, "validation_failed");
    assert_eq!(wrong_type.body["errors"][0]["path"], "/title");

    let no_body = server
        .call(
            "POST",
            "/api/v1/tasks",
            &[("idempotency-key", &server.key())],
            None,
        )
        .await;
    assert_problem(&no_body, 400, "validation_failed");

    let not_json = Request::builder()
        .method("POST")
        .uri("/api/v1/tasks")
        .header("host", HOST)
        .header("authorization", format!("Bearer {TOKEN}"))
        .header("idempotency-key", server.key())
        .header("content-type", "application/json")
        .body(Body::from("{\"title\": "))
        .unwrap();
    assert_problem(&server.send(not_json).await, 400, "validation_failed");

    let not_json_type = Request::builder()
        .method("POST")
        .uri("/api/v1/tasks")
        .header("host", HOST)
        .header("authorization", format!("Bearer {TOKEN}"))
        .header("idempotency-key", server.key())
        .header("content-type", "text/plain")
        .body(Body::from("{\"title\":\"x\"}"))
        .unwrap();
    assert_problem(&server.send(not_json_type).await, 400, "validation_failed");

    assert_problem(
        &server.get("/api/v1/tasks?limit=0").await,
        400,
        "validation_failed",
    );
    assert_problem(
        &server.get("/api/v1/tasks?unknown=1").await,
        400,
        "validation_failed",
    );
    assert_problem(
        &server.get("/api/v1/tasks/not-a-uuid").await,
        400,
        "validation_failed",
    );
    assert_problem(
        &server.get("/api/v1/tasks?cursor=garbage").await,
        422,
        "validation_failed",
    );
    assert_eq!(
        server.get("/api/v1/tasks").await.body["items"],
        json!([]),
        "nothing was created"
    );
}

#[tokio::test]
async fn domain_rules_answer_404_and_422() {
    let server = TestServer::new();
    let unknown_project = server
        .create_task(json!({"title": "x", "projectId": UNKNOWN_ID}))
        .await;
    assert_problem(&unknown_project, 404, "not_found");

    let blank = server.create_task(json!({"title": "   "})).await;
    assert_problem(&blank, 422, "validation_failed");
    assert_eq!(
        blank.body["errors"],
        json!([{"path": "title", "message": "title must not be empty"}])
    );

    let inverted = server
        .create_task(json!({"title": "x", "session": {"minMinutes": 90, "maxMinutes": 30}}))
        .await;
    assert_problem(&inverted, 422, "validation_failed");

    let missing = server
        .mutate(
            "PATCH",
            &format!("/api/v1/tasks/{UNKNOWN_ID}"),
            1,
            Some(json!({"title": "y"})),
        )
        .await;
    assert_problem(&missing, 404, "not_found");

    let blank_project = server
        .call(
            "POST",
            "/api/v1/projects",
            &[("idempotency-key", &server.key())],
            Some(json!({"title": " "})),
        )
        .await;
    assert_problem(&blank_project, 422, "validation_failed");
}

#[tokio::test]
async fn dependencies_are_added_and_cycles_refused() {
    let server = TestServer::new();
    let mut ids = Vec::new();
    for title in ["a", "b"] {
        ids.push(
            server.create_task(json!({"title": title})).await.body["id"]
                .as_str()
                .unwrap()
                .to_owned(),
        );
    }
    let (a, b) = (&ids[0], &ids[1]);

    let added = server
        .mutate(
            "POST",
            &format!("/api/v1/tasks/{b}/dependencies"),
            1,
            Some(json!({"dependsOnTaskId": a})),
        )
        .await;
    assert_eq!(added.status, 201, "{}", added.body);
    assert_eq!(added.body, json!({"taskId": b, "dependsOnTaskId": a}));
    assert_eq!(added.header("etag"), Some("W/\"2\""));
    assert_eq!(
        server.get(&format!("/api/v1/tasks/{b}")).await.body["dependsOn"],
        json!([a])
    );

    let cycle = server
        .mutate(
            "POST",
            &format!("/api/v1/tasks/{a}/dependencies"),
            1,
            Some(json!({"dependsOnTaskId": b})),
        )
        .await;
    assert_problem(&cycle, 422, "dependency_cycle");
    let unknown = server
        .mutate(
            "POST",
            &format!("/api/v1/tasks/{a}/dependencies"),
            1,
            Some(json!({"dependsOnTaskId": UNKNOWN_ID})),
        )
        .await;
    assert_problem(&unknown, 404, "not_found");
    assert_eq!(
        server.get(&format!("/api/v1/tasks/{a}")).await.body["version"],
        1
    );
}

#[tokio::test]
async fn an_idempotency_key_replays_the_first_response() {
    let server = TestServer::new();
    let key = server.key();
    let headers = [("idempotency-key", key.as_str())];
    let body = json!({"title": "Once"});
    let first = server
        .call("POST", "/api/v1/tasks", &headers, Some(body.clone()))
        .await;
    let replay = server
        .call("POST", "/api/v1/tasks", &headers, Some(body))
        .await;
    assert_eq!((first.status, replay.status), (201, 201));
    assert_eq!(replay.body, first.body);
    assert_eq!(replay.header("etag"), first.header("etag"));
    assert_eq!(
        server.get("/api/v1/tasks").await.body["items"]
            .as_array()
            .unwrap()
            .len(),
        1
    );

    let different = server
        .call(
            "POST",
            "/api/v1/tasks",
            &headers,
            Some(json!({"title": "Twice"})),
        )
        .await;
    assert_problem(&different, 422, "idempotency_mismatch");
    let other_route = server
        .call(
            "POST",
            "/api/v1/projects",
            &headers,
            Some(json!({"title": "Once"})),
        )
        .await;
    assert_problem(&other_route, 422, "idempotency_mismatch");
}

#[tokio::test]
async fn stored_and_unstored_failures_follow_the_storage_rule() {
    let server = TestServer::new();
    let id = server.create_task(json!({"title": "x"})).await.body["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let path = format!("/api/v1/tasks/{id}");

    // 422 is a stored domain result: the same key replays it, trace id included.
    let key = server.key();
    let headers = [("idempotency-key", key.as_str()), ("if-match", "W/\"1\"")];
    let first = server
        .call("PATCH", &path, &headers, Some(json!({"title": "  "})))
        .await;
    let replay = server
        .call("PATCH", &path, &headers, Some(json!({"title": "  "})))
        .await;
    assert_problem(&first, 422, "validation_failed");
    assert_eq!((replay.status, replay.code()), (422, "validation_failed"));
    assert_eq!(replay.body, first.body);
    assert!(
        replay
            .header("content-type")
            .unwrap()
            .starts_with("application/problem+json")
    );

    // 412 is not stored: the same key works once If-Match is corrected,
    // because If-Match is not part of the request hash.
    let key = server.key();
    let stale = server
        .call(
            "PATCH",
            &path,
            &[("idempotency-key", &key), ("if-match", "W/\"9\"")],
            Some(json!({"title": "y"})),
        )
        .await;
    assert_problem(&stale, 412, "version_conflict");
    let retried = server
        .call(
            "PATCH",
            &path,
            &[("idempotency-key", &key), ("if-match", "W/\"1\"")],
            Some(json!({"title": "y"})),
        )
        .await;
    assert_eq!((retried.status, &retried.body["title"]), (200, &json!("y")));

    // A replayed completion does not complete twice.
    let key = server.key();
    let headers = [("idempotency-key", key.as_str()), ("if-match", "W/\"2\"")];
    let done = server
        .call("POST", &format!("{path}:complete"), &headers, None)
        .await;
    let again = server
        .call("POST", &format!("{path}:complete"), &headers, None)
        .await;
    assert_eq!((done.status, again.status), (200, 200));
    assert_eq!(again.body["version"], 3);
    assert_eq!(server.get(&path).await.body["version"], 3);
}

#[tokio::test]
async fn lists_page_with_cursors_and_carry_content_etags() {
    let server = TestServer::new();
    let project = server
        .call(
            "POST",
            "/api/v1/projects",
            &[("idempotency-key", &server.key())],
            Some(json!({"title": "Thesis"})),
        )
        .await;
    assert_eq!(
        (project.status, project.header("etag")),
        (201, Some("W/\"1\""))
    );
    let project_id = project.body["id"].as_str().unwrap();
    for index in 0..3 {
        let body = if index == 0 {
            json!({"title": "t0", "projectId": project_id})
        } else {
            json!({"title": format!("t{index}")})
        };
        assert_eq!(server.create_task(body).await.status, 201);
    }

    let first = server.get("/api/v1/tasks?limit=2").await;
    assert_eq!(first.body["items"].as_array().unwrap().len(), 2);
    let cursor = first.body["nextCursor"].as_str().unwrap();
    let second = server
        .get(&format!("/api/v1/tasks?limit=2&cursor={cursor}"))
        .await;
    assert_eq!(second.body["items"].as_array().unwrap().len(), 1);
    assert_eq!(second.body["nextCursor"], Value::Null);
    assert_eq!(second.body["items"][0]["title"], "t2");

    let filtered = server
        .get(&format!("/api/v1/tasks?projectId={project_id}"))
        .await;
    assert_eq!(filtered.body["items"].as_array().unwrap().len(), 1);
    assert_eq!(
        server.get("/api/v1/tasks?status=done").await.body["items"],
        json!([])
    );

    let etag = first.header("etag").unwrap().to_owned();
    assert_eq!(
        server
            .call(
                "GET",
                "/api/v1/tasks?limit=2",
                &[("if-none-match", &etag)],
                None
            )
            .await
            .status,
        304
    );
    server.create_task(json!({"title": "t3"})).await;
    let all = server.get("/api/v1/tasks").await;
    assert_ne!(all.header("etag"), Some(etag.as_str()));

    let projects = server.get("/api/v1/projects").await;
    let kinds: Vec<&str> = projects.body["items"]
        .as_array()
        .unwrap()
        .iter()
        .map(|p| p["kind"].as_str().unwrap())
        .collect();
    assert_eq!(kinds, ["inbox", "normal"]);
}

/// Log output of the whole test binary. A process-wide subscriber is used
/// (not a scoped one) so that lines written from any thread are captured.
#[derive(Clone, Default)]
struct Captured(Arc<Mutex<Vec<u8>>>);

impl std::io::Write for Captured {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        self.0.lock().unwrap().extend_from_slice(bytes);
        Ok(bytes.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

fn captured_logs() -> &'static Captured {
    static CAPTURED: OnceLock<Captured> = OnceLock::new();
    CAPTURED.get_or_init(|| {
        let captured = Captured::default();
        let writer = captured.clone();
        let subscriber = tracing_subscriber::fmt()
            .json()
            .with_writer(move || writer.clone())
            .finish();
        tracing::subscriber::set_global_default(subscriber).unwrap();
        captured
    })
}

#[tokio::test]
async fn request_logs_hold_ids_and_codes_but_no_user_text_or_secrets() {
    let server = TestServer::new();
    let created = server
        .create_task(json!({"title": "SECRET-TITLE-7f3a", "description": "SECRET-BODY-91bc"}))
        .await;
    assert_eq!(created.status, 201);
    let rejected = server
        .create_task(json!({"title": "SECRET-TITLE-7f3a", "priority": "SECRET-VALUE-55"}))
        .await;
    assert_eq!(rejected.status, 400);
    assert!(
        !rejected.body.to_string().contains("SECRET-VALUE-55"),
        "{}",
        rejected.body
    );
    server.get("/api/v1/tasks?cursor=SECRET-QUERY-0c2d").await;
    server.get("/api/v1/SECRET-PATH-44aa").await;

    let logs = String::from_utf8(captured_logs().0.lock().unwrap().clone()).unwrap();
    let line = logs
        .lines()
        .find(|line| {
            line.contains("\"operation\":\"createTask\"") && line.contains("\"status\":201")
        })
        .unwrap_or_else(|| panic!("no request line for createTask in: {logs}"));
    assert!(line.contains("\"trace_id\":\"req-"), "{line}");
    assert!(
        line.contains("\"method\":\"POST\"") && line.contains("\"duration_ms\":"),
        "{line}"
    );
    assert!(
        logs.contains("\"status\":400") && logs.contains("\"status\":404"),
        "{logs}"
    );
    for secret in [
        "SECRET-TITLE",
        "SECRET-BODY",
        "SECRET-VALUE",
        "SECRET-QUERY",
        "SECRET-PATH",
        TOKEN,
    ] {
        assert!(
            !logs.contains(secret),
            "{secret} leaked into the logs: {logs}"
        );
    }
}
