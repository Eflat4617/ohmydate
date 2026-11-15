//! Project use-cases.

use ohmydate_domain::{DomainError, Id, Project, ProjectKind, Version, validate_project_title};
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

/// A partial change of a project: the contract's `ProjectPatch`. An absent
/// field keeps its value.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ProjectPatch {
    pub title: Option<String>,
    pub archived: Option<bool>,
}

impl ProjectPatch {
    /// True when the patch names no field.
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.title.is_none() && self.archived.is_none()
    }
}

/// Renames and/or archives a project (a folder) when `expected` is its
/// current version (FOLD-01).
///
/// The checks run in the order of the reference
/// (`ProjectService.update` in `services/api`, then
/// `InMemoryProjectRepository.update`): unknown id (404), stale version
/// (412), then the rules (422):
///
/// * The Inbox cannot be archived. It can be renamed: it is found by kind,
///   never by title (ADR-018).
/// * An archived project is renamed only by a patch that also brings it back
///   (`archived: false`).
/// * A patch without fields changes nothing: the project keeps its version.
/// * The title follows the rule of [`create`].
///
/// Tasks are never touched: archiving neither deletes nor moves them.
pub fn update(
    unit: &Unit<'_>,
    id: &Id,
    patch: &ProjectPatch,
    expected: Version,
) -> Result<Project, AppError> {
    let current =
        projects::get(unit.connection, id)?.ok_or_else(|| DomainError::not_found("project", id))?;
    if current.version != expected {
        return Err(DomainError::VersionConflict {
            expected,
            actual: Some(current.version),
        }
        .into());
    }
    if current.kind == ProjectKind::Inbox && patch.archived == Some(true) {
        return Err(DomainError::invalid(
            "archived",
            "the inbox project cannot be archived or deleted",
        )
        .into());
    }
    if current.archived && patch.title.is_some() && patch.archived != Some(false) {
        return Err(DomainError::invalid(
            "title",
            "an archived project cannot be renamed; bring it back first",
        )
        .into());
    }
    if patch.is_empty() {
        return Ok(current);
    }
    if let Some(title) = &patch.title {
        validate_project_title(title)?;
    }
    let project = Project {
        title: patch.title.clone().unwrap_or(current.title),
        archived: patch.archived.unwrap_or(current.archived),
        version: current.version.next(),
        updated_at: unit.clock.now(),
        ..current
    };
    projects::update(unit.connection, &project)?;
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
    use ohmydate_domain::{TaskCreate, ValidationIssue};

    use super::*;
    use crate::tasks::{self, TaskFilter};
    use crate::testing::{TestApp, id};

    /// Runs a use-case in a write transaction, one millisecond later.
    fn run<T>(
        test: &TestApp,
        work: impl FnOnce(&Unit<'_>) -> Result<T, AppError>,
    ) -> Result<T, AppError> {
        test.clock.advance_ms(1);
        test.app.store().write(|transaction| {
            work(&Unit {
                connection: transaction,
                clock: test.clock.as_ref(),
                ids: test.ids(),
            })
        })
    }

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

    fn v(value: u32) -> Version {
        Version::new(value).unwrap()
    }

    fn rename(title: &str) -> ProjectPatch {
        ProjectPatch {
            title: Some(title.into()),
            archived: None,
        }
    }

    fn archive(archived: bool) -> ProjectPatch {
        ProjectPatch {
            title: None,
            archived: Some(archived),
        }
    }

    fn stored(test: &TestApp, id: &Id) -> Project {
        test.app
            .read(|unit| Ok(projects::get(unit.connection, id)?))
            .unwrap()
            .unwrap()
    }

    /// The single issue of a 422.
    fn issue(error: AppError) -> ValidationIssue {
        match error {
            AppError::Domain(DomainError::ValidationFailed(mut issues)) if issues.len() == 1 => {
                issues.remove(0)
            }
            other => panic!("expected one validation issue, got {other:?}"),
        }
    }

    #[test]
    fn a_project_is_renamed_archived_and_brought_back_one_version_per_change() {
        let test = TestApp::new();
        let created = run(&test, |unit| create(unit, "Thesiss")).unwrap();

        let renamed = run(&test, |unit| {
            update(unit, &created.id, &rename("Thesis"), v(1))
        })
        .unwrap();
        assert_eq!(
            renamed,
            Project {
                title: "Thesis".into(),
                version: v(2),
                updated_at: renamed.updated_at,
                ..created.clone()
            }
        );
        assert!(renamed.updated_at > created.updated_at);
        assert_eq!(stored(&test, &created.id), renamed);

        let archived = run(&test, |unit| {
            update(unit, &created.id, &archive(true), v(2))
        })
        .unwrap();
        assert_eq!(
            (archived.archived, archived.version, archived.title.as_str()),
            (true, v(3), "Thesis")
        );
        // An archived project is still listed, with its flag.
        let page = test
            .app
            .read(|unit| list(unit, &PageQuery::default()))
            .unwrap();
        assert_eq!(page.items.last(), Some(&archived));

        let back = run(&test, |unit| {
            update(
                unit,
                &created.id,
                &ProjectPatch {
                    title: Some("Thesis, again".into()),
                    archived: Some(false),
                },
                v(3),
            )
        })
        .unwrap();
        assert_eq!(
            (back.archived, back.version, back.title.as_str()),
            (false, v(4), "Thesis, again")
        );
        assert_eq!(
            (back.id.clone(), back.kind, back.created_at),
            (created.id.clone(), ProjectKind::Normal, created.created_at)
        );
        assert_eq!(stored(&test, &created.id), back);
    }

    #[test]
    fn a_missing_project_is_not_found_and_a_stale_version_changes_nothing() {
        let test = TestApp::new();
        let missing = run(&test, |unit| update(unit, &id(7), &rename("x"), v(1)));
        assert!(
            matches!(
                missing,
                Err(AppError::Domain(DomainError::NotFound {
                    resource: "project",
                    ..
                }))
            ),
            "{missing:?}"
        );

        let created = run(&test, |unit| create(unit, "Draft")).unwrap();
        run(&test, |unit| {
            update(unit, &created.id, &rename("Second"), v(1))
        })
        .unwrap();
        let before = stored(&test, &created.id);
        for patch in [rename("Third"), archive(true), ProjectPatch::default()] {
            let stale = run(&test, |unit| update(unit, &created.id, &patch, v(1)));
            match stale.unwrap_err() {
                AppError::Domain(DomainError::VersionConflict { expected, actual }) => {
                    assert_eq!((expected, actual), (v(1), Some(v(2))));
                }
                other => panic!("expected a version conflict, got {other:?}"),
            }
        }
        assert_eq!(stored(&test, &created.id), before);
    }

    #[test]
    fn the_inbox_is_never_archived_but_can_be_renamed_and_stays_the_inbox() {
        let test = TestApp::new();
        let inbox_before = test.app.read(inbox).unwrap();

        for patch in [
            archive(true),
            ProjectPatch {
                title: Some("Gone".into()),
                archived: Some(true),
            },
            // The Inbox rule answers before the title is looked at.
            ProjectPatch {
                title: Some("   ".into()),
                archived: Some(true),
            },
        ] {
            let refused = run(&test, |unit| update(unit, &inbox_before.id, &patch, v(1)));
            assert_eq!(
                issue(refused.unwrap_err()),
                ValidationIssue::new(
                    "archived",
                    "the inbox project cannot be archived or deleted"
                )
            );
        }
        assert_eq!(test.app.read(inbox).unwrap(), inbox_before);

        let renamed = run(&test, |unit| {
            update(unit, &inbox_before.id, &rename("바깥"), v(1))
        })
        .unwrap();
        assert_eq!(
            (renamed.kind, renamed.title.as_str(), renamed.version),
            (ProjectKind::Inbox, "바깥", v(2))
        );
        assert_eq!(test.app.read(inbox).unwrap(), renamed);
        // Found by kind, not by title: a task without a project still lands in it.
        let task = run(&test, |unit| {
            tasks::create(
                unit,
                &TaskCreate {
                    title: "lands outside".into(),
                    ..TaskCreate::default()
                },
            )
        })
        .unwrap();
        assert_eq!(task.project_id, inbox_before.id);
        // Renamed or not, it cannot be archived; `archived: false` is what it is.
        let still = run(&test, |unit| {
            update(unit, &inbox_before.id, &archive(true), v(2))
        });
        assert_eq!(issue(still.unwrap_err()).path, "archived");
        let same = run(&test, |unit| {
            update(unit, &inbox_before.id, &archive(false), v(2))
        })
        .unwrap();
        assert_eq!((same.kind, same.archived), (ProjectKind::Inbox, false));
    }

    #[test]
    fn an_empty_patch_changes_nothing_but_still_needs_the_current_version() {
        let test = TestApp::new();
        let created = run(&test, |unit| create(unit, "Untouched")).unwrap();

        let same = run(&test, |unit| {
            update(unit, &created.id, &ProjectPatch::default(), v(1))
        })
        .unwrap();
        assert_eq!(same, created, "no new version and no new updated_at");
        assert_eq!(stored(&test, &created.id), created);

        let stale = run(&test, |unit| {
            update(unit, &created.id, &ProjectPatch::default(), v(2))
        });
        assert!(
            matches!(
                stale,
                Err(AppError::Domain(DomainError::VersionConflict { .. }))
            ),
            "{stale:?}"
        );
        let missing = run(&test, |unit| {
            update(unit, &id(7), &ProjectPatch::default(), v(1))
        });
        assert!(
            matches!(missing, Err(AppError::Domain(DomainError::NotFound { .. }))),
            "{missing:?}"
        );
        // The version did not move, so the next change still matches it.
        let next = run(&test, |unit| {
            update(unit, &created.id, &rename("Touched"), v(1))
        })
        .unwrap();
        assert_eq!(next.version, v(2));
        assert!(ProjectPatch::default().is_empty());
        assert!(!rename("x").is_empty() && !archive(false).is_empty());
    }

    #[test]
    fn the_title_follows_the_create_rule_and_a_refused_patch_changes_nothing() {
        let test = TestApp::new();
        let created = run(&test, |unit| create(unit, "Validated")).unwrap();

        for title in ["", "   ", "\u{3000}"] {
            let blank = run(&test, |unit| {
                update(
                    unit,
                    &created.id,
                    &ProjectPatch {
                        title: Some(title.into()),
                        archived: Some(true),
                    },
                    v(1),
                )
            });
            assert_eq!(
                issue(blank.unwrap_err()),
                ValidationIssue::new("title", "title must not be empty")
            );
        }
        let too_long = run(&test, |unit| {
            update(unit, &created.id, &rename(&"x".repeat(201)), v(1))
        });
        assert_eq!(issue(too_long.unwrap_err()).path, "title");
        // The same answers `create` gives.
        assert_eq!(
            issue(run(&test, |unit| create(unit, "   ")).unwrap_err()),
            ValidationIssue::new("title", "title must not be empty")
        );
        // A stale version is reported before the title is looked at.
        let stale = run(&test, |unit| {
            update(unit, &created.id, &rename("   "), v(9))
        });
        assert!(
            matches!(
                stale,
                Err(AppError::Domain(DomainError::VersionConflict { .. }))
            ),
            "{stale:?}"
        );
        assert_eq!(stored(&test, &created.id), created);

        let longest = run(&test, |unit| {
            update(unit, &created.id, &rename(&"가".repeat(200)), v(1))
        })
        .unwrap();
        assert_eq!(longest.title, "가".repeat(200));
    }

    #[test]
    fn an_archived_project_is_renamed_only_by_a_patch_that_brings_it_back() {
        let test = TestApp::new();
        let created = run(&test, |unit| create(unit, "Shelved")).unwrap();
        let shelved = run(&test, |unit| {
            update(unit, &created.id, &archive(true), v(1))
        })
        .unwrap();

        for patch in [
            rename("Renamed"),
            ProjectPatch {
                title: Some("Renamed".into()),
                archived: Some(true),
            },
        ] {
            let refused = run(&test, |unit| update(unit, &created.id, &patch, v(2)));
            assert_eq!(
                issue(refused.unwrap_err()),
                ValidationIssue::new(
                    "title",
                    "an archived project cannot be renamed; bring it back first"
                )
            );
        }
        assert_eq!(stored(&test, &created.id), shelved);

        // Archiving it again is accepted (a new version, as in the reference).
        let again = run(&test, |unit| {
            update(unit, &created.id, &archive(true), v(2))
        })
        .unwrap();
        assert_eq!((again.archived, again.version), (true, v(3)));
        let back = run(&test, |unit| {
            update(
                unit,
                &created.id,
                &ProjectPatch {
                    title: Some("Renamed".into()),
                    archived: Some(false),
                },
                v(3),
            )
        })
        .unwrap();
        assert_eq!(
            (back.title.as_str(), back.archived, back.version),
            ("Renamed", false, v(4))
        );
    }

    #[test]
    fn archiving_a_project_leaves_its_tasks_exactly_as_they_were() {
        let test = TestApp::new();
        let project = run(&test, |unit| create(unit, "Old course")).unwrap();
        let in_project = |title: &str| TaskCreate {
            title: title.into(),
            project_id: Some(project.id.clone()),
            ..TaskCreate::default()
        };
        run(&test, |unit| tasks::create(unit, &in_project("open"))).unwrap();
        let done = run(&test, |unit| tasks::create(unit, &in_project("done"))).unwrap();
        run(&test, |unit| tasks::complete(unit, &done.id, v(1))).unwrap();
        let filter = TaskFilter {
            project_id: Some(project.id.clone()),
            status: None,
        };
        let tasks_now = || {
            test.app
                .read(|unit| tasks::list(unit, &filter, &PageQuery::default()))
                .unwrap()
                .items
        };
        let before = tasks_now();
        assert_eq!(before.len(), 2);

        run(&test, |unit| {
            update(unit, &project.id, &archive(true), v(1))
        })
        .unwrap();
        assert_eq!(
            tasks_now(),
            before,
            "not deleted, not moved, no new version"
        );
        run(&test, |unit| {
            update(unit, &project.id, &archive(false), v(2))
        })
        .unwrap();
        assert_eq!(tasks_now(), before);
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
