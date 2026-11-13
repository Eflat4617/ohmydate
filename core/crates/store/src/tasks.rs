//! Task rows and their dependency edges.

use ohmydate_domain::{DependencyEdge, Id, SessionWindow, Task, TaskPriority, TaskStatus};
use rusqlite::{Connection, OptionalExtension, Row};

use crate::{PageAfter, StoreError, row};

const COLUMNS: &str = "id, project_id, title, description, status, due_at, splittable, \
                       min_session_min, max_session_min, priority, version, created_at, \
                       updated_at, deleted_at";

type RawTask = (
    String,
    String,
    String,
    Option<String>,
    String,
    Option<i64>,
    bool,
    Option<u16>,
    Option<u16>,
    i64,
    i64,
    i64,
    i64,
    Option<i64>,
);

fn raw(row: &Row<'_>) -> rusqlite::Result<RawTask> {
    Ok((
        row.get(0)?,
        row.get(1)?,
        row.get(2)?,
        row.get(3)?,
        row.get(4)?,
        row.get(5)?,
        row.get(6)?,
        row.get(7)?,
        row.get(8)?,
        row.get(9)?,
        row.get(10)?,
        row.get(11)?,
        row.get(12)?,
        row.get(13)?,
    ))
}

fn task(connection: &Connection, raw: RawTask) -> Result<Task, StoreError> {
    let (
        id,
        project_id,
        title,
        description,
        status,
        due_at,
        splittable,
        min_session_min,
        max_session_min,
        priority,
        version,
        created_at,
        updated_at,
        deleted_at,
    ) = raw;
    let id = row::id("task", "id", &id)?;
    let session = match (min_session_min, max_session_min) {
        (Some(min_minutes), Some(max_minutes)) => Some(SessionWindow {
            min_minutes,
            max_minutes,
        }),
        (None, None) => None,
        _ => {
            return Err(StoreError::Corrupt {
                table: "task",
                column: "min_session_min",
            });
        }
    };
    Ok(Task {
        depends_on: depends_on(connection, &id)?,
        id,
        project_id: row::id("task", "project_id", &project_id)?,
        title,
        description,
        status: TaskStatus::parse(&status).ok_or(StoreError::Corrupt {
            table: "task",
            column: "status",
        })?,
        due_at: row::optional_instant("task", "due_at", due_at)?,
        splittable,
        session,
        priority: TaskPriority::new(priority).ok_or(StoreError::Corrupt {
            table: "task",
            column: "priority",
        })?,
        version: row::version("task", version)?,
        created_at: row::instant("task", "created_at", created_at)?,
        updated_at: row::instant("task", "updated_at", updated_at)?,
        deleted_at: row::optional_instant("task", "deleted_at", deleted_at)?,
    })
}

fn depends_on(connection: &Connection, task_id: &Id) -> Result<Vec<Id>, StoreError> {
    let mut statement = connection.prepare_cached(
        "SELECT depends_on_task_id FROM task_dependency WHERE task_id = ?1 ORDER BY position",
    )?;
    let rows = statement.query_map([task_id.as_str()], |row| row.get::<_, String>(0))?;
    rows.map(|text| row::id("task_dependency", "depends_on_task_id", &text?))
        .collect()
}

fn write_dependencies(connection: &Connection, task: &Task) -> Result<(), StoreError> {
    connection.execute(
        "DELETE FROM task_dependency WHERE task_id = ?1",
        [task.id.as_str()],
    )?;
    let mut statement = connection.prepare_cached(
        "INSERT INTO task_dependency (task_id, depends_on_task_id, position) VALUES (?1, ?2, ?3)",
    )?;
    for (position, dependency) in task.depends_on.iter().enumerate() {
        let position = i64::try_from(position).map_err(|_| StoreError::Corrupt {
            table: "task_dependency",
            column: "position",
        })?;
        statement.execute((task.id.as_str(), dependency.as_str(), position))?;
    }
    Ok(())
}

