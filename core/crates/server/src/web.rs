//! The web app, served from the same origin as the API (blueprint 15 §1.3).
//!
//! `--web-dir` names a directory holding a built single-page app (the
//! output of `vite build`): an `index.html`, content-hashed files under
//! `assets/`, and a few files with fixed names next to the document.
//!
//! What a path gets:
//!
//! * a file of the directory → that file;
//! * `/`, or a path that names no file → the document, because the app
//!   routes in the browser (history mode) and `/tasks/<id>` must load it;
//! * a missing path that *names a file* — anything under `assets/`, or a
//!   last segment with a dot (`/favicon.ico`) → 404, never the document: a
//!   script request answered with HTML fails in a way nobody can read;
//! * a reserved path (`/api…`, `/healthz`, `/readyz`, `/__…`) → 404: those
//!   belong to the core, with or without a handler;
//! * a path that is not plainly a name inside the directory (`..`, an empty
//!   segment, a dot file, an encoded slash, a backslash, a control
//!   character, a broken escape) → 404, without looking at the disk.
//!
//! Nothing is listed: a directory is never a file. A link that leaves the
//! directory is not followed.
//!
//! The files are public — no launch token is asked for: they are the app's
//! code, not the owner's data, and the page must be able to load and say
//! "open me from the app" when the cookie is missing. The host check still
//! applies to them (see [`crate::security`]).

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

/// What a page served by the core may load and do. Checked against the real
/// build of `apps/web` in Chromium and WebKit (RC-10A): it runs — font,
/// style sheet, route chunks, the lazily imported three.js chunk, a WebGL
/// context with a compiled shader — with no violation, while `eval`, an
/// inline script, a remote image and a fetch to another origin are refused.
///
/// * `script-src 'self'` — the point of the policy. The page talks to the API
///   with the launch cookie, so a script injected into it would have the
///   owner's data. Only files of this origin run: the entry module and its
///   chunks all come from `assets/`. No inline script and no `eval`: the
///   build has neither (Vue templates are compiled at build time, and WebGL
///   shaders are not script).
/// * `style-src 'self'` with `style-src-attr 'unsafe-inline'` — style sheets
///   are files of the build, so no `<style>` element is allowed. `style="…"`
///   attributes are: Vue writes most styles through the DOM (which no policy
///   restricts), but it inserts large static blocks of a template as markup,
///   and an attribute in such a block would silently lose its effect in the
///   packaged app only. An attribute styles one element and cannot reach the
///   network. An engine that does not know `style-src-attr` falls back to
///   `style-src 'self'`, under which today's build also runs.
/// * `img-src 'self' data:` — the build tool turns any image under 4 KiB into
///   a `data:` address on its own. No address on another host: a note cannot
///   make the page fetch a remote image.
/// * `font-src 'self'` — the bundled text face.
/// * `connect-src 'self'` — the API. The page itself reaches nothing else;
///   the AI provider and Google are called by the core.
/// * `worker-src 'self'`, `object-src 'none'`, `base-uri 'none'`,
///   `form-action 'self'` — what the page does not use stays closed.
/// * `frame-ancestors 'none'` — no other page may put this one in a frame.
/// * `default-src 'self'` — anything not named above (media, a manifest)
///   comes from this origin or not at all.
pub const CONTENT_SECURITY_POLICY: &str = "default-src 'self'; script-src 'self'; \
     style-src 'self'; style-src-attr 'unsafe-inline'; img-src 'self' data:; font-src 'self'; \
     connect-src 'self'; worker-src 'self'; object-src 'none'; base-uri 'none'; \
     form-action 'self'; frame-ancestors 'none'";

/// A year, and a promise that the bytes behind the name never change.
const CACHE_FOREVER: &str = "public, max-age=31536000, immutable";
/// May be kept, must be asked for again: a file whose name says nothing
/// about its content.
const CACHE_REVALIDATE: &str = "no-cache";
/// The document names the current hashed files; a kept copy would pin an
/// old build.
const CACHE_NEVER: &str = "no-store";

const DOCUMENT: &str = "index.html";
/// Where the build puts files whose names carry a content hash.
const ASSET_DIRECTORY: &str = "assets";

/// A file ready to be sent.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Asset {
    pub content_type: &'static str,
    pub cache_control: &'static str,
    pub body: Vec<u8>,
}

