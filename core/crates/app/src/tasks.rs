//! Task use-cases: the native task model that replaces the Vikunja provider.
//!
//! The reference behaviour is `InMemoryTaskRepository`
//! (`packages/provider-native/src/in-memory/task-repository.ts`) plus
//! `TaskService` (`services/api/src/application/task-service.ts`). One rule
//! is deliberately different and matches what the Vikunja-backed core does in
//! production (ADR-016, FU-81): deleting a task removes it from the
//! `dependsOn` list of the tasks that depended on it.

use ohmydate_domain::{
    DependencyEdge, DomainError, Id, Task, TaskCreate, TaskPatch, TaskStatus, Version,
    assert_acyclic, validate_task_create, validate_task_patch,
};
use ohmydate_store::{PageAfter, projects, tasks};

pub use ohmydate_store::tasks::TaskFilter;

use crate::cursor::{self, Page, PageQuery};
use crate::{AppError, Unit};

/// A live task, or `None` when it does not exist or was deleted.
pub fn get(unit: &Unit<'_>, id: &Id) -> Result<Option<Task>, AppError> {
    Ok(tasks::get(unit.connection, id)?.filter(|task| task.deleted_at.is_none()))
}

/// Live tasks, oldest first.
pub fn list(
    unit: &Unit<'_>,
    filter: &TaskFilter,
    query: &PageQuery,
) -> Result<Page<Task>, AppError> {
    let (after, limit) = cursor::resolve(query)?;
    let rows = tasks::list(unit.connection, filter, after.as_ref(), limit + 1)?;
    Ok(cursor::page(rows, limit, |task| PageAfter {
        created_at: task.created_at,
        id: task.id.clone(),
    }))
}

fn require_live(unit: &Unit<'_>, id: &Id) -> Result<Task, AppError> {
    get(unit, id)?.ok_or_else(|| DomainError::not_found("task", id).into())
}

fn require_version(task: &Task, expected: Version) -> Result<(), AppError> {
    if task.version == expected {
        Ok(())
    } else {
        Err(DomainError::VersionConflict {
            expected,
            actual: Some(task.version),
        }
        .into())
    }
}

fn require_project(unit: &Unit<'_>, id: &Id) -> Result<(), AppError> {
    match projects::get(unit.connection, id)? {
        Some(_) => Ok(()),
        None => Err(DomainError::not_found("project", id).into()),
    }
}

/// Every dependency must be a live task; the graph with this task's new edges
/// must stay acyclic.
fn check_dependencies(unit: &Unit<'_>, task_id: &Id, depends_on: &[Id]) -> Result<(), AppError> {
    for dependency in depends_on {
        // A task cannot wait for itself; report it as a cycle, not as a
        // missing task (a task being created does not exist yet).
        if dependency != task_id {
            require_live(unit, dependency)?;
        }
    }
    let mut edges: Vec<DependencyEdge> = tasks::live_edges(unit.connection)?
        .into_iter()
        .filter(|edge| edge.task_id != *task_id)
        .collect();
    edges.extend(depends_on.iter().map(|dependency| DependencyEdge {
        task_id: task_id.clone(),
        depends_on_task_id: dependency.clone(),
    }));
    assert_acyclic(&edges)?;
    Ok(())
}

/// Creates a task. Without a project it goes to the Inbox.
pub fn create(unit: &Unit<'_>, input: &TaskCreate) -> Result<Task, AppError> {
    let normalized = validate_task_create(input)?;
    let project_id = match normalized.project_id {
        Some(project_id) => {
            require_project(unit, &project_id)?;
            project_id
        }
        None => crate::projects::inbox(unit)?.id,
    };
    let id = unit.ids.next_id();
    check_dependencies(unit, &id, &normalized.depends_on)?;
    let now = unit.clock.now();
    let task = Task {
        id,
        project_id,
        title: normalized.title,
        description: normalized.description,
        status: normalized.status,
        due_at: normalized.due_at,
        splittable: normalized.splittable,
        session: normalized.session,
        priority: normalized.priority,
        depends_on: normalized.depends_on,
        version: Version::INITIAL,
        created_at: now,
        updated_at: now,
        deleted_at: None,
    };
    tasks::insert(unit.connection, &task)?;
    Ok(task)
}

