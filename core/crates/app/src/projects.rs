//! Project use-cases.

use ohmydate_domain::{DomainError, Project, ProjectKind, Version, validate_project_title};
use ohmydate_store::{PageAfter, projects};

use crate::cursor::{self, Page, PageQuery};
use crate::{AppError, Unit};

/// Live projects, oldest first. The Inbox is created with the data file, so
/// it is always the first item of the first page.
pub fn list(unit: &Unit<'_>, query: &PageQuery) -> Result<Page<Project>, AppError> {
    let (after, limit) = cursor::resolve(query)?;
    let rows = projects::list(unit.connection, after.as_ref(), limit + 1)?;
    Ok(cursor::page(rows, limit, |project| PageAfter {
        created_at: project.created_at,
        id: project.id.clone(),
    }))
}

/// Creates a normal project. Only the data-file bootstrap creates the Inbox.
pub fn create(unit: &Unit<'_>, title: &str) -> Result<Project, AppError> {
    validate_project_title(title)?;
    let now = unit.clock.now();
    let project = Project {
        id: unit.ids.next_id(),
        title: title.to_owned(),
        kind: ProjectKind::Normal,
        archived: false,
        version: Version::INITIAL,
        created_at: now,
        updated_at: now,
    };
    projects::insert(unit.connection, &project)?;
    Ok(project)
}

/// The Inbox project (ADR-018).
pub fn inbox(unit: &Unit<'_>) -> Result<Project, AppError> {
    projects::get_inbox(unit.connection)?.ok_or(AppError::Domain(DomainError::NotFound {
        resource: "project",
        id: None,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testing::TestApp;

    fn create_in(test: &TestApp, title: &str) -> Result<Project, AppError> {
        test.app.store().write(|transaction| {
            create(
                &Unit {
                    connection: transaction,
                    clock: test.clock.as_ref(),
                    ids: test.ids(),
                },
                title,
            )
        })
    }

    #[test]
    fn created_projects_are_normal_and_listed_after_the_inbox() {
        let test = TestApp::new();
        test.clock.advance_ms(1);
        let project = create_in(&test, "Thesis").unwrap();
        assert_eq!(project.kind, ProjectKind::Normal);
        assert_eq!(project.version, Version::INITIAL);
        assert!(!project.archived);
        let page = test
            .app
            .read(|unit| list(unit, &PageQuery::default()))
            .unwrap();
        let kinds: Vec<ProjectKind> = page.items.iter().map(|p| p.kind).collect();
        assert_eq!(kinds, [ProjectKind::Inbox, ProjectKind::Normal]);
        assert_eq!(page.next_cursor, None);
        assert_eq!(test.app.read(inbox).unwrap().id, page.items[0].id);
    }

    #[test]
    fn a_blank_title_is_rejected() {
        let test = TestApp::new();
        let error = create_in(&test, "   ").unwrap_err();
        assert!(
            matches!(error, AppError::Domain(DomainError::ValidationFailed(_))),
            "{error:?}"
        );
    }

    #[test]
    fn pages_follow_the_cursor_and_reject_a_bad_one() {
        let test = TestApp::new();
        for title in ["a", "b", "c"] {
            test.clock.advance_ms(1);
            create_in(&test, title).unwrap();
        }
        let query = |cursor: Option<String>| PageQuery {
            cursor,
            limit: Some(2),
        };
        let first = test.app.read(|unit| list(unit, &query(None))).unwrap();
        assert_eq!(first.items.len(), 2);
        let second = test
            .app
            .read(|unit| list(unit, &query(first.next_cursor.clone())))
            .unwrap();
        let titles: Vec<&str> = second.items.iter().map(|p| p.title.as_str()).collect();
        assert_eq!(titles, ["b", "c"]);
        assert_eq!(second.next_cursor, None);

        let error = test
            .app
            .read(|unit| list(unit, &query(Some("garbage".into()))))
            .unwrap_err();
        assert!(
            matches!(error, AppError::Domain(DomainError::ValidationFailed(_))),
            "{error:?}"
        );
    }
}
