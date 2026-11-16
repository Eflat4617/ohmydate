use std::fmt;
use std::sync::Arc;

use ohmydate_domain::{
    Clock, DomainError, Id, IdGenerator, Instant, LlmSettings, Owner, Project, ProjectKind, Version,
};
use ohmydate_store::idempotency::{self, Record, Reservation, StoredResponse};
use ohmydate_store::{Store, StoreError, owner, projects};

use crate::AppError;

/// How long an `Idempotency-Key` is remembered (08 §1: 24 hours).
pub const IDEMPOTENCY_TTL_MS: i64 = 24 * 60 * 60 * 1000;

/// Values for the owner row when a data file is initialised.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OwnerDefaults {
    pub email: String,
    pub time_zone: String,
    pub locale: String,
}

/// What a use-case needs while it runs: the open transaction (or read
/// connection), the clock and the id generator.
pub struct Unit<'a> {
    pub connection: &'a ohmydate_store::Connection,
    pub clock: &'a dyn Clock,
    pub ids: &'a dyn IdGenerator,
}

impl fmt::Debug for Unit<'_> {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.debug_struct("Unit").finish_non_exhaustive()
    }
}

/// Identity of a mutating request for idempotent replay (08 §1).
#[derive(Debug, Clone, Copy)]
pub struct IdempotentRequest<'a> {
    /// The `Idempotency-Key` header (a UUID).
    pub key: &'a str,
    /// Route template, kept for diagnostics.
    pub route: &'a str,
    /// SHA-256 over method, path and normalised body. `If-Match` is excluded.
    pub request_hash: &'a str,
}

/// Result of an idempotent mutation.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Idempotent {
    pub response: StoredResponse,
    /// True when the response was produced by an earlier request with the
    /// same key and nothing was executed now.
    pub replayed: bool,
}

/// The application: the data file plus the ports use-cases need.
pub struct App {
    store: Store,
    clock: Arc<dyn Clock>,
    ids: Arc<dyn IdGenerator>,
    /// The owner row never changes its id. Everything else about the owner
    /// can change, so it is read from the file when needed
    /// ([`crate::settings::owner`]), never kept here.
    owner_id: Id,
}

impl fmt::Debug for App {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("App")
            .field("owner", &self.owner_id)
            .finish_non_exhaustive()
    }
}

impl App {
    /// Wraps an open store. On a new data file this creates the owner row
    /// and the Inbox project in one transaction; on an existing file the
    /// defaults are ignored. Expired idempotency records are removed, and
    /// keys left pending by a previous process are freed.
    pub fn open(
        store: Store,
        clock: Arc<dyn Clock>,
        ids: Arc<dyn IdGenerator>,
        defaults: &OwnerDefaults,
    ) -> Result<Self, AppError> {
        let owner = store.write(|transaction| -> Result<Owner, StoreError> {
            let now = clock.now();
            idempotency::delete_expired(transaction, now)?;
            // Whatever was in flight when the last process ended is gone.
            idempotency::release_all_pending(transaction)?;
            let owner = match owner::get(transaction)? {
                Some(existing) => existing,
                None => {
                    let created = Owner {
                        id: ids.next_id(),
                        email: defaults.email.clone(),
                        time_zone: defaults.time_zone.clone(),
                        locale: defaults.locale.clone(),
                        llm: LlmSettings::default(),
                        version: Version::INITIAL,
                        created_at: now,
                        updated_at: now,
                    };
                    owner::insert(transaction, &created)?;
                    created
                }
            };
            // ADR-018: the Inbox always exists. Creating it here, not lazily
            // on the first read, keeps reads free of writes.
            if projects::get_inbox(transaction)?.is_none() {
                projects::insert(
                    transaction,
                    &Project {
                        id: ids.next_id(),
                        title: "Inbox".to_owned(),
                        kind: ProjectKind::Inbox,
                        archived: false,
                        version: Version::INITIAL,
                        created_at: now,
                        updated_at: now,
                    },
                )?;
            }
            Ok(owner)
        })?;
        Ok(Self {
            store,
            clock,
            ids,
            owner_id: owner.id,
        })
    }

    /// Id of the single local owner: the `ownerId` of every resource.
    #[must_use]
    pub fn owner_id(&self) -> &Id {
        &self.owner_id
    }

    /// True when the data file answers queries.
    #[must_use]
    pub fn is_ready(&self) -> bool {
        self.store.is_ready()
    }

    #[must_use]
    pub fn store(&self) -> &Store {
        &self.store
    }