/// Inserts a task with its dependency edges.
pub fn insert(connection: &Connection, task: &Task) -> Result<(), StoreError> {
    connection.execute(
        &format!(
            "INSERT INTO task ({COLUMNS}) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)"
        ),
        (
            task.id.as_str(),
            task.project_id.as_str(),
            &task.title,
            task.description.as_deref(),
            task.status.as_str(),
            task.due_at.map(ohmydate_domain::Instant::epoch_ms),
            task.splittable,
            task.session.map(|session| session.min_minutes),
            task.session.map(|session| session.max_minutes),
            task.priority.get(),
            task.version.get(),
            task.created_at.epoch_ms(),
            task.updated_at.epoch_ms(),
            task.deleted_at.map(ohmydate_domain::Instant::epoch_ms),
        ),
    )?;
    write_dependencies(connection, task)
}

/// Rewrites every mutable column and the dependency list of an existing task.
/// The caller has already checked the version inside the same transaction.
pub fn update(connection: &Connection, task: &Task) -> Result<(), StoreError> {
    let changed = connection.execute(
        "UPDATE task
            SET project_id = ?2, title = ?3, description = ?4, status = ?5, due_at = ?6,
                splittable = ?7, min_session_min = ?8, max_session_min = ?9, priority = ?10,
                version = ?11, updated_at = ?12, deleted_at = ?13
          WHERE id = ?1",
        (
            task.id.as_str(),
            task.project_id.as_str(),
            &task.title,
            task.description.as_deref(),
            task.status.as_str(),
            task.due_at.map(ohmydate_domain::Instant::epoch_ms),
            task.splittable,
            task.session.map(|session| session.min_minutes),
            task.session.map(|session| session.max_minutes),
            task.priority.get(),
            task.version.get(),
            task.updated_at.epoch_ms(),
            task.deleted_at.map(ohmydate_domain::Instant::epoch_ms),
        ),
    )?;
    if changed != 1 {
        return Err(StoreError::Corrupt {
            table: "task",
            column: "id",
        });
    }
    write_dependencies(connection, task)
}

/// A task by id, including soft-deleted ones (`deleted_at` is set on those).
pub fn get(connection: &Connection, id: &Id) -> Result<Option<Task>, StoreError> {
    connection
        .query_row(
            &format!("SELECT {COLUMNS} FROM task WHERE id = ?1"),
            [id.as_str()],
            raw,
        )
        .optional()?
        .map(|raw| task(connection, raw))
        .transpose()
}

/// Which live tasks a listing returns.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct TaskFilter {
    pub project_id: Option<Id>,
    pub status: Option<TaskStatus>,
}

/// Live tasks in `(created_at, id)` order, starting after `after`.
pub fn list(
    connection: &Connection,
    filter: &TaskFilter,
    after: Option<&PageAfter>,
    limit: u32,
) -> Result<Vec<Task>, StoreError> {
    let (after_ms, after_id) = match after {
        Some(after) => (after.created_at.epoch_ms(), after.id.as_str()),
        None => (-1, ""),
    };
    let mut statement = connection.prepare_cached(&format!(
        "SELECT {COLUMNS} FROM task
          WHERE deleted_at IS NULL
            AND (?1 IS NULL OR project_id = ?1)
            AND (?2 IS NULL OR status = ?2)
            AND (created_at, id) > (?3, ?4)
          ORDER BY created_at, id
          LIMIT ?5"
    ))?;
    let rows = statement.query_map(
        (
            filter.project_id.as_ref().map(Id::as_str),
            filter.status.map(TaskStatus::as_str),
            after_ms,
            after_id,
            limit,
        ),
        raw,
    )?;
    rows.map(|result| task(connection, result?)).collect()
}

/// Every dependency edge whose dependent task is live, in a stable order
/// (dependent task by creation, then list position). Input of the cycle check.
pub fn live_edges(connection: &Connection) -> Result<Vec<DependencyEdge>, StoreError> {
    let mut statement = connection.prepare_cached(
        "SELECT d.task_id, d.depends_on_task_id
           FROM task_dependency AS d
           JOIN task AS t ON t.id = d.task_id
          WHERE t.deleted_at IS NULL
          ORDER BY t.created_at, t.id, d.position",
    )?;
    let rows = statement.query_map([], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
    })?;
    rows.map(|result| {
        let (task_id, depends_on_task_id) = result?;
        Ok(DependencyEdge {
            task_id: row::id("task_dependency", "task_id", &task_id)?,
            depends_on_task_id: row::id(
                "task_dependency",
                "depends_on_task_id",
                &depends_on_task_id,
            )?,
        })
    })
    .collect()
}