impl Asset {
    /// Headers every file of the web app carries, the document and its
    /// parts alike.
    #[must_use]
    pub fn headers(&self) -> [(&'static str, &'static str); 6] {
        [
            ("Content-Type", self.content_type),
            ("Cache-Control", self.cache_control),
            ("Content-Security-Policy", CONTENT_SECURITY_POLICY),
            // The type above is the type: no guessing from the bytes.
            ("X-Content-Type-Options", "nosniff"),
            // Links that leave the app do not say where they came from.
            ("Referrer-Policy", "no-referrer"),
            // A page of another origin cannot embed these files.
            ("Cross-Origin-Resource-Policy", "same-origin"),
        ]
    }
}

/// What a request path asks the web directory for.
#[derive(Debug, Clone, PartialEq, Eq)]
enum Route {
    /// The document: `/`, or a route of the app.
    Document,
    /// A name inside the directory. When no such file exists the answer is
    /// the document if `or_document`, else nothing.
    File { relative: String, or_document: bool },
    /// A reserved path, or one that is not a plain name.
    Nothing,
}

fn hex_value(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}

/// One path segment with its `%XX` escapes resolved. `None` for a broken
/// escape or bytes that are not UTF-8: such a path names nothing.
fn decode_segment(segment: &str) -> Option<String> {
    let bytes = segment.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' {
            let high = bytes.get(index + 1).copied().and_then(hex_value)?;
            let low = bytes.get(index + 2).copied().and_then(hex_value)?;
            decoded.push(high * 16 + low);
            index += 3;
        } else {
            decoded.push(bytes[index]);
            index += 1;
        }
    }
    String::from_utf8(decoded).ok()
}

/// True for a segment that can only be a file or directory name: not empty,
/// not hidden (which also excludes `.` and `..`), and free of separators and
/// control characters once decoded.
fn is_plain_name(segment: &str) -> bool {
    !segment.is_empty()
        && !segment.starts_with('.')
        && !segment
            .chars()
            .any(|c| matches!(c, '/' | '\\' | ':') || c.is_control())
}

/// Paths the core keeps for itself, whether or not something answers there.
fn is_reserved(first_segment: &str) -> bool {
    matches!(first_segment, "api" | "healthz" | "readyz") || first_segment.starts_with("__")
}

fn route(path: &str) -> Route {
    let Some(rest) = path.strip_prefix('/') else {
        return Route::Nothing;
    };
    if rest.is_empty() {
        return Route::Document;
    }
    // Split first, decode second: an encoded slash stays inside its segment,
    // where it is refused.
    let (rest, is_directory) = match rest.strip_suffix('/') {
        Some(without) => (without, true),
        None => (rest, false),
    };
    let mut segments = Vec::new();
    for raw in rest.split('/') {
        match decode_segment(raw) {
            Some(segment) if is_plain_name(&segment) => segments.push(segment),
            _ => return Route::Nothing,
        }
    }
    let (Some(first), Some(last)) = (segments.first(), segments.last()) else {
        return Route::Nothing;
    };
    if is_reserved(first) {
        return Route::Nothing;
    }
    let names_a_file = first == ASSET_DIRECTORY || last.contains('.');
    if is_directory {
        // `/tasks/` is a route written with a slash; `/assets/` is a
        // directory, and directories are not listed.
        return if names_a_file {
            Route::Nothing
        } else {
            Route::Document
        };
    }
    Route::File {
        relative: segments.join("/"),
        or_document: !names_a_file,
    }
}

/// The media type for a file name. Unknown extensions are sent as bytes to
/// download, never as something a browser would run.
fn content_type(name: &str) -> &'static str {
    let extension = name
        .rsplit_once('.')
        .map(|(_, extension)| extension.to_ascii_lowercase());
    match extension.as_deref() {
        Some("html") => "text/html; charset=utf-8",
        Some("js" | "mjs") => "text/javascript; charset=utf-8",
        Some("css") => "text/css; charset=utf-8",
        Some("json" | "map") => "application/json; charset=utf-8",
        Some("webmanifest") => "application/manifest+json; charset=utf-8",
        Some("txt") => "text/plain; charset=utf-8",
        Some("svg") => "image/svg+xml",
        Some("png") => "image/png",
        Some("jpg" | "jpeg") => "image/jpeg",
        Some("webp") => "image/webp",
        Some("avif") => "image/avif",
        Some("gif") => "image/gif",
        Some("ico") => "image/x-icon",
        Some("woff2") => "font/woff2",
        Some("woff") => "font/woff",
        Some("ttf") => "font/ttf",
        Some("otf") => "font/otf",
        Some("wasm") => "application/wasm",
        _ => "application/octet-stream",
    }
}

