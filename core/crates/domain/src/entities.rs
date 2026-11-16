use crate::{Id, Instant, Version};

/// Lifecycle state of a task.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum TaskStatus {
    Todo,
    InProgress,
    Done,
}

impl TaskStatus {
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            TaskStatus::Todo => "todo",
            TaskStatus::InProgress => "in_progress",
            TaskStatus::Done => "done",
        }
    }

    #[must_use]
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "todo" => Some(TaskStatus::Todo),
            "in_progress" => Some(TaskStatus::InProgress),
            "done" => Some(TaskStatus::Done),
            _ => None,
        }
    }
}

/// Task priority, 1 (highest) to 4.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct TaskPriority(u8);

impl TaskPriority {
    pub const DEFAULT: TaskPriority = TaskPriority(2);

    #[must_use]
    pub fn new(value: i64) -> Option<Self> {
        u8::try_from(value)
            .ok()
            .filter(|value| (1..=4).contains(value))
            .map(Self)
    }

    #[must_use]
    pub fn get(self) -> u8 {
        self.0
    }
}

/// Shortest and longest single work session for a task, in minutes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SessionWindow {
    pub min_minutes: u16,
    pub max_minutes: u16,
}

/// Kind of project. ADR-018: exactly one `Inbox` exists; all others are
/// `Normal`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ProjectKind {
    Inbox,
    Normal,
}

impl ProjectKind {
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            ProjectKind::Inbox => "inbox",
            ProjectKind::Normal => "normal",
        }
    }

    #[must_use]
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "inbox" => Some(ProjectKind::Inbox),
            "normal" => Some(ProjectKind::Normal),
            _ => None,
        }
    }
}

/// An amount of money in millionths of a US dollar.
///
/// Budgets and spend are compared as whole numbers; the contract's `number`
/// of dollars is converted here, at the edge of the domain, and nowhere else.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct MicroUsd(i64);

impl MicroUsd {
    /// Largest amount: one billion dollars. Far above any budget, and small
    /// enough that every amount converts to a JSON number and back exactly.
    pub const MAX: MicroUsd = MicroUsd(1_000_000_000_000_000);

    /// The amount for a stored count of micro-dollars, or `None` outside
    /// `0..=MAX`.
    #[must_use]
    pub fn from_micros(micros: i64) -> Option<Self> {
        (0..=Self::MAX.0).contains(&micros).then_some(Self(micros))
    }

    /// The amount for a number of dollars, rounded to the nearest
    /// micro-dollar. `None` for a negative, non-finite or too large number.
    #[must_use]
    pub fn from_usd(usd: f64) -> Option<Self> {
        if !usd.is_finite() || usd < 0.0 {
            return None;
        }
        let micros = (usd * 1_000_000.0).round();
        // Checked against the limit first, so the conversion cannot overflow;
        // every whole number up to the limit is an exact `f64`.
        (micros <= Self::MAX.0 as f64).then_some(Self(micros as i64))
    }

    #[must_use]
    pub fn micros(self) -> i64 {
        self.0
    }

    /// Whole dollars when the amount has no fraction.
    #[must_use]
    pub fn whole_usd(self) -> Option<i64> {
        (self.0 % 1_000_000 == 0).then_some(self.0 / 1_000_000)
    }

    /// The amount as a number of dollars. Exact for every amount up to
    /// [`MicroUsd::MAX`] that has at most six decimals — that is, all of them.
    #[must_use]
    pub fn usd(self) -> f64 {
        self.0 as f64 / 1_000_000.0
    }
}

/// The owner's answer to "may my text be sent to this AI provider?"
/// (05 §12, ADR-022). A record names the provider it was given for: consent
/// to one provider is not consent to another.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LlmConsent {
    pub granted: bool,
    /// When the owner answered.
    pub at: Instant,
    pub provider: String,
}

/// Spending limits the owner set for AI calls.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LlmBudget {
    pub daily: MicroUsd,
    pub monthly: MicroUsd,
}

/// What the owner decided about AI: nothing yet, a consent record, a budget,
/// or both.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct LlmSettings {
    pub consent: Option<LlmConsent>,
    pub budget: Option<LlmBudget>,
}

impl LlmSettings {
    /// True when the owner has decided nothing.
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.consent.is_none() && self.budget.is_none()
    }
}