    /// Runs read-only use-cases.
    pub fn read<T>(
        &self,
        work: impl FnOnce(&Unit<'_>) -> Result<T, AppError>,
    ) -> Result<T, AppError> {
        self.store.read(|connection| {
            work(&Unit {
                connection,
                clock: self.clock.as_ref(),
                ids: self.ids.as_ref(),
            })
        })
    }

    /// Runs a mutation exactly once per `Idempotency-Key`.
    ///
    /// The key lookup, the mutation and the stored response share one
    /// transaction, so after a crash either all of them exist or none: a
    /// retried request can never apply twice, and a stored response always
    /// has its effect.
    ///
    /// * Same key and same request: the stored response is returned
    ///   (`replayed`), `operation` is not called.
    /// * Same key, different request: `idempotency_mismatch`.
    /// * `operation` fails and `storable(&error)` returns a response (the
    ///   409/422 domain results of 08 §1): the mutation's writes are undone,
    ///   the response is stored for replay, and the error is returned.
    /// * Any other failure: nothing is stored and the key can be retried.
    pub fn mutate_idempotent(
        &self,
        request: IdempotentRequest<'_>,
        storable: impl FnOnce(&AppError) -> Option<StoredResponse>,
        operation: impl FnOnce(&Unit<'_>) -> Result<StoredResponse, AppError>,
    ) -> Result<Idempotent, AppError> {
        self.store.write(|transaction| -> Result<_, AppError> {
            let now = self.clock.now();
            match idempotency::find(transaction, request.key, now)? {
                Some(Record::Completed {
                    request_hash,
                    response,
                }) => {
                    return if request_hash == request.request_hash {
                        Ok(Ok(Idempotent {
                            response,
                            replayed: true,
                        }))
                    } else {
                        Err(DomainError::IdempotencyMismatch.into())
                    };
                }
                Some(Record::Pending { request_hash }) => {
                    return if request_hash == request.request_hash {
                        Err(AppError::IdempotencyInProgress)
                    } else {
                        Err(DomainError::IdempotencyMismatch.into())
                    };
                }
                None => {}
            }

            let reservation = Reservation {
                key: request.key,
                route: request.route,
                request_hash: request.request_hash,
                now,
                expires_at: expiry(now),
            };
            let result = ohmydate_store::savepoint(transaction, |inner| {
                operation(&Unit {
                    connection: inner,
                    clock: self.clock.as_ref(),
                    ids: self.ids.as_ref(),
                })
            })?;
            match result {
                Ok(response) => {
                    idempotency::insert_completed(transaction, reservation, &response)?;
                    Ok(Ok(Idempotent {
                        response,
                        replayed: false,
                    }))
                }
                Err(error) => match storable(&error) {
                    Some(response) => {
                        idempotency::insert_completed(transaction, reservation, &response)?;
                        // Commit the stored failure, then report the error.
                        Ok(Err(error))
                    }
                    None => Err(error),
                },
            }
        })?
    }
}

fn expiry(now: Instant) -> Instant {
    now.checked_add_ms(IDEMPOTENCY_TTL_MS)
        .unwrap_or(Instant::MAX)
}

#[cfg(test)]
mod tests {
    use ohmydate_domain::ProblemCode;

    use super::*;
    use crate::testing::{TestApp, id};
    use crate::{PageQuery, projects as project_cases, settings};

    const KEY: &str = "0193a8f2-6c1e-7b41-9a2e-1f1d6a0b3c01";
    const HASH_A: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const HASH_B: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

    fn request(hash: &'static str) -> IdempotentRequest<'static> {
        IdempotentRequest {
            key: KEY,
            route: "/projects",
            request_hash: hash,
        }
    }

    fn created(body: &str) -> StoredResponse {
        StoredResponse {
            status: 201,
            headers: Vec::new(),
            body: Some(body.to_owned()),
        }
    }

    fn never_storable(_: &AppError) -> Option<StoredResponse> {
        None
    }

    fn create_project(
        test: &TestApp,
        hash: &'static str,
        title: &str,
    ) -> Result<Idempotent, AppError> {
        test.app
            .mutate_idempotent(request(hash), never_storable, |unit| {
                let project = project_cases::create(unit, title)?;
                Ok(created(project.id.as_str()))
            })
    }

    fn project_count(test: &TestApp) -> usize {
        test.app
            .read(|unit| project_cases::list(unit, &PageQuery::default()))
            .unwrap()
            .items
            .len()
    }

    #[test]
    fn a_new_data_file_gets_one_owner_and_an_inbox() {
        let test = TestApp::new();
        let owner = test.app.read(settings::owner).unwrap();
        assert_eq!(&owner.id, test.app.owner_id());
        assert_eq!(owner.time_zone, "Asia/Seoul");
        assert_eq!(owner.version, Version::INITIAL);
        assert!(owner.llm.is_empty());
        let page = test
            .app
            .read(|unit| project_cases::list(unit, &PageQuery::default()))
            .unwrap();
        assert_eq!(page.items.len(), 1);
        assert_eq!(page.items[0].kind, ProjectKind::Inbox);
        assert!(test.app.is_ready());
    }

    #[test]
    fn reopening_keeps_the_owner_and_ignores_new_defaults() {
        let test = TestApp::new();
        let first = test.app.read(settings::owner).unwrap();
        let reopened = test.reopen(&OwnerDefaults {
            email: "someone-else@example.com".into(),
            time_zone: "UTC".into(),
            locale: "en".into(),
        });
        assert_eq!(reopened.app.read(settings::owner).unwrap(), first);
        assert_eq!(reopened.app.owner_id(), &first.id);
        assert_eq!(
            project_count(&reopened),
            1,
            "the inbox must not be created twice"
        );
    }

    #[test]
    fn the_same_key_and_request_runs_once_and_replays() {
        let test = TestApp::new();
        let first = create_project(&test, HASH_A, "Thesis").unwrap();
        assert!(!first.replayed);
        let second = create_project(&test, HASH_A, "Thesis").unwrap();
        assert!(second.replayed);
        assert_eq!(second.response, first.response);
        assert_eq!(project_count(&test), 2, "inbox + one project");
    }

    #[test]
    fn the_same_key_with_a_different_request_is_a_mismatch() {
        let test = TestApp::new();
        create_project(&test, HASH_A, "Thesis").unwrap();
        let error = create_project(&test, HASH_B, "Other").unwrap_err();
        assert!(
            matches!(error, AppError::Domain(DomainError::IdempotencyMismatch)),
            "{error:?}"
        );
        assert_eq!(project_count(&test), 2);
    }

    #[test]
    fn an_unstorable_failure_leaves_nothing_and_the_key_can_be_retried() {
        let test = TestApp::new();
        let failed = test
            .app
            .mutate_idempotent(request(HASH_A), never_storable, |unit| {
                project_cases::create(unit, "Half done")?;
                Err(DomainError::not_found("task", &id(9)).into())
            });
        assert!(matches!(
            failed,
            Err(AppError::Domain(DomainError::NotFound { .. }))
        ));
        assert_eq!(
            project_count(&test),
            1,
            "the project insert must be rolled back"
        );

        let retried = create_project(&test, HASH_A, "Thesis").unwrap();
        assert!(!retried.replayed);
    }

    #[test]
    fn a_storable_failure_is_recorded_without_its_writes_and_replayed() {
        let test = TestApp::new();
        let problem = StoredResponse {
            status: 422,
            headers: vec![("Content-Type".into(), "application/problem+json".into())],
            body: Some("{\"code\":\"validation_failed\"}".into()),
        };
        let storable = |error: &AppError| match error {
            AppError::Domain(error) if error.code() == ProblemCode::ValidationFailed => {
                Some(problem.clone())
            }
            _ => None,
        };
        let failed = test
            .app
            .mutate_idempotent(request(HASH_A), storable, |unit| {
                project_cases::create(unit, "Half done")?;
                Err(DomainError::invalid("title", "nope").into())
            });
        assert!(matches!(
            failed,
            Err(AppError::Domain(DomainError::ValidationFailed(_)))
        ));
        assert_eq!(
            project_count(&test),
            1,
            "the failed mutation must not leave writes"
        );

        let replay = create_project(&test, HASH_A, "Thesis").unwrap();
        assert!(replay.replayed);
        assert_eq!(replay.response, problem);
        assert_eq!(
            project_count(&test),
            1,
            "a replay must not execute the operation"
        );
    }

    #[test]
    fn records_expire_after_a_day() {
        let test = TestApp::new();
        create_project(&test, HASH_A, "Thesis").unwrap();
        test.clock.advance_ms(IDEMPOTENCY_TTL_MS - 1);
        assert!(create_project(&test, HASH_A, "Thesis").unwrap().replayed);
        test.clock.advance_ms(1);
        let after_expiry = create_project(&test, HASH_B, "Second").unwrap();
        assert!(
            !after_expiry.replayed,
            "an expired key is free for any request"
        );
        assert_eq!(project_count(&test), 3);
    }

    #[test]
    fn a_pending_key_answers_in_progress_until_it_is_released() {
        let test = TestApp::new();
        let now = test.clock.now();
        let reservation = Reservation {
            key: KEY,
            route: "/tasks:parse",
            request_hash: HASH_A,
            now,
            expires_at: expiry(now),
        };
        test.app
            .store()
            .write(|transaction| idempotency::insert_pending(transaction, reservation))
            .unwrap();
        assert!(matches!(
            create_project(&test, HASH_A, "Thesis"),
            Err(AppError::IdempotencyInProgress)
        ));
        assert!(matches!(
            create_project(&test, HASH_B, "Thesis"),
            Err(AppError::Domain(DomainError::IdempotencyMismatch))
        ));
        test.app
            .store()
            .write(|transaction| idempotency::release(transaction, KEY))
            .unwrap();
        assert!(!create_project(&test, HASH_A, "Thesis").unwrap().replayed);
    }
}
