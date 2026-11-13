use std::fmt;

/// Optimistic-concurrency version of an entity. Always positive; the HTTP
/// `ETag` of an entity is `W/"<version>"`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct Version(u32);

impl Version {
    pub const INITIAL: Version = Version(1);

    /// Returns `None` for zero: versions start at 1.
    #[must_use]
    pub fn new(value: u32) -> Option<Self> {
        if value == 0 { None } else { Some(Self(value)) }
    }

    #[must_use]
    pub fn get(self) -> u32 {
        self.0
    }

    /// The version after one more successful mutation.
    #[must_use]
    pub fn next(self) -> Self {
        Self(self.0.saturating_add(1))
    }
}

impl fmt::Display for Version {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{}", self.0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn versions_start_at_one_and_increase() {
        let version = Version::new(1).unwrap();
        assert_eq!(version, Version::INITIAL);
        assert_eq!(version.next().get(), 2);
        assert_eq!(version.to_string(), "1");
    }

    #[test]
    fn zero_is_not_a_version() {
        assert_eq!(Version::new(0), None);
    }
}
