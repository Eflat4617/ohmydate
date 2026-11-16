//! `ohmydate-core`: the core as a headless process.
//!
//! The desktop shell links the server crate directly; this binary exists for
//! tests (the parity harness, Playwright) and for development. It opens the
//! data directory, takes the single-instance lock, listens on a loopback
//! port and serves until SIGINT or SIGTERM.

use std::fs::{self, File, OpenOptions};
use std::io::Write as _;
use std::net::Ipv4Addr;
use std::os::unix::fs::OpenOptionsExt as _;
use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::sync::Arc;
use std::time::Duration;

use ohmydate_app::{App, OwnerDefaults};
use ohmydate_domain::{Clock, UuidV7Generator};
use ohmydate_server::security::Guard;
use ohmydate_server::system::{self, OsRandom, SystemClock};
use ohmydate_server::web::WebRoot;
use ohmydate_server::{ServerState, contract};
use ohmydate_store::Store;

/// The option of a test build (cargo feature `test-clock`). The text is
/// part of the help only where the option exists.
#[cfg(feature = "test-clock")]
const TEST_USAGE: &str = "

TEST BUILD (cargo feature `test-clock`; never packaged):
    --clock-offset-ms <N>  Run on the system clock moved by N milliseconds
                           (negative moves back). Fixed for the process.";
#[cfg(not(feature = "test-clock"))]
const TEST_USAGE: &str = "";

const USAGE: &str = "\
ohmydate-core — the OhMyDate core as a local HTTP server

USAGE:
    ohmydate-core [OPTIONS]

OPTIONS:
    --data-dir <DIR>       Directory of the data file [default: $XDG_DATA_HOME/ohmydate]
    --port <PORT>          Loopback port; 0 picks a free one [default: 0]
    --ready-file <FILE>    Write {port, token, pid} here (mode 0600) once listening
    --time-zone <IANA>     Owner time zone for a new data file [default: system zone]
    --locale <TAG>         Owner locale for a new data file [default: from LANG]
    --allow-origin <URL>   Extra browser origin allowed to send mutations (repeatable;
                           development servers only)
    --web-dir <DIR>        Also serve the built web app in DIR (it must hold an
                           index.html) from the same origin as the API
    --version              Print the version
    --help                 Print this help

The server binds 127.0.0.1 only. Every /api/v1 request must carry the launch
token from the ready file, as `Authorization: Bearer <token>` or as the cookie
a browser gets by opening /__boot?token=<token> once.";

/// How long requests in flight may run after a shutdown signal.
const DRAIN_DEADLINE: Duration = Duration::from_secs(12);

const EXIT_FAILURE: u8 = 1;
const EXIT_USAGE: u8 = 2;
const EXIT_ALREADY_RUNNING: u8 = 3;

#[derive(Debug, Default, PartialEq, Eq)]
struct Options {
    data_dir: Option<PathBuf>,
    port: u16,
    ready_file: Option<PathBuf>,
    time_zone: Option<String>,
    locale: Option<String>,
    allow_origins: Vec<String>,
    web_dir: Option<PathBuf>,
    /// Always `None` in a build without the `test-clock` feature: there the
    /// option is refused before it gets here.
    clock_offset_ms: Option<i64>,
}

#[derive(Debug, PartialEq, Eq)]
enum Command {
    Run(Options),
    Help,
    Version,
}

