//! The web app served from the core's origin (blueprint 15 §1.3), driven
//! through `handle` without a socket. The directory is a small fixture
//! shaped like the output of `vite build`; the real web app is not built
//! here. `tests-core/web.test.ts` repeats the essentials against the real
//! binary over a socket.

// Test code: a failed unwrap is a failed test.
#![allow(clippy::unwrap_used, clippy::expect_used)]

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicU32, Ordering};

use axum::body::Body;
use axum::http::{HeaderMap, Request};
use ohmydate_app::{App, OwnerDefaults};
use ohmydate_domain::UuidV7Generator;
use ohmydate_server::security::Guard;
use ohmydate_server::system::{OsRandom, SystemClock};
use ohmydate_server::web::{CONTENT_SECURITY_POLICY, WebRoot};
use ohmydate_server::{ServerState, handle};
use ohmydate_store::Store;
use serde_json::Value;

const TOKEN: &str = "5f3c9a1e5f3c9a1e5f3c9a1e5f3c9a1e5f3c9a1e5f3c9a1e5f3c9a1e5f3c9a1e";
const HOST: &str = "127.0.0.1:4310";
const FIXTURE: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/web");
const HTML: &str = "text/html; charset=utf-8";
const FOREVER: &str = "public, max-age=31536000, immutable";

/// A directory under the system temp dir, removed on drop.
struct TempDir(PathBuf);