/// True when the name carries a content hash the way the build writes it:
/// under `assets/`, `<label>-<8 characters>.<extension>` — the label may
/// have dots of its own (`three.module-C0ffee12.js`), and more extensions
/// may follow (`index-B3xY9aZ1.js.map`). The eight characters must not be
/// all lower-case letters, so that a hand-named `app-settings.js` is not
/// mistaken for one: a file wrongly kept for a year is worse than one
/// fetched again.
fn is_content_hashed(relative: &str) -> bool {
    let Some(name) = relative
        .strip_prefix(ASSET_DIRECTORY)
        .and_then(|rest| rest.strip_prefix('/'))
        .and_then(|rest| rest.rsplit('/').next())
    else {
        return false;
    };
    let is_hash = |hash: &str| {
        hash.chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-'))
            && !hash.chars().all(|c| c.is_ascii_lowercase())
    };
    // Every dot is tried as the one that ends the hash.
    name.match_indices('.').any(|(dot, _)| {
        dot.checked_sub(8)
            .and_then(|at| name[..dot].split_at_checked(at))
            .is_some_and(|(label, hash)| label.len() > 1 && label.ends_with('-') && is_hash(hash))
    })
}

fn cache_control(relative: &str) -> &'static str {
    if relative == DOCUMENT {
        CACHE_NEVER
    } else if is_content_hashed(relative) {
        CACHE_FOREVER
    } else {
        CACHE_REVALIDATE
    }
}

/// Why a directory cannot be served.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WebRootError {
    /// The path is not a directory that can be read.
    NotADirectory,
    /// The directory has no `index.html`.
    NoDocument,
}

impl std::fmt::Display for WebRootError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(match self {
            WebRootError::NotADirectory => "the web directory cannot be read",
            WebRootError::NoDocument => "the web directory has no index.html",
        })
    }
}

impl std::error::Error for WebRootError {}

/// The answer of the web directory to one path.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Found {
    Asset(Asset),
    /// Nothing is served at this path.
    Nothing,
    /// The document was there at start and cannot be read now.
    Broken(io::ErrorKind),
}

/// A directory holding the built web app.
#[derive(Debug, Clone)]
pub struct WebRoot {
    /// Real path of the directory: every file served resolves below it.
    root: PathBuf,
}

impl WebRoot {
    /// Checks that `directory` holds a web app.
    pub fn open(directory: &Path) -> Result<Self, WebRootError> {
        let root = fs::canonicalize(directory).map_err(|_| WebRootError::NotADirectory)?;
        if !root.is_dir() {
            return Err(WebRootError::NotADirectory);
        }
        let web = Self { root };
        if web.read(DOCUMENT).is_none() {
            return Err(WebRootError::NoDocument);
        }
        Ok(web)
    }

    /// The bytes of a file below the root, or `None` when there is no such
    /// regular file. `relative` holds plain names only (see [`route`]); the
    /// real-path check is for links inside the directory that point out
    /// of it.
    fn read(&self, relative: &str) -> Option<io::Result<Vec<u8>>> {
        let real = fs::canonicalize(self.root.join(relative)).ok()?;
        (real.starts_with(&self.root) && real.is_file()).then(|| fs::read(&real))
    }

    fn asset(&self, relative: &str) -> Option<io::Result<Asset>> {
        self.read(relative).map(|bytes| {
            bytes.map(|body| Asset {
                content_type: content_type(relative),
                cache_control: cache_control(relative),
                body,
            })
        })
    }

    fn document(&self) -> Found {
        match self.asset(DOCUMENT) {
            Some(Ok(asset)) => Found::Asset(asset),
            Some(Err(error)) => Found::Broken(error.kind()),
            None => Found::Broken(io::ErrorKind::NotFound),
        }
    }