fn parse_args(args: impl IntoIterator<Item = String>) -> Result<Command, String> {
    let mut options = Options::default();
    let mut args = args.into_iter();
    while let Some(flag) = args.next() {
        let mut value = || args.next().ok_or_else(|| format!("{flag} needs a value"));
        match flag.as_str() {
            "--help" | "-h" => return Ok(Command::Help),
            "--version" | "-V" => return Ok(Command::Version),
            "--data-dir" => options.data_dir = Some(PathBuf::from(value()?)),
            "--ready-file" => options.ready_file = Some(PathBuf::from(value()?)),
            "--port" => {
                options.port = value()?
                    .parse()
                    .map_err(|_| "--port must be 0..65535".to_owned())?;
            }
            "--time-zone" => {
                let zone = value()?;
                if !contract::is_iana_time_zone(&zone) {
                    return Err("--time-zone must be an IANA time zone name".to_owned());
                }
                options.time_zone = Some(zone);
            }
            "--locale" => {
                let locale = value()?;
                if system::locale_from_posix(&locale).as_deref() != Some(locale.as_str()) {
                    return Err("--locale must be a language tag such as ko-KR".to_owned());
                }
                options.locale = Some(locale);
            }
            "--allow-origin" => options.allow_origins.push(value()?),
            "--web-dir" => options.web_dir = Some(PathBuf::from(value()?)),
            "--clock-offset-ms" => {
                options.clock_offset_ms = Some(parse_clock_offset(&value()?)?);
            }
            other => return Err(format!("unknown option {other}")),
        }
    }
    Ok(Command::Run(options))
}

#[cfg(feature = "test-clock")]
fn parse_clock_offset(text: &str) -> Result<i64, String> {
    text.parse()
        .map_err(|_| "--clock-offset-ms must be a whole number of milliseconds".to_owned())
}

/// A build that can be packaged has no movable clock: the option is a usage
/// error whatever its value.
#[cfg(not(feature = "test-clock"))]
fn parse_clock_offset(_text: &str) -> Result<i64, String> {
    Err("--clock-offset-ms exists only in a test build (cargo feature `test-clock`)".to_owned())
}

/// The clock of this process: the system's, or — in a test build that was
/// asked to — the system's moved by a fixed offset.
#[cfg(feature = "test-clock")]
fn process_clock(offset_ms: Option<i64>) -> Arc<dyn Clock> {
    match offset_ms {
        Some(offset_ms) => {
            tracing::warn!(
                target: "ohmydate::core",
                clock_offset_ms = offset_ms,
                "test build: running on a shifted clock"
            );
            Arc::new(system::ShiftedClock::new(offset_ms))
        }
        None => Arc::new(SystemClock),
    }
}

#[cfg(not(feature = "test-clock"))]
fn process_clock(_offset_ms: Option<i64>) -> Arc<dyn Clock> {
    Arc::new(SystemClock)
}

fn init_logging() {
    let level = match std::env::var("OHMYDATE_LOG").as_deref() {
        Ok("debug") => tracing::Level::DEBUG,
        Ok("warn") => tracing::Level::WARN,
        Ok("error") => tracing::Level::ERROR,
        _ => tracing::Level::INFO,
    };
    // Structured JSON lines on stderr. What may appear in them is restricted
    // at the call sites: ids, codes, counts and durations only.
    tracing_subscriber::fmt()
        .json()
        .with_max_level(level)
        .with_writer(std::io::stderr)
        .init();
}

/// Takes the exclusive lock of the data directory. The lock is released by
/// the operating system when the process ends, however it ends.
fn lock_data_dir(data_dir: &Path) -> Result<File, u8> {
    let lock = OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .mode(0o600)
        .open(data_dir.join("core.lock"))
        .map_err(|error| {
            tracing::error!(target: "ohmydate::core", kind = ?error.kind(), "cannot open the lock file");
            EXIT_FAILURE
        })?;
    match lock.try_lock() {
        Ok(()) => Ok(lock),
        Err(std::fs::TryLockError::WouldBlock) => {
            tracing::error!(target: "ohmydate::core", "another instance is using this data directory");
            Err(EXIT_ALREADY_RUNNING)
        }
        Err(std::fs::TryLockError::Error(error)) => {
            tracing::error!(target: "ohmydate::core", kind = ?error.kind(), "cannot lock the data directory");
            Err(EXIT_FAILURE)
        }
    }
}

