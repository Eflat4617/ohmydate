use crate::{Id, Instant};

/// Source of the current time. Domain and application code never read the
/// system clock directly, so tests can pin time.
pub trait Clock: Send + Sync {
    fn now(&self) -> Instant;
}

/// A shared clock is a clock: one adapter can serve the app and the id
/// generator.
impl<T: Clock + ?Sized> Clock for std::sync::Arc<T> {
    fn now(&self) -> Instant {
        (**self).now()
    }
}

/// Source of random bytes for identifiers. Injected so tests are repeatable.
pub trait RandomSource: Send + Sync {
    fn fill(&self, buffer: &mut [u8]);
}

/// Produces new entity identifiers (`UUIDv7`).
pub trait IdGenerator: Send + Sync {
    fn next_id(&self) -> Id;
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use super::*;

    struct Pinned(i64);

    impl Clock for Pinned {
        fn now(&self) -> Instant {
            Instant::from_epoch_ms(self.0).unwrap_or(Instant::MIN)
        }
    }

    #[test]
    fn a_shared_clock_tells_the_time_of_the_clock_it_shares() {
        let shared: Arc<dyn Clock> = Arc::new(Pinned(1_800_000_000_000));
        let other = shared.clone();
        assert_eq!(Clock::now(&shared).epoch_ms(), 1_800_000_000_000);
        assert_eq!(Clock::now(&other), Clock::now(&shared));
        // A clock outside the supported range cannot produce an instant.
        assert_eq!(Clock::now(&Arc::new(Pinned(-5))), Instant::MIN);
    }
}
