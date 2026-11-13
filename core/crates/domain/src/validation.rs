//! Task and project input rules that a JSON schema cannot express.
//!
//! A port of `packages/provider-native/src/in-memory/validation.ts`, the
//! reference behaviour of the native task repository. Shape checks (types,
//! integer ranges, id syntax) are done against the contract schema before a
//! request reaches these functions.

use crate::{
    DomainError, Id, Instant, SessionWindow, TaskCreate, TaskPatch, TaskPriority, TaskStatus,
    is_blank_js, utf16_len,
};

pub const MAX_TITLE_LENGTH: usize = 200;
pub const MAX_DESCRIPTION_LENGTH: usize = 20_000;

/// A validated task creation with defaults applied.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NormalizedTaskCreate {
    pub project_id: Option<Id>,
    pub title: String,
    pub description: Option<String>,
    pub status: TaskStatus,
    pub due_at: Option<Instant>,
    pub splittable: bool,
    pub session: Option<SessionWindow>,
    pub priority: TaskPriority,
    pub depends_on: Vec<Id>,
}

/// A validated partial update; see [`TaskPatch`] for the nested options.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct NormalizedTaskPatch {
    pub project_id: Option<Id>,
    pub title: Option<String>,
    pub description: Option<Option<String>>,
    pub status: Option<TaskStatus>,
    pub due_at: Option<Option<Instant>>,
    pub splittable: Option<bool>,
    pub session: Option<Option<SessionWindow>>,
    pub priority: Option<TaskPriority>,
    pub depends_on: Option<Vec<Id>>,
}

fn validate_title(title: &str) -> Result<(), DomainError> {
    if is_blank_js(title) {
        return Err(DomainError::invalid("title", "title must not be empty"));
    }
    if utf16_len(title) > MAX_TITLE_LENGTH {
        return Err(DomainError::invalid(
            "title",
            &format!("title must be at most {MAX_TITLE_LENGTH} characters"),
        ));
    }
    Ok(())
}

/// Project titles follow the task title rule.
pub fn validate_project_title(title: &str) -> Result<(), DomainError> {
    validate_title(title)
}

fn validate_description(description: &str) -> Result<(), DomainError> {
    if utf16_len(description) > MAX_DESCRIPTION_LENGTH {
        return Err(DomainError::invalid(
            "description",
            &format!("description must be at most {MAX_DESCRIPTION_LENGTH} characters"),
        ));
    }
    Ok(())
}

fn validate_due_at(text: &str) -> Result<Instant, DomainError> {
    Instant::parse_rfc3339(text).map_err(|error| DomainError::invalid("dueAt", error.message()))
}

fn validate_session(session: SessionWindow) -> Result<SessionWindow, DomainError> {
    for (path, minutes) in
        [("session.minMinutes", session.min_minutes), ("session.maxMinutes", session.max_minutes)]
    {
        if !(1..=1440).contains(&minutes) {
            return Err(DomainError::invalid(path, "expected an integer between 1 and 1440"));
        }
    }
    if session.min_minutes > session.max_minutes {
        return Err(DomainError::invalid("session", "minMinutes must not exceed maxMinutes"));
    }
    Ok(session)
}

/// Removes repeated ids, keeping the first occurrence of each.
fn dedupe(ids: &[Id]) -> Vec<Id> {
    let mut unique: Vec<Id> = Vec::with_capacity(ids.len());
    for id in ids {
        if !unique.contains(id) {
            unique.push(id.clone());
        }
    }
    unique
}

/// Validates a creation request and fills the defaults: status `todo`,
/// not splittable, priority 2, no dependencies.
pub fn validate_task_create(input: &TaskCreate) -> Result<NormalizedTaskCreate, DomainError> {
    if let Some(description) = &input.description {
        validate_description(description)?;
    }
    let due_at = input.due_at.as_deref().map(validate_due_at).transpose()?;
    let session = input.session.map(validate_session).transpose()?;
    validate_title(&input.title)?;
    Ok(NormalizedTaskCreate {
        project_id: input.project_id.clone(),
        title: input.title.clone(),
        description: input.description.clone(),
        status: input.status.unwrap_or(TaskStatus::Todo),
        due_at,
        splittable: input.splittable.unwrap_or(false),
        session,
        priority: input.priority.unwrap_or(TaskPriority::DEFAULT),
        depends_on: input.depends_on.as_deref().map(dedupe).unwrap_or_default(),
    })
}