    /// What a `GET` of `path` (no query string) is answered with. Reads the
    /// disk: call it off the async workers.
    #[must_use]
    pub fn get(&self, path: &str) -> Found {
        match route(path) {
            Route::Nothing => Found::Nothing,
            Route::Document => self.document(),
            Route::File {
                relative,
                or_document,
            } => match self.asset(&relative) {
                Some(Ok(asset)) => Found::Asset(asset),
                // A file that exists and cannot be read is not a route of
                // the app.
                Some(Err(_)) => Found::Nothing,
                None if or_document => self.document(),
                None => Found::Nothing,
            },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn file(relative: &str, or_document: bool) -> Route {
        Route::File {
            relative: relative.to_owned(),
            or_document,
        }
    }

    #[test]
    fn the_root_and_app_routes_ask_for_the_document() {
        assert_eq!(route("/"), Route::Document);
        // A route may name a file one day, so the disk is asked first.
        assert_eq!(route("/overview"), file("overview", true));
        assert_eq!(
            route("/tasks/0193a8f2-6c1e-7b41-9a2e-1f1d6a0b3c55"),
            file("tasks/0193a8f2-6c1e-7b41-9a2e-1f1d6a0b3c55", true)
        );
        assert_eq!(route("/settings/display"), file("settings/display", true));
        assert_eq!(route("/tasks/"), Route::Document);
        // Looks like the API, is not under it.
        assert_eq!(route("/apix"), file("apix", true));
        assert_eq!(route("/api-docs"), file("api-docs", true));
        assert_eq!(route("/%EB%85%B8%ED%8A%B8"), file("노트", true));
    }

    #[test]
    fn names_of_files_never_fall_back_to_the_document() {
        assert_eq!(route("/index.html"), file("index.html", false));
        assert_eq!(route("/favicon.ico"), file("favicon.ico", false));
        assert_eq!(
            route("/assets/index-B3xY9aZ1.js"),
            file("assets/index-B3xY9aZ1.js", false)
        );
        assert_eq!(route("/assets/gone"), file("assets/gone", false));
        assert_eq!(route("/assets"), file("assets", false));
        assert_eq!(route("/notes/draft.md"), file("notes/draft.md", false));
        // Directories are not listed.
        assert_eq!(route("/assets/"), Route::Nothing);
        assert_eq!(route("/assets/nested/"), Route::Nothing);
    }

    #[test]
    fn reserved_paths_are_never_the_web_apps() {
        for path in [
            "/api",
            "/api/",
            "/api/v1",
            "/api/v1/tasks",
            "/api/v2/anything",
            "/%61pi/v1/me",
            "/healthz",
            "/readyz",
            "/healthz/",
            "/__boot",
            "/__anything/else",
            "/__",
        ] {
            assert_eq!(route(path), Route::Nothing, "{path}");
        }
    }

    #[test]
    fn paths_that_are_not_plain_names_ask_for_nothing() {
        for path in [
            "",
            "*",
            "relative/path",
            "/..",
            "/../",
            "/../etc/passwd",
            "/../../../../etc/passwd",
            "/assets/../index.html",
            "/assets/../../secret",
            "/./index.html",
            "/assets/./index-B3xY9aZ1.js",
            // The same, escaped once.
            "/%2e%2e/%2e%2e/etc/passwd",
            "/%2E%2E/secret",
            "/assets/%2e%2e/index.html",
            "/.%2e/secret",
            "/assets/..%2f..%2fsecret",
            "/assets%2f..%2f..%2fsecret",
            "/..%5c..%5csecret",
            "/assets/..\\..\\secret",
            // Empty segments.
            "//",
            "//etc/passwd",
            "/assets//index-B3xY9aZ1.js",
            "/tasks//",
            // Hidden files.
            "/.env",
            "/.git/config",
            "/assets/.hidden-B3xY9aZ1.js",
            "/.well-known/anything",
            // Bytes no file name of the build has.
            "/index.html%00",
            "/index.html%00.png",
            "/assets/index%0a.js",
            "/a%7fb",
            "/c:/windows/win.ini",
            "/assets/index.js:stream",
            // Broken escapes and bytes that are not text.
            "/%",
            "/%2",
            "/%zz",
            "/assets/%e0%a4.js",
            "/%ff%fe",
        ] {
            assert_eq!(route(path), Route::Nothing, "{path:?}");
        }
        // Escaped twice, the dots are an ordinary — if odd — name: it asks
        // for a file called `%2e%2e`, which does not exist.
        assert_eq!(route("/%252e%252e/x"), file("%2e%2e/x", true));
    }

    #[test]
    fn content_types_follow_the_extension() {
        for (name, expected) in [
            ("index.html", "text/html; charset=utf-8"),
            ("assets/index-B3xY9aZ1.js", "text/javascript; charset=utf-8"),
            (
                "assets/three-C0ffee12.MJS",
                "text/javascript; charset=utf-8",
            ),
            ("assets/index-Dq8FhP2c.css", "text/css; charset=utf-8"),
            (
                "assets/index-B3xY9aZ1.js.map",
                "application/json; charset=utf-8",
            ),
            ("assets/Pretendard-Zx81kQpL.woff2", "font/woff2"),
            ("assets/glass-orb-9aBcD_eF.webp", "image/webp"),
            ("favicon.svg", "image/svg+xml"),
            ("favicon.ico", "image/x-icon"),
            ("robots.txt", "text/plain; charset=utf-8"),
            (
                "site.webmanifest",
                "application/manifest+json; charset=utf-8",
            ),
        ] {
            assert_eq!(content_type(name), expected, "{name}");
        }
        // Nothing unknown is sent as something that runs or renders.
        for name in ["LICENSE", "archive.zip", "page.php", "run.exe", "a.htm"] {
            assert_eq!(content_type(name), "application/octet-stream", "{name}");
        }
    }

    #[test]
    fn only_content_hashed_assets_are_kept_and_the_document_never_is() {
        for name in [
            "assets/index-B3xY9aZ1.js",
            "assets/index-Dq8FhP2c.css",
            "assets/PretendardVariable-Zx81kQpL.woff2",
            "assets/glass-orb-9aBcD_eF.webp",
            "assets/three.module-C0ffee12.js",
            "assets/index-B3xY9aZ1.js.map",
            "assets/chunk-AB-CD_12.js",
            "assets/nested/icon-00000000.svg",
        ] {
            assert_eq!(cache_control(name), CACHE_FOREVER, "{name}");
        }
        for name in [
            "mockServiceWorker.js",
            "favicon.svg",
            "robots.txt",
            // A hashed-looking name outside the asset directory.
            "index-B3xY9aZ1.js",
            "static/index-B3xY9aZ1.js",
            // In the directory, without a hash.
            "assets/index.js",
            "assets/app-settings.js",
            "assets/logo.svg",
            "assets/-B3xY9aZ1.js",
            "assets/B3xY9aZ1.js",
            "assets/index-B3xY9a.js",
            "assets/index-B3xY9aZ!.js",
            "assets/index-B3xY9aZ1",
            "assets/vendor.module.js",
            "assets/한글-이름-파일.js",
            "assets/index_B3xY9aZ1.js",
            "assets",
            "assets/",
        ] {
            assert_eq!(cache_control(name), CACHE_REVALIDATE, "{name}");
        }
        assert_eq!(cache_control("index.html"), CACHE_NEVER);
    }

    #[test]
    fn the_policy_lets_the_app_run_and_nothing_else() {
        let policy = CONTENT_SECURITY_POLICY;
        let directive = |name: &str| {
            policy
                .split(';')
                .filter_map(|directive| directive.trim().split_once(' '))
                .find(|(found, _)| *found == name)
                .map(|(_, sources)| sources)
                .unwrap_or_else(|| panic!("no {name} in {policy}"))
        };
        assert_eq!(directive("script-src"), "'self'");
        assert_eq!(directive("connect-src"), "'self'");
        assert_eq!(directive("font-src"), "'self'");
        assert_eq!(directive("img-src"), "'self' data:");
        // Style sheets are files; only an attribute may carry style inline.
        assert_eq!(directive("style-src"), "'self'");
        assert_eq!(directive("style-src-attr"), "'unsafe-inline'");
        assert_eq!(directive("object-src"), "'none'");
        assert_eq!(directive("frame-ancestors"), "'none'");
        assert_eq!(directive("base-uri"), "'none'");
        // No script from a string, from the page itself or from elsewhere.
        for forbidden in ["unsafe-eval", "http:", "https:", "blob:", "*", "wasm"] {
            assert!(!policy.contains(forbidden), "{forbidden}");
        }
        assert_eq!(
            policy.matches("unsafe-inline").count(),
            1,
            "inline is allowed in one place only: style attributes"
        );
        assert!(!policy.contains("  "), "one space between words");
    }

    #[test]
    fn a_directory_without_a_document_is_not_a_web_app() {
        let directory =
            std::env::temp_dir().join(format!("ohmydate-web-empty-{}", std::process::id()));
        fs::create_dir_all(&directory).unwrap();
        assert_eq!(
            WebRoot::open(&directory).unwrap_err(),
            WebRootError::NoDocument
        );
        assert_eq!(
            WebRoot::open(&directory.join("missing")).unwrap_err(),
            WebRootError::NotADirectory
        );
        // A directory named index.html is not a document.
        fs::create_dir_all(directory.join(DOCUMENT)).unwrap();
        assert_eq!(
            WebRoot::open(&directory).unwrap_err(),
            WebRootError::NoDocument
        );
        fs::remove_dir_all(&directory).unwrap();
    }
}