/// Applies a partial update when `expected` is the current version.
pub fn update(
    unit: &Unit<'_>,
    id: &Id,
    patch: &TaskPatch,
    expected: Version,
) -> Result<Task, AppError> {
    let normalized = validate_task_patch(patch)?;
    if let Some(project_id) = &normalized.project_id {
        require_project(unit, project_id)?;
    }
    // Order as in the reference: unknown id is 404, then a stale version is
    // 412, and only then a deleted task is 404.
    let current =
        tasks::get(unit.connection, id)?.ok_or_else(|| DomainError::not_found("task", id))?;
    require_version(&current, expected)?;
    if current.deleted_at.is_some() {
        return Err(DomainError::not_found("task", id).into());
    }
    let depends_on = normalized
        .depends_on
        .unwrap_or_else(|| current.depends_on.clone());
    check_dependencies(unit, id, &depends_on)?;

    let task = Task {
        id: current.id,
        project_id: normalized.project_id.unwrap_or(current.project_id),
        title: normalized.title.unwrap_or(current.title),
        description: normalized.description.unwrap_or(current.description),
        status: normalized.status.unwrap_or(current.status),
        due_at: normalized.due_at.unwrap_or(current.due_at),
        splittable: normalized.splittable.unwrap_or(current.splittable),
        session: normalized.session.unwrap_or(current.session),
        priority: normalized.priority.unwrap_or(current.priority),
        depends_on,
        version: current.version.next(),
        created_at: current.created_at,
        updated_at: unit.clock.now(),
        deleted_at: None,
    };
    tasks::update(unit.connection, &task)?;
    Ok(task)
}

/// Marks a task done. Completing a done task changes nothing (same version).
pub fn complete(unit: &Unit<'_>, id: &Id, expected: Version) -> Result<Task, AppError> {
    let current = require_live(unit, id)?;
    require_version(&current, expected)?;
    if current.status == TaskStatus::Done {
        return Ok(current);
    }
    let task = Task {
        status: TaskStatus::Done,
        version: current.version.next(),
        updated_at: unit.clock.now(),
        ..current
    };
    tasks::update(unit.connection, &task)?;
    Ok(task)
}

/// Soft-deletes a task and returns its new version. Tasks that depended on it
/// lose that dependency and get a new version.
pub fn delete(unit: &Unit<'_>, id: &Id, expected: Version) -> Result<Version, AppError> {
    let current = require_live(unit, id)?;
    require_version(&current, expected)?;
    let now = unit.clock.now();
    for dependent_id in tasks::dependents_of(unit.connection, id)? {
        let dependent = require_live(unit, &dependent_id)?;
        let depends_on = dependent
            .depends_on
            .iter()
            .filter(|dependency| *dependency != id)
            .cloned()
            .collect();
        tasks::update(
            unit.connection,
            &Task {
                depends_on,
                version: dependent.version.next(),
                updated_at: now,
                ..dependent
            },
        )?;
    }
    let deleted = Task {
        version: current.version.next(),
        updated_at: now,
        deleted_at: Some(now),
        ..current
    };
    tasks::update(unit.connection, &deleted)?;
    Ok(deleted.version)
}

/// Appends one dependency edge and returns the updated task.
pub fn add_dependency(
    unit: &Unit<'_>,
    id: &Id,
    depends_on_task_id: &Id,
    expected: Version,
) -> Result<Task, AppError> {
    let current = require_live(unit, id)?;
    let mut depends_on = current.depends_on;
    if !depends_on.contains(depends_on_task_id) {
        depends_on.push(depends_on_task_id.clone());
    }
    update(
        unit,
        id,
        &TaskPatch {
            depends_on: Some(depends_on),
            ..TaskPatch::default()
        },
        expected,
    )
}

#[cfg(test)]
mod tests {
    use ohmydate_domain::{ProblemCode, SessionWindow, TaskPriority};

    use super::*;
    use crate::testing::{TestApp, id};

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