/// Ids of the live tasks that list `id` as a dependency, oldest first.
pub fn dependents_of(connection: &Connection, id: &Id) -> Result<Vec<Id>, StoreError> {
    let mut statement = connection.prepare_cached(
        "SELECT d.task_id
           FROM task_dependency AS d
           JOIN task AS t ON t.id = d.task_id
          WHERE d.depends_on_task_id = ?1 AND t.deleted_at IS NULL
          ORDER BY t.created_at, t.id",
    )?;
    let rows = statement.query_map([id.as_str()], |row| row.get::<_, String>(0))?;
    rows.map(|text| row::id("task_dependency", "task_id", &text?))
        .collect()
}

#[cfg(test)]
mod tests {
    use ohmydate_domain::{Instant, Project, ProjectKind, Version};

    use super::*;
    use crate::{Store, projects};

    fn id(suffix: u8) -> Id {
        Id::parse(&format!("0193a8f2-6c1e-7b41-9a2e-1f1d6a0b3c{suffix:02x}")).unwrap()
    }

    fn at(epoch_ms: i64) -> Instant {
        Instant::from_epoch_ms(epoch_ms).unwrap()
    }

    fn sample(suffix: u8, created_ms: i64) -> Task {
        Task {
            id: id(suffix),
            project_id: id(0xf0),
            title: format!("task {suffix}"),
            description: None,
            status: TaskStatus::Todo,
            due_at: None,
            splittable: false,
            session: None,
            priority: TaskPriority::DEFAULT,
            depends_on: Vec::new(),
            version: Version::INITIAL,
            created_at: at(created_ms),
            updated_at: at(created_ms),
            deleted_at: None,
        }
    }

    fn store_with_project() -> Store {
        let store = Store::open_in_memory().unwrap();
        for (suffix, kind) in [(0xf0, ProjectKind::Inbox), (0xf1, ProjectKind::Normal)] {
            let project = Project {
                id: id(suffix),
                title: "p".into(),
                kind,
                archived: false,
                version: Version::INITIAL,
                created_at: at(1),
                updated_at: at(1),
            };
            store
                .write(|transaction| projects::insert(transaction, &project))
                .unwrap();
        }
        store
    }

    #[test]
    fn a_task_with_every_field_round_trips() {
        let store = store_with_project();
        let first = sample(1, 10);
        let full = Task {
            description: Some("본문".into()),
            status: TaskStatus::InProgress,
            due_at: Some(at(1_800_000_000_000)),
            splittable: true,
            session: Some(SessionWindow {
                min_minutes: 30,
                max_minutes: 90,
            }),
            priority: TaskPriority::new(4).unwrap(),
            depends_on: vec![first.id.clone()],
            ..sample(2, 20)
        };
        store
            .write(|transaction| {
                insert(transaction, &first)?;
                insert(transaction, &full)
            })
            .unwrap();
        assert_eq!(store.read(|c| get(c, &full.id)).unwrap(), Some(full));
        assert_eq!(store.read(|c| get(c, &id(9))).unwrap(), None);
    }

    #[test]
    fn rows_that_break_the_schema_rules_are_refused() {
        let store = store_with_project();
        let unknown_project = Task {
            project_id: id(0xee),
            ..sample(1, 10)
        };
        assert!(
            store
                .write(|transaction| insert(transaction, &unknown_project))
                .is_err()
        );

        let unknown_dependency = Task {
            depends_on: vec![id(0x77)],
            ..sample(2, 10)
        };
        assert!(
            store
                .write(|transaction| insert(transaction, &unknown_dependency))
                .is_err()
        );
        assert_eq!(
            store.read(|c| get(c, &id(2))).unwrap(),
            None,
            "the insert must roll back"
        );

        let self_dependency = Task {
            depends_on: vec![id(3)],
            ..sample(3, 10)
        };
        assert!(
            store
                .write(|transaction| insert(transaction, &self_dependency))
                .is_err()
        );

        let missing = sample(4, 10);
        assert!(matches!(
            store.write(|transaction| update(transaction, &missing)),
            Err(StoreError::Corrupt {
                table: "task",
                column: "id"
            })
        ));
    }

