//! Test support: a pinned clock, counting ids and an app over a temp file.

use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicI64, AtomicU32, AtomicU64, Ordering};

use ohmydate_domain::{Clock, Id, IdGenerator, Instant};
use ohmydate_store::Store;

use crate::{App, OwnerDefaults};

pub(crate) fn id(suffix: u8) -> Id {
    Id::parse(&format!("0193a8f2-6c1e-7b41-9a2e-ffffffffff{suffix:02x}")).unwrap()
}

#[derive(Debug)]
pub(crate) struct TestClock(AtomicI64);

impl TestClock {
    pub(crate) fn advance_ms(&self, delta_ms: i64) {
        self.0.fetch_add(delta_ms, Ordering::SeqCst);
    }
}

impl Clock for TestClock {
    fn now(&self) -> Instant {
        Instant::from_epoch_ms(self.0.load(Ordering::SeqCst)).unwrap()
    }
}

/// Ids `…-000000000001`, `…-000000000002`, … in creation order.
#[derive(Debug, Default)]
struct CountingIds(AtomicU64);

impl IdGenerator for CountingIds {
    fn next_id(&self) -> Id {
        let next = self.0.fetch_add(1, Ordering::SeqCst) + 1;
        Id::parse(&format!("0193a8f2-6c1e-7b41-9a2e-{next:012x}")).unwrap()
    }
}

pub(crate) struct TestApp {
    pub(crate) app: App,
    ids: Arc<CountingIds>,
    pub(crate) clock: Arc<TestClock>,
    /// `None` once ownership of the directory moved to a reopened instance.
    directory: Option<PathBuf>,
}

fn defaults() -> OwnerDefaults {
    OwnerDefaults {
        email: "owner@ohmydate.local".into(),
        time_zone: "Asia/Seoul".into(),
        locale: "ko-KR".into(),
    }
}

impl TestApp {
    /// 2026-11-13T12:00:00.000Z.
    pub(crate) const START_MS: i64 = 1_794_571_200_000;

    pub(crate) fn new() -> Self {
        static COUNTER: AtomicU32 = AtomicU32::new(0);
        let directory = std::env::temp_dir().join(format!(
            "ohmydate-app-{}-{}",
            std::process::id(),
            COUNTER.fetch_add(1, Ordering::SeqCst)
        ));
        std::fs::create_dir_all(&directory).unwrap();
        Self::open(
            directory,
            Arc::new(TestClock(AtomicI64::new(Self::START_MS))),
            &defaults(),
        )
    }

    fn open(directory: PathBuf, clock: Arc<TestClock>, defaults: &OwnerDefaults) -> Self {
        let store = Store::open(&directory.join("data.db")).unwrap();
        // Continue numbering after ids already in the file.
        let used: i64 = store
            .read(|connection| {
                connection.query_row(
                    "SELECT (SELECT count(*) FROM owner) + (SELECT count(*) FROM project) \
                          + (SELECT count(*) FROM task) \
                          + (SELECT count(*) FROM commitment_event)",
                    [],
                    |row| row.get(0),
                )
            })
            .unwrap();
        let ids = Arc::new(CountingIds(AtomicU64::new(u64::try_from(used).unwrap())));
        let app = App::open(store, clock.clone(), ids.clone(), defaults).unwrap();
        Self {
            app,
            ids,
            clock,
            directory: Some(directory),
        }
    }

    pub(crate) fn ids(&self) -> &dyn IdGenerator {
        self.ids.as_ref()
    }

    /// Closes the data file and opens it again, as an app restart does.
    pub(crate) fn reopen(mut self, defaults: &OwnerDefaults) -> Self {
        let directory = self.directory.take().unwrap();
        let clock = self.clock.clone();
        // Closes the SQLite connection; the directory stays for the new instance.
        drop(self);
        Self::open(directory, clock, defaults)
    }
}

impl Drop for TestApp {
    fn drop(&mut self) {
        if let Some(directory) = &self.directory {
            let _ = std::fs::remove_dir_all(directory);
        }
    }
}