    fn titled(title: &str) -> TaskCreate {
        TaskCreate {
            title: title.into(),
            ..TaskCreate::default()
        }
    }

    fn new_task(test: &TestApp, title: &str) -> Task {
        run(test, |unit| create(unit, &titled(title))).unwrap()
    }

    fn code(error: &AppError) -> ProblemCode {
        match error {
            AppError::Domain(error) => error.code(),
            other => panic!("expected a domain error, got {other:?}"),
        }
    }

    fn patch_title(title: &str) -> TaskPatch {
        TaskPatch {
            title: Some(title.into()),
            ..TaskPatch::default()
        }
    }

    fn v(value: u32) -> Version {
        Version::new(value).unwrap()
    }

    #[test]
    fn a_task_without_a_project_goes_to_the_inbox_with_defaults() {
        let test = TestApp::new();
        let task = new_task(&test, "Read papers");
        let inbox = test.app.read(crate::projects::inbox).unwrap();
        assert_eq!(task.project_id, inbox.id);
        assert_eq!(task.status, TaskStatus::Todo);
        assert_eq!(task.priority, TaskPriority::DEFAULT);
        assert_eq!(task.version, Version::INITIAL);
        assert!(!task.splittable);
        assert_eq!(task.created_at, task.updated_at);
        assert_eq!(
            test.app.read(|unit| get(unit, &task.id)).unwrap(),
            Some(task)
        );
    }

    #[test]
    fn create_rejects_unknown_projects_dependencies_and_bad_input() {
        let test = TestApp::new();
        let unknown_project = run(&test, |unit| {
            create(
                unit,
                &TaskCreate {
                    project_id: Some(id(1)),
                    ..titled("x")
                },
            )
        });
        assert_eq!(code(&unknown_project.unwrap_err()), ProblemCode::NotFound);

        let unknown_dependency = run(&test, |unit| {
            create(
                unit,
                &TaskCreate {
                    depends_on: Some(vec![id(2)]),
                    ..titled("x")
                },
            )
        });
        assert_eq!(
            code(&unknown_dependency.unwrap_err()),
            ProblemCode::NotFound
        );

        let blank = run(&test, |unit| create(unit, &titled("  ")));
        assert_eq!(code(&blank.unwrap_err()), ProblemCode::ValidationFailed);

        let page = test
            .app
            .read(|unit| list(unit, &TaskFilter::default(), &PageQuery::default()));
        assert!(
            page.unwrap().items.is_empty(),
            "failed creates must not leave rows"
        );
    }

    #[test]
    fn update_changes_fields_clears_nullable_ones_and_bumps_the_version() {
        let test = TestApp::new();
        let created = run(&test, |unit| {
            create(
                unit,
                &TaskCreate {
                    description: Some("notes".into()),
                    due_at: Some("2026-11-20T23:59:00+09:00".into()),
                    session: Some(SessionWindow {
                        min_minutes: 30,
                        max_minutes: 90,
                    }),
                    ..titled("Draft")
                },
            )
        })
        .unwrap();

        let updated = run(&test, |unit| {
            update(
                unit,
                &created.id,
                &TaskPatch {
                    title: Some("Final".into()),
                    description: Some(None),
                    due_at: Some(None),
                    status: Some(TaskStatus::InProgress),
                    ..TaskPatch::default()
                },
                v(1),
            )
        })
        .unwrap();
        assert_eq!(updated.title, "Final");
        assert_eq!(updated.description, None);
        assert_eq!(updated.due_at, None);
        assert_eq!(
            updated.session, created.session,
            "an absent field keeps its value"
        );
        assert_eq!(updated.status, TaskStatus::InProgress);
        assert_eq!(updated.version, v(2));
        assert_eq!(updated.created_at, created.created_at);
        assert!(updated.updated_at > created.updated_at);
    }

