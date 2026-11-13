//! Adapters to the operating system: clock, randomness, locations, locale.

use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

use ohmydate_domain::{Clock, Instant, RandomSource};

/// The wall clock.
#[derive(Debug, Clone, Copy, Default)]
pub struct SystemClock;

impl Clock for SystemClock {
    fn now(&self) -> Instant {
        let epoch_ms = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .ok()
            .and_then(|elapsed| i64::try_from(elapsed.as_millis()).ok())
            .unwrap_or(0);
        // A clock outside 1970..9999 is clamped rather than trusted.
        Instant::from_epoch_ms(epoch_ms).unwrap_or(if epoch_ms < 0 {
            Instant::MIN
        } else {
            Instant::MAX
        })
    }
}

/// The operating system's random number generator.
#[derive(Debug, Clone, Copy, Default)]
pub struct OsRandom;

impl RandomSource for OsRandom {
    fn fill(&self, buffer: &mut [u8]) {
        // Without OS randomness ids would collide and the launch token would
        // be guessable; there is no safe way to continue.
        if getrandom::fill(buffer).is_err() {
            tracing::error!(target: "ohmydate::system", "the operating system has no randomness source");
            std::process::abort();
        }
    }
}

/// A fresh launch token: 256 random bits as 64 hex characters.
#[must_use]
pub fn new_launch_token(random: &dyn RandomSource) -> String {
    use std::fmt::Write as _;
    let mut bytes = [0_u8; 32];
    random.fill(&mut bytes);
    let mut token = String::with_capacity(64);
    for byte in bytes {
        // Writing to a String cannot fail.
        let _ = write!(token, "{byte:02x}");
    }
    token
}

/// Where the data file lives when `--data-dir` is not given:
/// `$XDG_DATA_HOME/ohmydate`, else `$HOME/.local/share/ohmydate`.
#[must_use]
pub fn default_data_dir(xdg_data_home: Option<&str>, home: Option<&str>) -> Option<PathBuf> {
    let absolute = |value: &&str| value.starts_with('/');
    xdg_data_home
        .filter(absolute)
        .map(PathBuf::from)
        .or_else(|| {
            home.filter(absolute)
                .map(|home| PathBuf::from(home).join(".local/share"))
        })
        .map(|base| base.join("ohmydate"))
}

/// The system's IANA time zone, or `UTC` when it cannot be determined.
#[must_use]
pub fn system_time_zone() -> String {
    jiff::tz::TimeZone::system()
        .iana_name()
        .filter(|name| crate::contract::is_iana_time_zone(name))
        .unwrap_or("UTC")
        .to_owned()
}

/// A BCP 47 tag from a POSIX locale value (`ko_KR.UTF-8` → `ko-KR`), or
/// `None` for `C`, `POSIX` and values that are not a language tag.
#[must_use]
pub fn locale_from_posix(value: &str) -> Option<String> {
    let tag = value
        .split(['.', '@'])
        .next()
        .unwrap_or("")
        .replace('_', "-");
    let valid = (2..=35).contains(&tag.len())
        && tag
            .split('-')
            .all(|part| !part.is_empty() && part.chars().all(|c| c.is_ascii_alphanumeric()))
        && tag.split('-').next().is_some_and(|language| {
            (2..=3).contains(&language.len()) && language.chars().all(|c| c.is_ascii_lowercase())
        });
    valid.then_some(tag)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_system_clock_is_inside_the_supported_range_and_moves_forward() {
        let first = SystemClock.now();
        let second = SystemClock.now();
        assert!(first > Instant::from_epoch_ms(1_700_000_000_000).unwrap());
        assert!(second >= first);
    }

    #[test]
    fn launch_tokens_are_64_hex_characters_and_differ() {
        let first = new_launch_token(&OsRandom);
        let second = new_launch_token(&OsRandom);
        assert_eq!(first.len(), 64);
        assert!(first.bytes().all(|byte| byte.is_ascii_hexdigit()));
        assert_ne!(first, second);
    }

    #[test]
    fn the_data_dir_follows_xdg_and_ignores_relative_values() {
        assert_eq!(
            default_data_dir(Some("/data"), Some("/home/u")),
            Some(PathBuf::from("/data/ohmydate"))
        );
        assert_eq!(
            default_data_dir(None, Some("/home/u")),
            Some(PathBuf::from("/home/u/.local/share/ohmydate"))
        );
        assert_eq!(
            default_data_dir(Some("relative"), Some("/home/u")),
            Some(PathBuf::from("/home/u/.local/share/ohmydate"))
        );
        assert_eq!(default_data_dir(None, None), None);
        assert_eq!(default_data_dir(Some(""), Some("")), None);
    }

    #[test]
    fn posix_locales_become_language_tags() {
        assert_eq!(locale_from_posix("ko_KR.UTF-8").as_deref(), Some("ko-KR"));
        assert_eq!(locale_from_posix("en_US").as_deref(), Some("en-US"));
        assert_eq!(locale_from_posix("de").as_deref(), Some("de"));
        assert_eq!(locale_from_posix("sr_RS@latin").as_deref(), Some("sr-RS"));
        for value in ["C", "POSIX", "", "C.UTF-8", "x", "ko_KR/../etc"] {
            assert_eq!(locale_from_posix(value), None, "{value}");
        }
    }

    #[test]
    fn the_system_time_zone_is_a_known_zone() {
        assert!(crate::contract::is_iana_time_zone(&system_time_zone()));
    }
}
