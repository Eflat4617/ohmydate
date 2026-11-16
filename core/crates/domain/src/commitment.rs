//! Appointments (the contract calls them commitments): time the owner has
//! promised elsewhere, once or on a recurrence rule, that a plan must leave
//! free. And the all-day events of a connected calendar, which block no time.

use crate::{CalendarDate, DomainError, Id, Instant, Version};

/// Longest title of an appointment, in characters (the contract's
/// `maxLength`, which counts code points).
pub const MAX_COMMITMENT_TITLE_LENGTH: usize = 200;

/// Where an appointment comes from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum CommitmentSource {
    Manual,
    Caldav,
    Vikunja,
    /// Imported from Google Calendar. Such an appointment is edited there:
    /// here it can be neither changed nor deleted, and no request can give
    /// an appointment this source.
    Google,
}

impl CommitmentSource {
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            CommitmentSource::Manual => "manual",
            CommitmentSource::Caldav => "caldav",
            CommitmentSource::Vikunja => "vikunja",
            CommitmentSource::Google => "google",
        }
    }

    #[must_use]
    pub fn parse(text: &str) -> Option<Self> {
        match text {
            "manual" => Some(CommitmentSource::Manual),
            "caldav" => Some(CommitmentSource::Caldav),
            "vikunja" => Some(CommitmentSource::Vikunja),
            "google" => Some(CommitmentSource::Google),
            _ => None,
        }
    }

    /// True for a source a request may name (`CommitmentWritableSource` of
    /// the contract): every source but `google`.
    #[must_use]
    pub fn is_writable(self) -> bool {
        self != CommitmentSource::Google
    }
}

/// The event of an outside calendar an imported appointment mirrors.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExternalEvent {
    pub calendar_id: String,
    pub event_id: String,
    pub etag: Option<String>,
}

/// An appointment.
///
/// `start_at`..`end_at` is its first (or only) occurrence. With `rrule` it
/// repeats on the wall clock of `time_zone`; every occurrence has the same
/// length in elapsed time.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Commitment {
    pub id: Id,
    pub title: String,
    pub start_at: Instant,
    pub end_at: Instant,
    /// IANA name of the zone the appointment was made in.
    pub time_zone: String,
    /// The recurrence rule, in the bounded `RRULE` subset.
    pub rrule: Option<String>,
    pub source: CommitmentSource,
    /// Present exactly when `source` is [`CommitmentSource::Google`].
    pub external: Option<ExternalEvent>,
    pub version: Version,
    pub created_at: Instant,
    pub updated_at: Instant,
}

impl Commitment {
    /// True when the appointment is a mirror of an outside calendar and can
    /// only be changed there.
    #[must_use]
    pub fn is_read_only(&self) -> bool {
        self.source == CommitmentSource::Google
    }
}

/// Checks the title of an appointment: 1 to 200 characters, no NUL.
///
/// Unlike a task's title it may be blank — the reference checks only its
/// length — and it is kept as written, not trimmed.
pub fn validate_commitment_title(title: &str) -> Result<(), DomainError> {
    let length = title.chars().count();
    if length == 0 || length > MAX_COMMITMENT_TITLE_LENGTH {
        return Err(DomainError::invalid(
            "/title",
            "title must have between 1 and 200 characters",
        ));
    }
    if title.contains('\0') {
        return Err(DomainError::invalid(
            "/title",
            "title must not contain the NUL character",
        ));
    }
    Ok(())
}

/// An all-day event of a connected calendar: `start_date` up to, but not
/// including, `end_date`. It is shown on the calendar and blocks no time.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CalendarDayEvent {
    pub id: Id,
    pub title: String,
    pub start_date: CalendarDate,
    pub end_date: CalendarDate,
    /// Name of the calendar the event belongs to, when it is known.
    pub calendar_name: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sources_round_trip_and_only_google_is_not_writable() {
        for source in [
            CommitmentSource::Manual,
            CommitmentSource::Caldav,
            CommitmentSource::Vikunja,
            CommitmentSource::Google,
        ] {
            assert_eq!(CommitmentSource::parse(source.as_str()), Some(source));
            assert_eq!(source.is_writable(), source != CommitmentSource::Google);
        }
        assert_eq!(CommitmentSource::parse("outlook"), None);
        assert_eq!(CommitmentSource::parse("Google"), None);
        assert_eq!(CommitmentSource::parse(""), None);
    }

    #[test]
    fn titles_have_one_to_two_hundred_characters() {
        assert_eq!(validate_commitment_title("Seminar"), Ok(()));
        assert_eq!(validate_commitment_title("x"), Ok(()));
        // Blank is a title here; the reference checks only the length.
        assert_eq!(validate_commitment_title(" "), Ok(()));
        // Characters, not bytes or UTF-16 units: 200 emoji are 200.
        assert_eq!(validate_commitment_title(&"가".repeat(200)), Ok(()));
        assert_eq!(validate_commitment_title(&"😀".repeat(200)), Ok(()));
    }

    #[test]
    fn empty_too_long_and_nul_titles_are_refused_under_the_title_pointer() {
        for title in [
            String::new(),
            "x".repeat(201),
            "😀".repeat(201),
            "a\0b".to_owned(),
        ] {
            let Err(DomainError::ValidationFailed(issues)) = validate_commitment_title(&title)
            else {
                panic!("{title:?} must be refused");
            };
            assert_eq!(issues.len(), 1);
            assert_eq!(issues[0].path, "/title");
            // The message names the rule, never the title.
            assert!(!issues[0].message.contains('x'), "{}", issues[0].message);
        }
    }

    #[test]
    fn only_an_imported_appointment_is_read_only() {
        let at = Instant::from_epoch_ms(1_800_000_000_000).unwrap();
        let mut appointment = Commitment {
            id: Id::parse("0193a8f2-6c1e-7b41-9a2e-1f1d6a0b3c55").unwrap(),
            title: "Seminar".into(),
            start_at: at,
            end_at: at.checked_add_ms(3_600_000).unwrap(),
            time_zone: "Asia/Seoul".into(),
            rrule: None,
            source: CommitmentSource::Manual,
            external: None,
            version: Version::INITIAL,
            created_at: at,
            updated_at: at,
        };
        assert!(!appointment.is_read_only());
        appointment.source = CommitmentSource::Google;
        assert!(appointment.is_read_only());
    }
}