    #[test]
    fn a_stale_version_is_a_conflict_and_changes_nothing() {
        let test = TestApp::new();
        let task = new_task(&test, "Draft");
        run(&test, |unit| {
            update(unit, &task.id, &patch_title("Second"), v(1))
        })
        .unwrap();
        let stale = run(&test, |unit| {
            update(unit, &task.id, &patch_title("Third"), v(1))
        });
        match stale.unwrap_err() {
            AppError::Domain(DomainError::VersionConflict { expected, actual }) => {
                assert_eq!((expected, actual), (v(1), Some(v(2))));
            }
            other => panic!("expected a version conflict, got {other:?}"),
        }
        let stored = test.app.read(|unit| get(unit, &task.id)).unwrap().unwrap();
        assert_eq!(stored.title, "Second");
    }

    #[test]
    fn update_error_order_is_missing_then_stale_then_deleted() {
        let test = TestApp::new();
        let missing = run(&test, |unit| update(unit, &id(7), &patch_title("x"), v(1)));
        assert_eq!(code(&missing.unwrap_err()), ProblemCode::NotFound);

        let task = new_task(&test, "Draft");
        run(&test, |unit| delete(unit, &task.id, v(1))).unwrap();
        let stale_on_deleted = run(&test, |unit| {
            update(unit, &task.id, &patch_title("x"), v(1))
        });
        assert_eq!(
            code(&stale_on_deleted.unwrap_err()),
            ProblemCode::VersionConflict
        );
        let current_on_deleted = run(&test, |unit| {
            update(unit, &task.id, &patch_title("x"), v(2))
        });
        assert_eq!(
            code(&current_on_deleted.unwrap_err()),
            ProblemCode::NotFound
        );
    }

    #[test]
    fn completing_is_idempotent_and_checks_the_version() {
        let test = TestApp::new();
        let task = new_task(&test, "Draft");
        let stale = run(&test, |unit| complete(unit, &task.id, v(9)));
        assert_eq!(code(&stale.unwrap_err()), ProblemCode::VersionConflict);

        let done = run(&test, |unit| complete(unit, &task.id, v(1))).unwrap();
        assert_eq!((done.status, done.version), (TaskStatus::Done, v(2)));
        let again = run(&test, |unit| complete(unit, &task.id, v(2))).unwrap();
        assert_eq!(
            again, done,
            "completing a done task must not bump the version"
        );

        let missing = run(&test, |unit| complete(unit, &id(7), v(1)));
        assert_eq!(code(&missing.unwrap_err()), ProblemCode::NotFound);
    }

    #[test]
    fn a_deleted_task_disappears_and_cannot_be_deleted_twice() {
        let test = TestApp::new();
        let task = new_task(&test, "Draft");
        let stale = run(&test, |unit| delete(unit, &task.id, v(3)));
        assert_eq!(code(&stale.unwrap_err()), ProblemCode::VersionConflict);

        assert_eq!(
            run(&test, |unit| delete(unit, &task.id, v(1))).unwrap(),
            v(2)
        );
        assert_eq!(test.app.read(|unit| get(unit, &task.id)).unwrap(), None);
        let page = test
            .app
            .read(|unit| list(unit, &TaskFilter::default(), &PageQuery::default()));
        assert!(page.unwrap().items.is_empty());
        let twice = run(&test, |unit| delete(unit, &task.id, v(2)));
        assert_eq!(code(&twice.unwrap_err()), ProblemCode::NotFound);
    }

    #[test]
    fn deleting_a_task_releases_the_tasks_that_waited_for_it() {
        let test = TestApp::new();
        let first = new_task(&test, "first");
        let other = new_task(&test, "other");
        let waiting = run(&test, |unit| {
            create(
                unit,
                &TaskCreate {
                    depends_on: Some(vec![first.id.clone(), other.id.clone()]),
                    ..titled("waiting")
                },
            )
        })
        .unwrap();

        run(&test, |unit| delete(unit, &first.id, v(1))).unwrap();
        let released = test
            .app
            .read(|unit| get(unit, &waiting.id))
            .unwrap()
            .unwrap();
        assert_eq!(released.depends_on, vec![other.id.clone()]);
        assert_eq!(released.version, v(2));
        // The released task stays editable: its remaining edges are all live.
        run(&test, |unit| {
            update(unit, &waiting.id, &patch_title("still editable"), v(2))
        })
        .unwrap();
        let untouched = test.app.read(|unit| get(unit, &other.id)).unwrap().unwrap();
        assert_eq!(untouched.version, v(1));
    }