    #[test]
    fn update_rewrites_columns_and_keeps_dependency_order() {
        let store = store_with_project();
        let (a, b, c) = (sample(1, 10), sample(2, 20), sample(3, 30));
        store
            .write(|transaction| {
                [&a, &b, &c]
                    .into_iter()
                    .try_for_each(|t| insert(transaction, t))
            })
            .unwrap();
        let changed = Task {
            title: "renamed".into(),
            project_id: id(0xf1),
            depends_on: vec![b.id.clone(), a.id.clone()],
            version: c.version.next(),
            updated_at: at(40),
            ..c
        };
        store
            .write(|transaction| update(transaction, &changed))
            .unwrap();
        let stored = store
            .read(|connection| get(connection, &changed.id))
            .unwrap()
            .unwrap();
        assert_eq!(stored, changed);
        assert_eq!(stored.depends_on, vec![b.id.clone(), a.id.clone()]);
        assert_eq!(
            store
                .read(|connection| dependents_of(connection, &a.id))
                .unwrap(),
            vec![id(3)]
        );
    }

    #[test]
    fn listing_filters_pages_and_hides_deleted_tasks() {
        let store = store_with_project();
        let done = Task {
            status: TaskStatus::Done,
            ..sample(2, 20)
        };
        let other_project = Task {
            project_id: id(0xf1),
            ..sample(3, 30)
        };
        let deleted = Task {
            deleted_at: Some(at(50)),
            ..sample(4, 40)
        };
        let rows = [sample(1, 10), done, other_project, deleted];
        store
            .write(|transaction| rows.iter().try_for_each(|t| insert(transaction, t)))
            .unwrap();

        let titles = |filter: &TaskFilter, after: Option<&PageAfter>, limit| -> Vec<String> {
            store
                .read(|connection| list(connection, filter, after, limit))
                .unwrap()
                .into_iter()
                .map(|task| task.title)
                .collect()
        };
        let all = TaskFilter::default();
        assert_eq!(titles(&all, None, 10), ["task 1", "task 2", "task 3"]);
        assert_eq!(titles(&all, None, 2), ["task 1", "task 2"]);
        let after = PageAfter {
            created_at: at(20),
            id: id(2),
        };
        assert_eq!(titles(&all, Some(&after), 10), ["task 3"]);
        let done_only = TaskFilter {
            status: Some(TaskStatus::Done),
            ..TaskFilter::default()
        };
        assert_eq!(titles(&done_only, None, 10), ["task 2"]);
        let in_project = TaskFilter {
            project_id: Some(id(0xf1)),
            ..TaskFilter::default()
        };
        assert_eq!(titles(&in_project, None, 10), ["task 3"]);
        let nothing = TaskFilter {
            project_id: Some(id(0xee)),
            ..TaskFilter::default()
        };
        assert!(titles(&nothing, None, 10).is_empty());
    }

    #[test]
    fn live_edges_skip_dependents_that_are_deleted() {
        let store = store_with_project();
        let a = sample(1, 10);
        let b = Task {
            depends_on: vec![a.id.clone()],
            ..sample(2, 20)
        };
        let gone = Task {
            depends_on: vec![a.id.clone()],
            deleted_at: Some(at(40)),
            ..sample(3, 30)
        };
        store
            .write(|transaction| {
                [&a, &b, &gone]
                    .into_iter()
                    .try_for_each(|t| insert(transaction, t))
            })
            .unwrap();
        let edges = store.read(live_edges).unwrap();
        assert_eq!(
            edges,
            vec![DependencyEdge {
                task_id: id(2),
                depends_on_task_id: id(1)
            }]
        );
        assert_eq!(
            store
                .read(|connection| dependents_of(connection, &a.id))
                .unwrap(),
            vec![id(2)]
        );
    }
}
