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
        u8::try_from(value).ok().filter(|value| (1..=4).contains(value)).map(Self)
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
