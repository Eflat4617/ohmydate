//! Who may talk to the core.
//!
//! The core listens on 127.0.0.1 only, but loopback is shared: other local
//! users, and any web page open in a browser on this machine, can reach the
//! port. Three checks close that:
//!
//! 1. **Launch token.** A 256-bit secret created at every start. Only the
//!    process that started the core (the desktop shell, a test harness) knows
//!    it. It is sent as `Authorization: Bearer <token>` or as the `omd_launch`
//!    cookie the shell's webview receives from `/__boot`. This replaces
//!    login, sessions and CSRF tokens of the server version.
//! 2. **Host.** Requests must be addressed to the loopback name and port the
//!    core listens on, which defeats DNS rebinding.
//! 3. **Origin.** A browser-sent `Origin` on a mutation must be the core's own
//!    origin (or one explicitly allowed for development).

use axum::http::{HeaderMap, Method, header};

use crate::problem::Problem;

/// Name of the cookie that carries the launch token in the webview.
pub const LAUNCH_COOKIE: &str = "omd_launch";

/// The access rules of one running core.
#[derive(Clone)]
pub struct Guard {
    token: String,
    hosts: Vec<String>,
    origins: Vec<String>,
}

impl std::fmt::Debug for Guard {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // The token is a secret: never print it.
        formatter
            .debug_struct("Guard")
            .field("hosts", &self.hosts)
            .finish_non_exhaustive()
    }
}

/// Compares without an early exit, so timing does not reveal how many
/// leading bytes of a guess were right.
fn constant_time_eq(left: &[u8], right: &[u8]) -> bool {
    left.len() == right.len()
        && left
            .iter()
            .zip(right)
            .fold(0_u8, |difference, (a, b)| difference | (a ^ b))
            == 0
}

impl Guard {
    /// `port` is the loopback port the core listens on. `extra_origins` are
    /// additional browser origins allowed to send mutations (development
    /// servers such as Vite's); production passes none.
    #[must_use]
    pub fn new(token: String, port: u16, extra_origins: &[String]) -> Self {
        let hosts = vec![format!("127.0.0.1:{port}"), format!("localhost:{port}")];
        let mut origins: Vec<String> = hosts.iter().map(|host| format!("http://{host}")).collect();
        origins.extend(extra_origins.iter().cloned());
        Self {
            token,
            hosts,
            origins,
        }
    }

    /// True when `candidate` is the launch token.
    #[must_use]
    pub fn token_matches(&self, candidate: &str) -> bool {
        constant_time_eq(candidate.as_bytes(), self.token.as_bytes())
    }

    /// The `Set-Cookie` value that hands the token to the webview.
    #[must_use]
    pub fn launch_cookie(&self) -> String {
        format!(
            "{LAUNCH_COOKIE}={}; Path=/; HttpOnly; SameSite=Strict",
            self.token
        )
    }

    /// Rejects requests addressed to another host name (DNS rebinding).
    pub fn check_host(&self, headers: &HeaderMap) -> Result<(), Problem> {
        let host = headers
            .get(header::HOST)
            .and_then(|value| value.to_str().ok())
            .unwrap_or("");
        if self
            .hosts
            .iter()
            .any(|allowed| allowed.eq_ignore_ascii_case(host))
        {
            Ok(())
        } else {
            Err(Problem::forbidden(
                "this server only answers on its loopback address",
            ))
        }
    }

    /// Requires the launch token as a bearer token or as the launch cookie.
    pub fn check_token(&self, headers: &HeaderMap) -> Result<(), Problem> {
        let bearer = headers
            .get(header::AUTHORIZATION)
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.strip_prefix("Bearer "));
        let cookie = headers
            .get_all(header::COOKIE)
            .iter()
            .filter_map(|value| value.to_str().ok())
            .flat_map(|value| value.split(';'))
            .filter_map(|pair| pair.trim().split_once('='))
            .find(|(name, _)| *name == LAUNCH_COOKIE)
            .map(|(_, value)| value);
        match bearer.or(cookie) {
            Some(candidate) if self.token_matches(candidate) => Ok(()),
            _ => Err(Problem::unauthenticated()),
        }
    }

    /// Rejects mutations a browser sends from another origin.
    pub fn check_origin(&self, method: &Method, headers: &HeaderMap) -> Result<(), Problem> {
        if matches!(*method, Method::GET | Method::HEAD | Method::OPTIONS) {
            return Ok(());
        }
        match headers
            .get(header::ORIGIN)
            .map(|value| value.to_str().unwrap_or(""))
        {
            None => Ok(()),
            Some(origin) if self.origins.iter().any(|allowed| allowed == origin) => Ok(()),
            Some(_) => Err(Problem::forbidden("cross-origin requests are not accepted")),
        }
    }
}