/// Writes the ready file atomically, readable by the owner only: it holds
/// the launch token.
fn write_ready_file(path: &Path, port: u16, token: &str) -> std::io::Result<()> {
    let mut temporary = path.as_os_str().to_owned();
    temporary.push(".tmp");
    let temporary = PathBuf::from(temporary);
    let _ = fs::remove_file(&temporary);
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&temporary)?;
    let content =
        serde_json::json!({"port": port, "token": token, "pid": std::process::id()}).to_string();
    file.write_all(content.as_bytes())?;
    file.sync_all()?;
    fs::rename(&temporary, path)
}

async fn shutdown_signal() {
    use tokio::signal::unix::{SignalKind, signal};
    let mut terminate = signal(SignalKind::terminate()).ok();
    let terminated = async {
        match terminate.as_mut() {
            Some(stream) => {
                stream.recv().await;
            }
            None => std::future::pending().await,
        }
    };
    tokio::select! {
        _ = tokio::signal::ctrl_c() => {}
        () = terminated => {}
    }
}

async fn run(options: Options) -> Result<(), u8> {
    // Before anything is created or locked: a web directory that cannot be
    // served is a mistake in the command line.
    let web = options
        .web_dir
        .as_deref()
        .map(WebRoot::open)
        .transpose()
        .map_err(|error| {
            tracing::error!(target: "ohmydate::core", reason = %error, "cannot serve --web-dir");
            EXIT_USAGE
        })?;
    let data_dir = options
        .data_dir
        .or_else(|| {
            system::default_data_dir(
                std::env::var("XDG_DATA_HOME").ok().as_deref(),
                std::env::var("HOME").ok().as_deref(),
            )
        })
        .ok_or_else(|| {
            tracing::error!(target: "ohmydate::core", "no data directory: pass --data-dir");
            EXIT_USAGE
        })?;
    fs::create_dir_all(&data_dir).map_err(|error| {
        tracing::error!(target: "ohmydate::core", kind = ?error.kind(), "cannot create the data directory");
        EXIT_FAILURE
    })?;
    let _lock = lock_data_dir(&data_dir)?;

    let store = Store::open(&data_dir.join("ohmydate.db")).map_err(|error| {
        tracing::error!(
            target: "ohmydate::core",
            kind = error.kind(),
            sqlite_code = error.sqlite_code(),
            "cannot open the data file"
        );
        EXIT_FAILURE
    })?;
    let report = store.migration_report().clone();
    let defaults = OwnerDefaults {
        email: "owner@ohmydate.local".to_owned(),
        time_zone: options.time_zone.unwrap_or_else(system::system_time_zone),
        locale: options
            .locale
            .or_else(|| {
                ["LC_ALL", "LC_MESSAGES", "LANG"]
                    .iter()
                    .filter_map(|name| std::env::var(name).ok())
                    .find_map(|value| system::locale_from_posix(&value))
            })
            .unwrap_or_else(|| "en".to_owned()),
    };
    // One clock for rows and for ids, so a row's `createdAt` and the time
    // inside its id never disagree.
    let clock = process_clock(options.clock_offset_ms);
    let ids = Arc::new(UuidV7Generator::new(clock.clone(), OsRandom));
    let app = App::open(store, clock, ids, &defaults).map_err(|_| {
        tracing::error!(target: "ohmydate::core", "cannot initialise the data file");
        EXIT_FAILURE
    })?;

    let listener = tokio::net::TcpListener::bind((Ipv4Addr::LOCALHOST, options.port))
        .await
        .map_err(|error| {
            tracing::error!(target: "ohmydate::core", kind = ?error.kind(), "cannot bind the loopback port");
            EXIT_FAILURE
        })?;
    let port = listener
        .local_addr()
        .map(|address| address.port())
        .map_err(|_| EXIT_FAILURE)?;
    let token = system::new_launch_token(&OsRandom);
    let state = ServerState::new(
        Arc::new(app),
        Guard::new(token.clone(), port, &options.allow_origins),
    );
    let serves_web = web.is_some();
    let state = Arc::new(match web {
        Some(web) => state.with_web(web),
        None => state,
    });

    if let Some(ready_file) = &options.ready_file {
        write_ready_file(ready_file, port, &token).map_err(|error| {
            tracing::error!(target: "ohmydate::core", kind = ?error.kind(), "cannot write the ready file");
            EXIT_FAILURE
        })?;
    }
    tracing::info!(
        target: "ohmydate::core",
        port,
        migrations_applied = report.applied.len(),
        operations = state.ported_operations().len(),
        web = serves_web,
        "listening on 127.0.0.1"
    );

    let (stop, stopped) = tokio::sync::oneshot::channel::<()>();
    let server = tokio::spawn(ohmydate_server::serve(listener, state, async {
        let _ = stopped.await;
    }));
    shutdown_signal().await;
    tracing::info!(target: "ohmydate::core", "shutdown requested; draining");
    let _ = stop.send(());
    let drained = tokio::time::timeout(DRAIN_DEADLINE, server).await;
    if let Some(ready_file) = &options.ready_file {
        let _ = fs::remove_file(ready_file);
    }
    match drained {
        Ok(Ok(Ok(()))) => {
            tracing::info!(target: "ohmydate::core", "stopped");
            Ok(())
        }
        Ok(_) => Err(EXIT_FAILURE),
        Err(_) => {
            // SQLite keeps the file consistent; requests still running lose
            // their uncommitted work, and their idempotency keys stay free.
            tracing::warn!(target: "ohmydate::core", "drain deadline reached; exiting");
            Ok(())
        }
    }
}

