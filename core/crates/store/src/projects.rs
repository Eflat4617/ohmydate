//! Project rows.

use ohmydate_domain::{Id, Project, ProjectKind};
use rusqlite::{Connection, OptionalExtension, Row};

use crate::{PageAfter, StoreError, row};

const COLUMNS: &str = "id, title, kind, archived, version, created_at, updated_at";

type RawProject = (String, String, String, bool, i64, i64, i64);

fn raw(row: &Row<'_>) -> rusqlite::Result<RawProject> {
    Ok((
        row.get(0)?,
        row.get(1)?,
        row.get(2)?,
        row.get(3)?,
        row.get(4)?,
        row.get(5)?,
        row.get(6)?,
    ))
}

fn project(raw: RawProject) -> Result<Project, StoreError> {
    let (id, title, kind, archived, version, created_at, updated_at) = raw;
    Ok(Project {
        id: row::id("project", "id", &id)?,
        title,
        kind: ProjectKind::parse(&kind).ok_or(StoreError::Corrupt {
            table: "project",
            column: "kind",
        })?,
        archived,
        version: row::version("project", version)?,
        created_at: row::instant("project", "created_at", created_at)?,
        updated_at: row::instant("project", "updated_at", updated_at)?,
    })
}

pub fn insert(connection: &Connection, project: &Project) -> Result<(), StoreError> {
    connection.execute(
        "INSERT INTO project (id, title, kind, archived, version, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        (
            project.id.as_str(),
            &project.title,
            project.kind.as_str(),
            project.archived,
            project.version.get(),
            project.created_at.epoch_ms(),
            project.updated_at.epoch_ms(),
        ),
    )?;
    Ok(())
}

/// A live project by id.
pub fn get(connection: &Connection, id: &Id) -> Result<Option<Project>, StoreError> {
    connection
        .query_row(
            &format!("SELECT {COLUMNS} FROM project WHERE id = ?1 AND deleted_at IS NULL"),
            [id.as_str()],
            raw,
        )
        .optional()?
        .map(project)
        .transpose()
}

/// The Inbox project, if it has been created.
pub fn get_inbox(connection: &Connection) -> Result<Option<Project>, StoreError> {
    connection
        .query_row(
            &format!("SELECT {COLUMNS} FROM project WHERE kind = 'inbox' AND deleted_at IS NULL"),
            [],
            raw,
        )
        .optional()?
        .map(project)
        .transpose()
}

/// Live projects in `(created_at, id)` order, starting after `after`.
pub fn list(
    connection: &Connection,
    after: Option<&PageAfter>,
    limit: u32,
) -> Result<Vec<Project>, StoreError> {
    let (after_ms, after_id) = match after {
        Some(after) => (after.created_at.epoch_ms(), after.id.as_str()),
        None => (-1, ""),
    };
    let mut statement = connection.prepare_cached(&format!(
        "SELECT {COLUMNS} FROM project
          WHERE deleted_at IS NULL AND (created_at, id) > (?1, ?2)
          ORDER BY created_at, id
          LIMIT ?3"
    ))?;
    let rows = statement.query_map((after_ms, after_id, limit), raw)?;
    rows.map(|result| project(result?)).collect()
}

#[cfg(test)]
mod tests {
    use ohmydate_domain::{Instant, Version};

    use super::*;
    use crate::Store;

    fn sample(suffix: u8, kind: ProjectKind, created_ms: i64) -> Project {
        let at = Instant::from_epoch_ms(created_ms).unwrap();
        Project {
            id: Id::parse(&format!("0193a8f2-6c1e-7b41-9a2e-1f1d6a0b3c{suffix:02x}")).unwrap(),
            title: format!("project {suffix}"),
            kind,
            archived: false,
            version: Version::INITIAL,
            created_at: at,
            updated_at: at,
        }
    }

    #[test]
    fn projects_round_trip_and_the_inbox_is_found_by_kind() {
        let store = Store::open_in_memory().unwrap();
        let inbox = sample(1, ProjectKind::Inbox, 10);
        let normal = sample(2, ProjectKind::Normal, 20);
        store
            .write(|transaction| {
                insert(transaction, &inbox)?;
                insert(transaction, &normal)
            })
            .unwrap();
        assert_eq!(store.read(|c| get(c, &normal.id)).unwrap(), Some(normal));
        assert_eq!(store.read(get_inbox).unwrap(), Some(inbox));
    }

    #[test]
    fn a_missing_project_is_none_and_a_second_inbox_is_refused() {
        let store = Store::open_in_memory().unwrap();
        let missing = sample(9, ProjectKind::Normal, 1).id;
        assert_eq!(store.read(|c| get(c, &missing)).unwrap(), None);
        assert_eq!(store.read(get_inbox).unwrap(), None);

        store
            .write(|transaction| insert(transaction, &sample(1, ProjectKind::Inbox, 10)))
            .unwrap();
        let second =
            store.write(|transaction| insert(transaction, &sample(2, ProjectKind::Inbox, 20)));
        assert!(matches!(second, Err(StoreError::Sqlite(_))), "{second:?}");
    }

    #[test]
    fn listing_pages_in_creation_order_with_id_as_tie_breaker() {
        let store = Store::open_in_memory().unwrap();
        let rows = [
            sample(3, ProjectKind::Normal, 20),
            sample(1, ProjectKind::Normal, 20),
            sample(2, ProjectKind::Normal, 10),
        ];
        store
            .write(|transaction| {
                rows.iter()
                    .try_for_each(|project| insert(transaction, project))
            })
            .unwrap();

        let first = store.read(|c| list(c, None, 2)).unwrap();
        assert_eq!(
            first.iter().map(|p| p.title.as_str()).collect::<Vec<_>>(),
            ["project 2", "project 1"]
        );
        let after = PageAfter {
            created_at: first[1].created_at,
            id: first[1].id.clone(),
        };
        let rest = store.read(|c| list(c, Some(&after), 2)).unwrap();
        assert_eq!(
            rest.iter().map(|p| p.title.as_str()).collect::<Vec<_>>(),
            ["project 3"]
        );
        let end = PageAfter {
            created_at: rest[0].created_at,
            id: rest[0].id.clone(),
        };
        assert!(store.read(|c| list(c, Some(&end), 2)).unwrap().is_empty());
    }
}