impl TempDir {
    fn new(label: &str) -> Self {
        static COUNTER: AtomicU32 = AtomicU32::new(0);
        let path = std::env::temp_dir().join(format!(
            "ohmydate-web-{label}-{}-{}",
            std::process::id(),
            COUNTER.fetch_add(1, Ordering::SeqCst)
        ));
        std::fs::create_dir_all(&path).unwrap();
        Self(path)
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

struct TestServer {
    state: Arc<ServerState>,
    _data: TempDir,
}

struct Answer {
    status: u16,
    headers: HeaderMap,
    body: Vec<u8>,
}

impl Answer {
    fn header(&self, name: &str) -> Option<&str> {
        self.headers.get(name).and_then(|value| value.to_str().ok())
    }

    fn text(&self) -> String {
        String::from_utf8_lossy(&self.body).into_owned()
    }

    fn json(&self) -> Value {
        serde_json::from_slice(&self.body).unwrap()
    }
}

impl TestServer {
    /// A core that serves the web app in `web`, or none.
    fn new(web: Option<&Path>) -> Self {
        let data = TempDir::new("data");
        let store = Store::open(&data.0.join("ohmydate.db")).unwrap();
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
        let state = ServerState::new(Arc::new(app), Guard::new(TOKEN.to_owned(), 4310, &[]));
        let state = match web {
            Some(directory) => state.with_web(WebRoot::open(directory).unwrap()),
            None => state,
        };
        Self {
            state: Arc::new(state),
            _data: data,
        }
    }

    fn with_fixture() -> Self {
        Self::new(Some(Path::new(FIXTURE)))
    }

    /// A request as a browser without the launch cookie sends it.
    async fn request(&self, method: &str, path: &str, headers: &[(&str, &str)]) -> Answer {
        let mut builder = Request::builder().method(method).uri(path);
        if !headers.iter().any(|(name, _)| *name == "host") {
            builder = builder.header("host", HOST);
        }
        for (name, value) in headers {
            builder = builder.header(*name, *value);
        }
        let response = handle(&self.state, builder.body(Body::empty()).unwrap()).await;
        let status = response.status().as_u16();
        let headers = response.headers().clone();
        let body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap()
            .to_vec();
        Answer {
            status,
            headers,
            body,
        }
    }

    async fn get(&self, path: &str) -> Answer {
        self.request("GET", path, &[]).await
    }
}

fn fixture(relative: &str) -> Vec<u8> {
    std::fs::read(Path::new(FIXTURE).join(relative)).unwrap()
}

fn assert_document(answer: &Answer, path: &str) {
    assert_eq!(answer.status, 200, "{path}");
    assert_eq!(answer.header("content-type"), Some(HTML), "{path}");
    assert_eq!(answer.body, fixture("index.html"), "{path}");
    // The document names the current hashed files: it is never kept.
    assert_eq!(answer.header("cache-control"), Some("no-store"), "{path}");
}

fn assert_not_found(answer: &Answer, path: &str) {
    assert_eq!(answer.status, 404, "{path}: {}", answer.text());
    assert_eq!(
        answer.header("content-type"),
        Some("application/problem+json; charset=utf-8"),
        "{path}"
    );
    let body = answer.json();
    assert_eq!(body["code"], "not_found", "{path}");
    assert_eq!(body["detail"], "no route matches this request", "{path}");
    assert_eq!(body["traceId"].as_str(), answer.header("x-trace-id"));
}

#[tokio::test]
async fn the_document_answers_the_root_and_every_route_of_the_app() {
    let server = TestServer::with_fixture();
    for path in [
        "/",
        "/?source=launcher",
        "/index.html",
        "/overview",
        "/tasks",
        "/tasks/0193a8f2-6c1e-7b41-9a2e-1f1d6a0b3c55",
        "/tasks/",
        "/plan/schedule/0193a8f2-6c1e-7b41-9a2e-1f1d6a0b3c55?step=2",
        "/settings/display",
        "/login",
        "/a/route/the/app/does/not/have",
        // Looks like the API, is not under it.
        "/apix/v1/me",
        "/%EB%85%B8%ED%8A%B8",
    ] {
        let answer = server.get(path).await;
        assert_document(&answer, path);
        assert!(answer.header("x-trace-id").unwrap().starts_with("req-"));
    }
}

#[tokio::test]
async fn every_file_carries_the_security_headers() {
    let server = TestServer::with_fixture();
    for path in [
        "/",
        "/overview",
        "/assets/index-B3xY9aZ1.js",
        "/assets/PretendardVariable-Zx81kQpL.woff2",
        "/favicon.svg",
        "/LICENSE",
    ] {
        let answer = server.get(path).await;
        assert_eq!(answer.status, 200, "{path}");
        assert_eq!(
            answer.header("content-security-policy"),
            Some(CONTENT_SECURITY_POLICY),
            "{path}"
        );
        assert_eq!(answer.header("x-content-type-options"), Some("nosniff"));
        assert_eq!(answer.header("referrer-policy"), Some("no-referrer"));
        assert_eq!(
            answer.header("cross-origin-resource-policy"),
            Some("same-origin")
        );
        // Public files: no cookie is set and none is asked for.
        assert!(answer.header("set-cookie").is_none());
        assert!(answer.header("www-authenticate").is_none());
    }
}

#[tokio::test]
async fn files_have_their_type_and_only_hashed_assets_are_kept() {
    let server = TestServer::with_fixture();
    let javascript = "text/javascript; charset=utf-8";
    for (path, content_type, cache_control) in [
        ("/assets/index-B3xY9aZ1.js", javascript, FOREVER),
        // The lazily imported chunk (three.js in the real build).
        ("/assets/three-C0ffee12.js", javascript, FOREVER),
        (
            "/assets/index-Dq8FhP2c.css",
            "text/css; charset=utf-8",
            FOREVER,
        ),
        (
            "/assets/PretendardVariable-Zx81kQpL.woff2",
            "font/woff2",
            FOREVER,
        ),
        ("/assets/glass-orb-9aBcD_eF.webp", "image/webp", FOREVER),
        // In the asset directory, but its name promises nothing.
        ("/assets/unhashed.js", javascript, "no-cache"),
        // Fixed names next to the document.
        ("/mockServiceWorker.js", javascript, "no-cache"),
        ("/favicon.svg", "image/svg+xml", "no-cache"),
        // Unknown kinds are bytes to download, never something that runs.
        ("/LICENSE", "application/octet-stream", "no-cache"),
        ("/README.md", "application/octet-stream", "no-cache"),
    ] {
        let answer = server.get(path).await;
        assert_eq!(answer.status, 200, "{path}");
        assert_eq!(answer.header("content-type"), Some(content_type), "{path}");
        assert_eq!(
            answer.header("cache-control"),
            Some(cache_control),
            "{path}"
        );
        assert_eq!(answer.body, fixture(&path[1..]), "{path}");
    }
    // A query string does not change which file it is.
    let versioned = server.get("/assets/index-B3xY9aZ1.js?v=2").await;
    assert_eq!(versioned.body, fixture("assets/index-B3xY9aZ1.js"));
}

#[tokio::test]
async fn a_missing_file_is_404_and_never_the_document() {
    let server = TestServer::with_fixture();
    for path in [
        // A stale chunk after an update: HTML here would fail unreadably.
        "/assets/index-AAAA1111.js",
        "/assets/gone",
        "/favicon.ico",
        "/robots.txt",
        "/tasks/export.csv",
        "/index.htm",
        // Directories are neither files nor listed.
        "/assets",
        "/assets/",
    ] {
        assert_not_found(&server.get(path).await, path);
    }
}

#[tokio::test]
async fn reserved_paths_stay_with_the_core() {
    let server = TestServer::with_fixture();
    for path in [
        "/api",
        "/api/",
        "/api/v2/tasks",
        "/api/v1x/me",
        "/%61pi/v1/me",
        "/__nothing",
        "/__boot/extra",
        "/healthz/extra",
        "/readyz/",
    ] {
        assert_not_found(&server.get(path).await, path);
    }
    // The API answers as it does without a web directory: guarded, JSON.
    let unknown = server.get("/api/v1/does-not-exist").await;
    assert_not_found(&unknown, "/api/v1/does-not-exist");
    let guarded = server.get("/api/v1/me").await;
    assert_eq!(guarded.status, 401);
    assert_eq!(guarded.json()["code"], "unauthenticated");
    let me = server
        .request(
            "GET",
            "/api/v1/me",
            &[("authorization", &format!("Bearer {TOKEN}"))],
        )
        .await;
    assert_eq!(me.status, 200);
    assert!(me.header("content-security-policy").is_none());
    let health = server.get("/healthz").await;
    assert_eq!(
        (health.status, health.text().as_str()),
        (200, "{\"status\":\"ok\"}")
    );
}

#[tokio::test]
async fn hostile_paths_get_nothing() {
    let server = TestServer::with_fixture();
    for path in [
        "/..",
        "/../",
        "/../etc/passwd",
        "/../../../../../../etc/passwd",
        "/assets/../index.html",
        "/assets/../../../../etc/passwd",
        "/assets/../.hidden",
        "/./index.html",
        // Escaped.
        "/%2e%2e/%2e%2e/%2e%2e/etc/passwd",
        "/%2E%2E/%2E%2E/etc/passwd",
        "/assets/%2e%2e/index.html",
        "/.%2e/.%2e/etc/passwd",
        "/assets/..%2f..%2f..%2fetc%2fpasswd",
        "/assets%2f..%2f.hidden",
        "/..%5c..%5cetc%5cpasswd",
        "/%5c..%5c.hidden",
        // Escaped twice: an odd name that exists nowhere.
        "/assets/%252e%252e/index.html",
        // Absolute, and with empty segments.
        "//etc/passwd",
        "///etc/passwd",
        "/assets//index-B3xY9aZ1.js",
        // Hidden files, present or not.
        "/.hidden",
        "/%2ehidden",
        "/.env",
        "/.git/config",
        // Bytes cut short, controls, other separators.
        "/index.html%00",
        "/index.html%00.png",
        "/.hidden%00.png",
        "/assets/index-B3xY9aZ1.js%0d%0aSet-Cookie:x=1",
        "/c:/windows/win.ini",
        "/%",
        "/%zz",
        "/%ff%fe",
    ] {
        let answer = server.get(path).await;
        assert_not_found(&answer, path);
        let text = answer.text();
        for leaked in ["HIDDEN-FILE-CONTENT", "root:", "<!doctype", path] {
            assert!(!text.contains(leaked), "{path} answered {text}");
        }
        assert!(answer.header("set-cookie").is_none(), "{path}");
    }
}

#[tokio::test]
async fn a_link_out_of_the_directory_is_not_followed() {
    let outside = TempDir::new("outside");
    std::fs::write(outside.0.join("secret.txt"), "OUTSIDE-FILE-CONTENT").unwrap();
    std::fs::create_dir_all(outside.0.join("private")).unwrap();
    std::fs::write(outside.0.join("private/notes.txt"), "OUTSIDE-FILE-CONTENT").unwrap();

    let web = TempDir::new("root");
    std::fs::create_dir_all(web.0.join("assets")).unwrap();
    std::fs::write(web.0.join("index.html"), "<!doctype html><p>linked</p>").unwrap();
    std::fs::write(web.0.join("assets/real-B3xY9aZ1.js"), "export {};").unwrap();
    let link = std::os::unix::fs::symlink;
    link(
        outside.0.join("secret.txt"),
        web.0.join("assets/leak-B3xY9aZ1.txt"),
    )
    .unwrap();
    link(outside.0.join("secret.txt"), web.0.join("leak")).unwrap();
    link(outside.0.join("private"), web.0.join("assets/private")).unwrap();
    link(PathBuf::from("/etc/hostname"), web.0.join("hostname.txt")).unwrap();
    // A link that stays inside the directory is an ordinary file.
    link(
        web.0.join("assets/real-B3xY9aZ1.js"),
        web.0.join("alias.js"),
    )
    .unwrap();

    let server = TestServer::new(Some(&web.0));
    for path in [
        "/assets/leak-B3xY9aZ1.txt",
        "/assets/private/notes.txt",
        "/hostname.txt",
    ] {
        let answer = server.get(path).await;
        assert_not_found(&answer, path);
        assert!(!answer.text().contains("OUTSIDE-FILE-CONTENT"), "{path}");
    }
    // A name without a dot is a route of the app: the document, not the
    // file the link points at.
    let route = server.get("/leak").await;
    assert_eq!(route.status, 200);
    assert_eq!(route.text(), "<!doctype html><p>linked</p>");

    let alias = server.get("/alias.js").await;
    assert_eq!((alias.status, alias.text().as_str()), (200, "export {};"));
    assert_eq!(alias.header("cache-control"), Some("no-cache"));
}

#[tokio::test]
async fn only_reads_are_answered_and_head_has_no_body() {
    let server = TestServer::with_fixture();
    for path in ["/", "/overview", "/assets/index-B3xY9aZ1.js"] {
        let get = server.get(path).await;
        let head = server.request("HEAD", path, &[]).await;
        assert_eq!(head.status, 200, "{path}");
        assert!(head.body.is_empty(), "{path}");
        assert_eq!(
            head.header("content-length"),
            Some(get.body.len().to_string().as_str()),
            "{path}"
        );
        for name in ["content-type", "cache-control", "content-security-policy"] {
            assert_eq!(head.header(name), get.header(name), "{path} {name}");
        }
        for method in ["POST", "PUT", "PATCH", "DELETE", "OPTIONS"] {
            let answer = server.request(method, path, &[]).await;
            assert_not_found(&answer, path);
        }
    }
    let missing = server.request("HEAD", "/assets/gone.js", &[]).await;
    assert_eq!(missing.status, 404);
}

#[tokio::test]
async fn the_host_check_covers_the_web_app() {
    let server = TestServer::with_fixture();
    for host in ["attacker.example", "127.0.0.1:9999", "127.0.0.1", ""] {
        for path in ["/", "/assets/index-B3xY9aZ1.js", "/overview"] {
            let answer = server.request("GET", path, &[("host", host)]).await;
            assert_eq!(answer.status, 403, "{host} {path}");
            assert_eq!(answer.json()["code"], "forbidden");
            assert!(!answer.text().contains("doctype"));
        }
    }
    let by_name = server
        .request("GET", "/", &[("host", "localhost:4310")])
        .await;
    assert_document(&by_name, "/ as localhost");
}

#[tokio::test]
async fn without_a_web_directory_nothing_is_served_outside_the_api() {
    let server = TestServer::new(None);
    for path in [
        "/",
        "/index.html",
        "/overview",
        "/assets/index-B3xY9aZ1.js",
        "/favicon.svg",
    ] {
        assert_not_found(&server.get(path).await, path);
        assert_eq!(server.request("HEAD", path, &[]).await.status, 404);
    }
    assert_eq!(server.get("/healthz").await.status, 200);
}

#[tokio::test]
async fn boot_sets_the_cookie_and_lands_on_the_document() {
    let server = TestServer::with_fixture();
    let boot = server.get(&format!("/__boot?token={TOKEN}")).await;
    assert_eq!(boot.status, 303);
    assert_eq!(boot.header("location"), Some("/"));
    assert!(boot.body.is_empty());
    // Exactly the cookie of blueprint 15 §1.3. Never `Secure`: the desktop
    // webview is WebKit, which does not keep a Secure cookie set by
    // http://127.0.0.1 — the app would boot and then be signed out.
    let set_cookie = boot.header("set-cookie").unwrap();
    assert_eq!(
        set_cookie,
        format!("omd_launch={TOKEN}; Path=/; HttpOnly; SameSite=Strict")
    );
    assert!(!set_cookie.to_ascii_lowercase().contains("secure"));
    assert_eq!(boot.headers.get_all("set-cookie").iter().count(), 1);
    // The address held the token: it is not kept and not passed on.
    assert_eq!(boot.header("cache-control"), Some("no-store"));
    assert_eq!(boot.header("referrer-policy"), Some("no-referrer"));

    // Where the redirect leads, with the cookie the browser now has.
    let cookie = set_cookie.split(';').next().unwrap();
    let landing = server.request("GET", "/", &[("cookie", cookie)]).await;
    assert_document(&landing, "/ after boot");
    let me = server
        .request("GET", "/api/v1/me", &[("cookie", cookie)])
        .await;
    assert_eq!(me.status, 200);
    // A mutation from the page: its Origin is the core's own.
    let patch = Request::builder()
        .method("PATCH")
        .uri("/api/v1/me/settings")
        .header("host", HOST)
        .header("cookie", cookie)
        .header("origin", format!("http://{HOST}"))
        .header("if-match", "W/\"1\"")
        .header("idempotency-key", "0193a8f2-6c1e-4b41-9a2e-000000000001")
        .header("content-type", "application/json")
        .body(Body::from("{\"locale\":\"en-GB\"}"))
        .unwrap();
    assert_eq!(handle(&server.state, patch).await.status().as_u16(), 200);

    // The token position does not matter; the first `token` is the one read.
    for query in [
        format!("source=shell&token={TOKEN}"),
        format!("token={TOKEN}&token=other"),
    ] {
        let again = server.get(&format!("/__boot?{query}")).await;
        assert_eq!(again.status, 303, "{query}");
    }
}

#[tokio::test]
async fn a_wrong_or_missing_token_gets_no_cookie_and_one_answer() {
    let server = TestServer::with_fixture();
    let mut answers = Vec::new();
    for target in [
        "/__boot".to_owned(),
        "/__boot?".to_owned(),
        "/__boot?token".to_owned(),
        "/__boot?token=".to_owned(),
        "/__boot?token=nope".to_owned(),
        // Close is not right: a prefix, one character more, one changed.
        format!("/__boot?token={}", &TOKEN[..63]),
        format!("/__boot?token={TOKEN}0"),
        format!("/__boot?token={}", TOKEN.replace('5', "6")),
        format!("/__boot?token={}", TOKEN.to_ascii_uppercase()),
        // Not the `token` parameter.
        format!("/__boot?Token={TOKEN}"),
        format!("/__boot?xtoken={TOKEN}"),
        format!("/__boot?token=other&token={TOKEN}"),
        format!("/__boot?token=%20{TOKEN}"),
    ] {
        let answer = server.get(&target).await;
        assert_eq!(answer.status, 401, "{target}");
        assert!(answer.header("set-cookie").is_none(), "{target}");
        assert!(answer.header("location").is_none(), "{target}");
        let mut body = answer.json();
        assert_eq!(body["code"], "unauthenticated");
        // The reply says nothing about the attempt: not the token, not
        // what was sent, not how close it was.
        let text = answer.text();
        assert!(!text.contains(TOKEN) && !text.contains("nope"), "{text}");
        body.as_object_mut().unwrap().remove("traceId");
        answers.push(body);
    }
    assert!(
        answers.windows(2).all(|pair| pair[0] == pair[1]),
        "every refused attempt reads the same: {answers:?}"
    );

    // Only GET hands out the cookie.
    for method in ["POST", "HEAD", "PUT"] {
        let answer = server
            .request(method, &format!("/__boot?token={TOKEN}"), &[])
            .await;
        assert_eq!(answer.status, 404, "{method}");
        assert!(answer.header("set-cookie").is_none(), "{method}");
    }
    // And only for the core's own host name.
    let rebound = server
        .request(
            "GET",
            &format!("/__boot?token={TOKEN}"),
            &[("host", "attacker.example")],
        )
        .await;
    assert_eq!(rebound.status, 403);
    assert!(rebound.header("set-cookie").is_none());
}