/// Validates the fields a patch carries; absent fields stay absent.
pub fn validate_task_patch(patch: &TaskPatch) -> Result<NormalizedTaskPatch, DomainError> {
    if let Some(title) = &patch.title {
        validate_title(title)?;
    }
    if let Some(Some(description)) = &patch.description {
        validate_description(description)?;
    }
    let due_at = match &patch.due_at {
        None => None,
        Some(None) => Some(None),
        Some(Some(text)) => Some(Some(validate_due_at(text)?)),
    };
    let session = match patch.session {
        None => None,
        Some(None) => Some(None),
        Some(Some(session)) => Some(Some(validate_session(session)?)),
    };
    Ok(NormalizedTaskPatch {
        project_id: patch.project_id.clone(),
        title: patch.title.clone(),
        description: patch.description.clone(),
        status: patch.status,
        due_at,
        splittable: patch.splittable,
        session,
        priority: patch.priority,
        depends_on: patch.depends_on.as_deref().map(dedupe),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ValidationIssue;

    fn id(last: char) -> Id {
        Id::parse(&format!("0193a8f2-6c1e-7b41-9a2e-1f1d6a0b3c5{last}")).unwrap()
    }

    fn issue(error: DomainError) -> ValidationIssue {
        match error {
            DomainError::ValidationFailed(mut issues) => issues.remove(0),
            other => panic!("expected a validation error, got {other:?}"),
        }
    }

    #[test]
    fn create_applies_the_defaults() {
        let normalized =
            validate_task_create(&TaskCreate { title: "Read papers".into(), ..TaskCreate::default() })
                .unwrap();
        assert_eq!(normalized.status, TaskStatus::Todo);
        assert!(!normalized.splittable);
        assert_eq!(normalized.priority, TaskPriority::DEFAULT);
        assert!(normalized.depends_on.is_empty());
        assert_eq!(normalized.due_at, None);
    }

    #[test]
    fn create_normalises_the_due_time_and_dedupes_dependencies() {
        let normalized = validate_task_create(&TaskCreate {
            title: "Read papers".into(),
            due_at: Some("2026-11-20T23:59:00+09:00".into()),
            depends_on: Some(vec![id('5'), id('6'), id('5')]),
            ..TaskCreate::default()
        })
        .unwrap();
        assert_eq!(normalized.due_at.unwrap().to_rfc3339(), "2026-11-20T14:59:00.000Z");
        assert_eq!(normalized.depends_on, vec![id('5'), id('6')]);
    }

    #[test]
    fn blank_and_overlong_titles_are_rejected() {
        let blank = validate_task_create(&TaskCreate { title: " \u{3000}\t".into(), ..TaskCreate::default() });
        assert_eq!(issue(blank.unwrap_err()), ValidationIssue::new("title", "title must not be empty"));

        let long = validate_task_create(&TaskCreate { title: "가".repeat(201), ..TaskCreate::default() });
        assert_eq!(
            issue(long.unwrap_err()),
            ValidationIssue::new("title", "title must be at most 200 characters")
        );

        // 101 emoji are 101 characters for a JSON schema but 202 UTF-16 units.
        let emoji = validate_project_title(&"😀".repeat(101));
        assert_eq!(issue(emoji.unwrap_err()).path, "title");
        assert!(validate_project_title(&"가".repeat(200)).is_ok());
    }

    #[test]
    fn impossible_due_times_and_inverted_sessions_are_rejected() {
        let due = validate_task_create(&TaskCreate {
            title: "x".into(),
            due_at: Some("2026-02-30T00:00:00Z".into()),
            ..TaskCreate::default()
        });
        assert_eq!(issue(due.unwrap_err()), ValidationIssue::new("dueAt", "invalid calendar date-time"));

        let session = validate_task_create(&TaskCreate {
            title: "x".into(),
            session: Some(SessionWindow { min_minutes: 90, max_minutes: 30 }),
            ..TaskCreate::default()
        });
        assert_eq!(
            issue(session.unwrap_err()),
            ValidationIssue::new("session", "minMinutes must not exceed maxMinutes")
        );

        let zero = validate_task_create(&TaskCreate {
            title: "x".into(),
            session: Some(SessionWindow { min_minutes: 0, max_minutes: 30 }),
            ..TaskCreate::default()
        });
        assert_eq!(issue(zero.unwrap_err()).path, "session.minMinutes");
    }

    #[test]
    fn patch_keeps_absent_fields_absent_and_distinguishes_clear_from_set() {
        let normalized = validate_task_patch(&TaskPatch {
            description: Some(None),
            due_at: Some(Some("2026-11-20T14:59:00Z".into())),
            ..TaskPatch::default()
        })
        .unwrap();
        assert_eq!(normalized.title, None);
        assert_eq!(normalized.description, Some(None));
        assert_eq!(
            normalized.due_at.unwrap().unwrap().to_rfc3339(),
            "2026-11-20T14:59:00.000Z"
        );
        assert_eq!(normalized.session, None);
    }

    #[test]
    fn patch_rejects_a_blank_title_and_an_overlong_description() {
        let title = validate_task_patch(&TaskPatch { title: Some("\n".into()), ..TaskPatch::default() });
        assert_eq!(issue(title.unwrap_err()).path, "title");

        let description = validate_task_patch(&TaskPatch {
            description: Some(Some("a".repeat(MAX_DESCRIPTION_LENGTH + 1))),
            ..TaskPatch::default()
        });
        assert_eq!(issue(description.unwrap_err()).path, "description");
    }
}
