use crate::{Id, Instant};

/// Source of the current time. Domain and application code never read the
/// system clock directly, so tests can pin time.
pub trait Clock: Send + Sync {
    fn now(&self) -> Instant;
}

/// Source of random bytes for identifiers. Injected so tests are repeatable.
pub trait RandomSource: Send + Sync {
    fn fill(&self, buffer: &mut [u8]);
}

/// Produces new entity identifiers (`UUIDv7`).
pub trait IdGenerator: Send + Sync {
    fn next_id(&self) -> Id;
}