    #[test]
    fn dependencies_append_once_and_cycles_are_refused() {
        let test = TestApp::new();
        let (a, b, c) = (
            new_task(&test, "a"),
            new_task(&test, "b"),
            new_task(&test, "c"),
        );
        let b2 = run(&test, |unit| add_dependency(unit, &b.id, &a.id, v(1))).unwrap();
        assert_eq!(
            (b2.depends_on.clone(), b2.version),
            (vec![a.id.clone()], v(2))
        );
        let c2 = run(&test, |unit| add_dependency(unit, &c.id, &b.id, v(1))).unwrap();
        assert_eq!(c2.depends_on, vec![b.id.clone()]);

        // Adding the same edge again keeps one edge (the version still moves,
        // as in the reference).
        let b3 = run(&test, |unit| add_dependency(unit, &b.id, &a.id, v(2))).unwrap();
        assert_eq!((b3.depends_on, b3.version), (vec![a.id.clone()], v(3)));

        let cycle = run(&test, |unit| add_dependency(unit, &a.id, &c.id, v(1)));
        match cycle.unwrap_err() {
            AppError::Domain(DomainError::DependencyCycle(path)) => {
                assert_eq!(path.first(), path.last());
                assert_eq!(path.len(), 4);
            }
            other => panic!("expected a cycle, got {other:?}"),
        }
        let own = run(&test, |unit| add_dependency(unit, &a.id, &a.id, v(1)));
        assert_eq!(code(&own.unwrap_err()), ProblemCode::DependencyCycle);
        let unknown = run(&test, |unit| add_dependency(unit, &a.id, &id(7), v(1)));
        assert_eq!(code(&unknown.unwrap_err()), ProblemCode::NotFound);
        let a_now = test.app.read(|unit| get(unit, &a.id)).unwrap().unwrap();
        assert_eq!((a_now.depends_on.len(), a_now.version), (0, v(1)));
    }

    #[test]
    fn listing_filters_and_pages() {
        let test = TestApp::new();
        let project = run(&test, |unit| crate::projects::create(unit, "Thesis")).unwrap();
        for index in 0..5 {
            let input = TaskCreate {
                project_id: (index % 2 == 0).then(|| project.id.clone()),
                ..titled(&format!("t{index}"))
            };
            let task = run(&test, |unit| create(unit, &input)).unwrap();
            if index == 4 {
                run(&test, |unit| complete(unit, &task.id, v(1))).unwrap();
            }
        }
        let titles = |filter: &TaskFilter, query: &PageQuery| -> (Vec<String>, Option<String>) {
            let page = test.app.read(|unit| list(unit, filter, query)).unwrap();
            (
                page.items.into_iter().map(|task| task.title).collect(),
                page.next_cursor,
            )
        };
        let all = TaskFilter::default();
        let (first, cursor) = titles(
            &all,
            &PageQuery {
                cursor: None,
                limit: Some(3),
            },
        );
        assert_eq!(first, ["t0", "t1", "t2"]);
        let (rest, end) = titles(
            &all,
            &PageQuery {
                cursor,
                limit: Some(3),
            },
        );
        assert_eq!(rest, ["t3", "t4"]);
        assert_eq!(end, None);

        let in_project = TaskFilter {
            project_id: Some(project.id.clone()),
            status: None,
        };
        assert_eq!(
            titles(&in_project, &PageQuery::default()).0,
            ["t0", "t2", "t4"]
        );
        let done = TaskFilter {
            project_id: None,
            status: Some(TaskStatus::Done),
        };
        assert_eq!(titles(&done, &PageQuery::default()).0, ["t4"]);

        let bad = test.app.read(|unit| {
            list(
                unit,
                &all,
                &PageQuery {
                    cursor: Some("%%".into()),
                    limit: None,
                },
            )
        });
        assert_eq!(code(&bad.unwrap_err()), ProblemCode::ValidationFailed);
    }
}