/// The single local owner of the data file. The desktop core has no accounts:
/// this row replaces the server's `user` table.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Owner {
    pub id: Id,
    /// Display address only: the contract's `User` requires one, nothing
    /// authenticates with it.
    pub email: String,
    /// IANA time zone the owner's dates and wall-clock times are read in.
    pub time_zone: String,
    pub locale: String,
    pub llm: LlmSettings,
    pub version: Version,
    pub created_at: Instant,
    pub updated_at: Instant,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Project {
    pub id: Id,
    pub title: String,
    pub kind: ProjectKind,
    pub archived: bool,
    pub version: Version,
    pub created_at: Instant,
    pub updated_at: Instant,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Task {
    pub id: Id,
    pub project_id: Id,
    pub title: String,
    pub description: Option<String>,
    pub status: TaskStatus,
    pub due_at: Option<Instant>,
    pub splittable: bool,
    pub session: Option<SessionWindow>,
    pub priority: TaskPriority,
    /// Ids of the tasks that must finish first, in the order they were added.
    pub depends_on: Vec<Id>,
    pub version: Version,
    pub created_at: Instant,
    pub updated_at: Instant,
    pub deleted_at: Option<Instant>,
}

/// A task creation request as it arrives, before domain validation. Field
/// shapes (types, ranges, id syntax) were already checked against the contract
/// schema at the HTTP boundary; [`crate::validate_task_create`] applies the
/// rules a JSON schema cannot express.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct TaskCreate {
    pub project_id: Option<Id>,
    pub title: String,
    pub description: Option<String>,
    pub status: Option<TaskStatus>,
    /// RFC 3339 text; normalised to a UTC [`Instant`] by validation.
    pub due_at: Option<String>,
    pub splittable: Option<bool>,
    pub session: Option<SessionWindow>,
    pub priority: Option<TaskPriority>,
    pub depends_on: Option<Vec<Id>>,
}

/// A partial task update. For the nullable fields the outer `Option` says
/// whether the field was sent and the inner one whether it was `null`
/// (clear) or a value (set).
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct TaskPatch {
    pub project_id: Option<Id>,
    pub title: Option<String>,
    pub description: Option<Option<String>>,
    pub status: Option<TaskStatus>,
    pub due_at: Option<Option<String>>,
    pub splittable: Option<bool>,
    pub session: Option<Option<SessionWindow>>,
    pub priority: Option<TaskPriority>,
    pub depends_on: Option<Vec<Id>>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn enums_round_trip_through_their_wire_names() {
        for status in [TaskStatus::Todo, TaskStatus::InProgress, TaskStatus::Done] {
            assert_eq!(TaskStatus::parse(status.as_str()), Some(status));
        }
        for kind in [ProjectKind::Inbox, ProjectKind::Normal] {
            assert_eq!(ProjectKind::parse(kind.as_str()), Some(kind));
        }
    }

    #[test]
    fn dollars_become_micro_dollars_and_come_back_exactly() {
        for (usd, micros) in [
            (0.0, 0),
            (0.2, 200_000),
            (1.5, 1_500_000),
            (5.0, 5_000_000),
            (20.0, 20_000_000),
            (0.000_001, 1),
            (1_000_000_000.0, 1_000_000_000_000_000),
        ] {
            let amount = MicroUsd::from_usd(usd).unwrap();
            assert_eq!(amount.micros(), micros, "{usd}");
            assert_eq!(amount.usd().to_bits(), usd.to_bits(), "{usd}");
            assert_eq!(MicroUsd::from_micros(micros), Some(amount));
        }
        // Finer than a micro-dollar: rounded to the nearest one.
        assert_eq!(MicroUsd::from_usd(0.123_456_7).unwrap().micros(), 123_457);
        assert_eq!(MicroUsd::from_usd(0.000_000_4).unwrap().micros(), 0);
        assert_eq!(MicroUsd::from_usd(5.0).unwrap().whole_usd(), Some(5));
        assert_eq!(MicroUsd::from_usd(1.5).unwrap().whole_usd(), None);
    }

    #[test]
    fn amounts_that_are_not_a_budget_are_refused() {
        for usd in [
            -0.000_001,
            -1.0,
            f64::NAN,
            f64::INFINITY,
            f64::NEG_INFINITY,
            1_000_000_000.01,
            1e300,
        ] {
            assert_eq!(MicroUsd::from_usd(usd), None, "{usd}");
        }
        assert_eq!(MicroUsd::from_micros(-1), None);
        assert_eq!(MicroUsd::from_micros(MicroUsd::MAX.micros() + 1), None);
        assert_eq!(MicroUsd::from_micros(i64::MAX), None);
    }

    #[test]
    fn llm_settings_are_empty_until_something_is_decided() {
        assert!(LlmSettings::default().is_empty());
        let budget = LlmBudget {
            daily: MicroUsd::from_usd(0.2).unwrap(),
            monthly: MicroUsd::from_usd(5.0).unwrap(),
        };
        assert!(
            !LlmSettings {
                consent: None,
                budget: Some(budget)
            }
            .is_empty()
        );
    }

    #[test]
    fn unknown_wire_names_and_out_of_range_priorities_are_rejected() {
        assert_eq!(TaskStatus::parse("cancelled"), None);
        assert_eq!(ProjectKind::parse("INBOX"), None);
        assert_eq!(TaskPriority::new(0), None);
        assert_eq!(TaskPriority::new(5), None);
        assert_eq!(TaskPriority::new(-1), None);
        assert_eq!(TaskPriority::new(4).map(TaskPriority::get), Some(4));
        assert_eq!(TaskPriority::DEFAULT.get(), 2);
    }
}