#[allow(clippy::print_stdout, clippy::print_stderr)]
fn main() -> ExitCode {
    let options = match parse_args(std::env::args().skip(1)) {
        Ok(Command::Run(options)) => options,
        Ok(Command::Help) => {
            println!("{USAGE}{TEST_USAGE}");
            return ExitCode::SUCCESS;
        }
        Ok(Command::Version) => {
            println!("ohmydate-core {}", env!("CARGO_PKG_VERSION"));
            return ExitCode::SUCCESS;
        }
        Err(message) => {
            eprintln!("error: {message}\n\n{USAGE}{TEST_USAGE}");
            return ExitCode::from(EXIT_USAGE);
        }
    };
    init_logging();
    let runtime = match tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .enable_all()
        .build()
    {
        Ok(runtime) => runtime,
        Err(_) => return ExitCode::from(EXIT_FAILURE),
    };
    match runtime.block_on(run(options)) {
        Ok(()) => ExitCode::SUCCESS,
        Err(code) => ExitCode::from(code),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(list: &[&str]) -> Vec<String> {
        list.iter().map(|&arg| arg.to_owned()).collect()
    }

    #[test]
    fn options_are_parsed() {
        let parsed = parse_args(args(&[
            "--data-dir",
            "/tmp/x",
            "--port",
            "4310",
            "--ready-file",
            "/tmp/ready.json",
            "--time-zone",
            "Asia/Seoul",
            "--locale",
            "ko-KR",
            "--allow-origin",
            "http://127.0.0.1:5173",
            "--allow-origin",
            "http://localhost:5173",
            "--web-dir",
            "/opt/ohmydate/web",
        ]));
        assert_eq!(
            parsed,
            Ok(Command::Run(Options {
                data_dir: Some(PathBuf::from("/tmp/x")),
                port: 4310,
                ready_file: Some(PathBuf::from("/tmp/ready.json")),
                time_zone: Some("Asia/Seoul".into()),
                locale: Some("ko-KR".into()),
                allow_origins: vec![
                    "http://127.0.0.1:5173".into(),
                    "http://localhost:5173".into()
                ],
                web_dir: Some(PathBuf::from("/opt/ohmydate/web")),
                clock_offset_ms: None,
            }))
        );
        assert_eq!(parse_args(args(&[])), Ok(Command::Run(Options::default())));
        assert_eq!(parse_args(args(&["--help"])), Ok(Command::Help));
        assert_eq!(parse_args(args(&["--version"])), Ok(Command::Version));
    }

    #[test]
    fn bad_options_are_usage_errors() {
        for list in [
            vec!["--port"],
            vec!["--port", "70000"],
            vec!["--port", "abc"],
            vec!["--time-zone", "Mars/Olympus"],
            vec!["--locale", "ko_KR.UTF-8"],
            vec!["--web-dir"],
            vec!["--frobnicate"],
            vec!["positional"],
        ] {
            assert!(parse_args(args(&list)).is_err(), "{list:?}");
        }
    }

    #[cfg(feature = "test-clock")]
    #[test]
    fn a_test_build_reads_the_clock_offset() {
        for (text, expected) in [
            ("0", 0),
            ("86400000", 86_400_000),
            ("-3600000", -3_600_000),
            ("9223372036854775807", i64::MAX),
        ] {
            let parsed = parse_args(args(&["--clock-offset-ms", text]));
            assert_eq!(
                parsed,
                Ok(Command::Run(Options {
                    clock_offset_ms: Some(expected),
                    ..Options::default()
                })),
                "{text}"
            );
        }
        for bad in [
            vec!["--clock-offset-ms"],
            vec!["--clock-offset-ms", ""],
            vec!["--clock-offset-ms", "abc"],
            vec!["--clock-offset-ms", "1.5"],
            vec!["--clock-offset-ms", "1e3"],
            vec!["--clock-offset-ms", "2 days"],
            vec!["--clock-offset-ms", "9223372036854775808"],
        ] {
            assert!(parse_args(args(&bad)).is_err(), "{bad:?}");
        }
        assert!(TEST_USAGE.contains("--clock-offset-ms"));
    }

    /// What ships: no movable clock, whatever is asked.
    #[cfg(not(feature = "test-clock"))]
    #[test]
    fn a_build_that_can_be_packaged_has_no_clock_offset() {
        for list in [
            vec!["--clock-offset-ms", "0"],
            vec!["--clock-offset-ms", "86400000"],
            vec!["--clock-offset-ms", "-1"],
            vec!["--clock-offset-ms"],
            vec!["--data-dir", "/tmp/x", "--clock-offset-ms", "1"],
        ] {
            let refused = parse_args(args(&list));
            assert!(refused.is_err(), "{list:?}");
        }
        assert_eq!(
            parse_args(args(&["--clock-offset-ms", "1"])),
            Err(
                "--clock-offset-ms exists only in a test build (cargo feature `test-clock`)".into()
            )
        );
        // The help does not offer what the build does not have.
        assert!(!USAGE.contains("clock") && TEST_USAGE.is_empty());
        // And nothing else can put an offset into the options.
        assert_eq!(Options::default().clock_offset_ms, None);
    }

    #[test]
    fn the_ready_file_is_owner_only_and_replaced_atomically() {
        use std::os::unix::fs::PermissionsExt as _;
        let directory = std::env::temp_dir().join(format!("ohmydate-ready-{}", std::process::id()));
        fs::create_dir_all(&directory).unwrap();
        let path = directory.join("ready.json");
        write_ready_file(&path, 4310, "secret-token").unwrap();
        write_ready_file(&path, 4311, "second-token").unwrap();
        let content: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(content["port"], 4311);
        assert_eq!(content["token"], "second-token");
        assert_eq!(
            fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600
        );
        assert!(!directory.join("ready.json.tmp").exists());
        fs::remove_dir_all(&directory).unwrap();
    }

    #[test]
    fn a_second_lock_on_the_same_directory_is_refused() {
        let directory = std::env::temp_dir().join(format!("ohmydate-lock-{}", std::process::id()));
        fs::create_dir_all(&directory).unwrap();
        let first = lock_data_dir(&directory).unwrap();
        assert_eq!(lock_data_dir(&directory).err(), Some(EXIT_ALREADY_RUNNING));
        drop(first);
        assert!(
            lock_data_dir(&directory).is_ok(),
            "the lock is free again after release"
        );
        fs::remove_dir_all(&directory).unwrap();
    }
}