#[cfg(test)]
mod tests {
    use axum::http::HeaderValue;

    use super::*;

    const TOKEN: &str = "5f3c9a1e5f3c9a1e5f3c9a1e5f3c9a1e5f3c9a1e5f3c9a1e5f3c9a1e5f3c9a1e";

    fn guard() -> Guard {
        Guard::new(
            TOKEN.to_owned(),
            4310,
            &["http://127.0.0.1:5173".to_owned()],
        )
    }

    fn headers(pairs: &[(&'static str, &str)]) -> HeaderMap {
        let mut map = HeaderMap::new();
        for (name, value) in pairs {
            map.append(*name, HeaderValue::from_str(value).unwrap());
        }
        map
    }

    #[test]
    fn the_token_is_accepted_as_bearer_or_cookie() {
        let guard = guard();
        assert!(
            guard
                .check_token(&headers(&[("authorization", &format!("Bearer {TOKEN}"))]))
                .is_ok()
        );
        assert!(
            guard
                .check_token(&headers(&[(
                    "cookie",
                    &format!("theme=dark; {LAUNCH_COOKIE}={TOKEN}")
                )]))
                .is_ok()
        );
        assert!(
            guard
                .launch_cookie()
                .starts_with(&format!("{LAUNCH_COOKIE}={TOKEN}; "))
        );
        assert!(
            guard.launch_cookie().contains("HttpOnly")
                && guard.launch_cookie().contains("SameSite=Strict")
        );
    }

    #[test]
    fn a_missing_or_wrong_token_is_unauthenticated() {
        let guard = guard();
        let wrong = format!("Bearer {}", TOKEN.replace('5', "6"));
        for pairs in [
            vec![],
            vec![("authorization", wrong.as_str())],
            vec![("authorization", "Bearer ")],
            vec![("authorization", TOKEN)],
            vec![("cookie", "omd_launch=nope")],
            vec![("cookie", "other=1")],
        ] {
            let problem = guard.check_token(&headers(&pairs)).unwrap_err();
            assert_eq!(
                (problem.status, problem.code.as_str()),
                (401, "unauthenticated")
            );
        }
    }

    #[test]
    fn only_the_loopback_host_and_port_are_served() {
        let guard = guard();
        assert!(
            guard
                .check_host(&headers(&[("host", "127.0.0.1:4310")]))
                .is_ok()
        );
        assert!(
            guard
                .check_host(&headers(&[("host", "LOCALHOST:4310")]))
                .is_ok()
        );
        for host in ["evil.example:4310", "127.0.0.1:9999", "127.0.0.1", ""] {
            let problem = guard.check_host(&headers(&[("host", host)])).unwrap_err();
            assert_eq!(
                (problem.status, problem.code.as_str()),
                (403, "forbidden"),
                "{host}"
            );
        }
        assert!(guard.check_host(&HeaderMap::new()).is_err());
    }

    #[test]
    fn mutations_from_foreign_origins_are_refused() {
        let guard = guard();
        let foreign = headers(&[("origin", "https://evil.example")]);
        assert!(
            guard.check_origin(&Method::GET, &foreign).is_ok(),
            "reads have no side effects"
        );
        assert_eq!(
            guard
                .check_origin(&Method::POST, &foreign)
                .unwrap_err()
                .status,
            403
        );
        assert_eq!(
            guard
                .check_origin(&Method::DELETE, &headers(&[("origin", "null")]))
                .unwrap_err()
                .status,
            403
        );
        assert!(
            guard
                .check_origin(
                    &Method::POST,
                    &headers(&[("origin", "http://127.0.0.1:4310")])
                )
                .is_ok()
        );
        assert!(
            guard
                .check_origin(
                    &Method::PATCH,
                    &headers(&[("origin", "http://127.0.0.1:5173")])
                )
                .is_ok()
        );
        assert!(
            guard.check_origin(&Method::POST, &HeaderMap::new()).is_ok(),
            "non-browser clients send no Origin"
        );
    }

    #[test]
    fn debug_output_does_not_contain_the_token() {
        assert!(!format!("{:?}", guard()).contains(TOKEN));
    }
}
