//! Wire shapes of the contract (`packages/contracts`): domain entity → JSON.
//!
//! Optional fields are omitted when absent, never sent as `null`, exactly as
//! the TypeScript core's `toTaskDto` / `toProjectDto` / `toUserDto` do.

use ohmydate_app::Page;
use ohmydate_domain::{Id, MicroUsd, Owner, Project, Task};
use serde_json::{Map, Value, json};

/// `Task` of the contract. `external` is always empty: it listed Vikunja
/// references, and the desktop core has no external task provider.
#[must_use]
pub fn task(task: &Task, owner_id: &Id) -> Value {
    let mut body = Map::new();
    body.insert("id".into(), json!(task.id.as_str()));
    body.insert("ownerId".into(), json!(owner_id.as_str()));
    body.insert("projectId".into(), json!(task.project_id.as_str()));
    body.insert("title".into(), json!(task.title));
    if let Some(description) = &task.description {
        body.insert("description".into(), json!(description));
    }
    body.insert("status".into(), json!(task.status.as_str()));
    if let Some(due_at) = task.due_at {
        body.insert("dueAt".into(), json!(due_at.to_rfc3339()));
    }
    body.insert("splittable".into(), json!(task.splittable));
    if let Some(session) = task.session {
        body.insert(
            "session".into(),
            json!({"minMinutes": session.min_minutes, "maxMinutes": session.max_minutes}),
        );
    }
    body.insert("priority".into(), json!(task.priority.get()));
    let depends_on: Vec<&str> = task.depends_on.iter().map(Id::as_str).collect();
    body.insert("dependsOn".into(), json!(depends_on));
    body.insert("version".into(), json!(task.version.get()));
    body.insert("createdAt".into(), json!(task.created_at.to_rfc3339()));
    body.insert("updatedAt".into(), json!(task.updated_at.to_rfc3339()));
    if let Some(deleted_at) = task.deleted_at {
        body.insert("deletedAt".into(), json!(deleted_at.to_rfc3339()));
    }
    body.insert("external".into(), json!([]));
    Value::Object(body)
}

/// `Project` of the contract.
#[must_use]
pub fn project(project: &Project, owner_id: &Id) -> Value {
    json!({
        "id": project.id.as_str(),
        "ownerId": owner_id.as_str(),
        "title": project.title,
        "kind": project.kind.as_str(),
        "archived": project.archived,
        "version": project.version.get(),
        "createdAt": project.created_at.to_rfc3339(),
        "updatedAt": project.updated_at.to_rfc3339(),
    })
}

/// A dollar amount as a JSON number: whole dollars print without a fraction
/// (`20`, not `20.0`), as JavaScript prints them.
fn usd(amount: MicroUsd) -> Value {
    amount
        .whole_usd()
        .map_or_else(|| json!(amount.usd()), |whole| json!(whole))
}

/// `User` of the contract, for the single local owner.
///
/// `llm` is what the owner decided (absent until they decide something).
/// `llmProvider` is absent: it tells the client which AI provider answers,
/// and no provider is wired in before the LLM slice (RC-70). The web reads
/// its absence as "no AI here" and asks for no consent.
#[must_use]
pub fn user(owner: &Owner) -> Value {
    let mut body = Map::new();
    body.insert("id".into(), json!(owner.id.as_str()));
    body.insert("email".into(), json!(owner.email));
    body.insert("timeZone".into(), json!(owner.time_zone));
    body.insert("locale".into(), json!(owner.locale));
    if !owner.llm.is_empty() {
        let mut llm = Map::new();
        if let Some(consent) = &owner.llm.consent {
            llm.insert(
                "consent".into(),
                json!({
                    "granted": consent.granted,
                    "at": consent.at.to_rfc3339(),
                    "provider": consent.provider,
                }),
            );
        }
        if let Some(budget) = owner.llm.budget {
            llm.insert(
                "budget".into(),
                json!({"dailyUsd": usd(budget.daily), "monthlyUsd": usd(budget.monthly)}),
            );
        }
        body.insert("llm".into(), Value::Object(llm));
    }
    body.insert("version".into(), json!(owner.version.get()));
    body.insert("createdAt".into(), json!(owner.created_at.to_rfc3339()));
    body.insert("updatedAt".into(), json!(owner.updated_at.to_rfc3339()));
    Value::Object(body)
}

/// `{items, nextCursor}` (08 §1).
#[must_use]
pub fn page<T>(page: &Page<T>, item: impl Fn(&T) -> Value) -> Value {
    json!({
        "items": page.items.iter().map(item).collect::<Vec<Value>>(),
        "nextCursor": page.next_cursor,
    })
}

#[cfg(test)]
mod tests {
    use ohmydate_domain::{
        Instant, LlmBudget, LlmConsent, LlmSettings, ProjectKind, SessionWindow, TaskPriority,
        TaskStatus, Version,
    };

    use super::*;

    fn id(last: char) -> Id {
        Id::parse(&format!("0193a8f2-6c1e-7b41-9a2e-1f1d6a0b3c5{last}")).unwrap()
    }

    fn at(text: &str) -> Instant {
        Instant::parse_rfc3339(text).unwrap()
    }

    fn minimal_task() -> Task {
        Task {
            id: id('1'),
            project_id: id('2'),
            title: "Read papers".into(),
            description: None,
            status: TaskStatus::Todo,
            due_at: None,
            splittable: false,
            session: None,
            priority: TaskPriority::DEFAULT,
            depends_on: Vec::new(),
            version: Version::INITIAL,
            created_at: at("2026-11-13T12:00:00Z"),
            updated_at: at("2026-11-13T12:00:00Z"),
            deleted_at: None,
        }
    }

    #[test]
    fn a_minimal_task_omits_absent_optional_fields() {
        assert_eq!(
            task(&minimal_task(), &id('0')),
            json!({
                "id": "0193a8f2-6c1e-7b41-9a2e-1f1d6a0b3c51",
                "ownerId": "0193a8f2-6c1e-7b41-9a2e-1f1d6a0b3c50",
                "projectId": "0193a8f2-6c1e-7b41-9a2e-1f1d6a0b3c52",
                "title": "Read papers",
                "status": "todo",
                "splittable": false,
                "priority": 2,
                "dependsOn": [],
                "version": 1,
                "createdAt": "2026-11-13T12:00:00.000Z",
                "updatedAt": "2026-11-13T12:00:00.000Z",
                "external": [],
            })
        );
    }

    #[test]
    fn a_full_task_carries_every_field() {
        let full = Task {
            description: Some("notes".into()),
            status: TaskStatus::InProgress,
            due_at: Some(at("2026-11-20T23:59:00+09:00")),
            session: Some(SessionWindow {
                min_minutes: 30,
                max_minutes: 90,
            }),
            depends_on: vec![id('3')],
            deleted_at: Some(at("2026-11-14T00:00:00Z")),
            ..minimal_task()
        };
        let body = task(&full, &id('0'));
        assert_eq!(body["description"], "notes");
        assert_eq!(body["status"], "in_progress");
        assert_eq!(body["dueAt"], "2026-11-20T14:59:00.000Z");
        assert_eq!(body["session"], json!({"minMinutes": 30, "maxMinutes": 90}));
        assert_eq!(
            body["dependsOn"],
            json!(["0193a8f2-6c1e-7b41-9a2e-1f1d6a0b3c53"])
        );
        assert_eq!(body["deletedAt"], "2026-11-14T00:00:00.000Z");
    }

    #[test]
    fn projects_users_and_pages_have_the_contract_keys() {
        let inbox = Project {
            id: id('2'),
            title: "Inbox".into(),
            kind: ProjectKind::Inbox,
            archived: false,
            version: Version::INITIAL,
            created_at: at("2026-11-13T12:00:00Z"),
            updated_at: at("2026-11-13T12:00:00Z"),
        };
        let body = project(&inbox, &id('0'));
        assert_eq!(body["kind"], "inbox");
        assert_eq!(body.as_object().unwrap().len(), 8);

        let owner = Owner {
            id: id('0'),
            email: "owner@ohmydate.local".into(),
            time_zone: "Asia/Seoul".into(),
            locale: "ko-KR".into(),
            llm: LlmSettings::default(),
            version: Version::INITIAL,
            created_at: at("2026-11-13T12:00:00Z"),
            updated_at: at("2026-11-13T12:00:00Z"),
        };
        assert_eq!(
            user(&owner),
            json!({
                "id": "0193a8f2-6c1e-7b41-9a2e-1f1d6a0b3c50",
                "email": "owner@ohmydate.local",
                "timeZone": "Asia/Seoul",
                "locale": "ko-KR",
                "version": 1,
                "createdAt": "2026-11-13T12:00:00.000Z",
                "updatedAt": "2026-11-13T12:00:00.000Z",
            }),
            "no llm before the owner decides, and no llmProvider before RC-70"
        );

        let decided = Owner {
            llm: LlmSettings {
                consent: Some(LlmConsent {
                    granted: true,
                    at: at("2026-11-16T09:30:00.250Z"),
                    provider: "deepseek".into(),
                }),
                budget: Some(LlmBudget {
                    daily: MicroUsd::from_usd(1.5).unwrap(),
                    monthly: MicroUsd::from_usd(20.0).unwrap(),
                }),
            },
            ..owner.clone()
        };
        let body = user(&decided);
        assert_eq!(
            body["llm"],
            json!({
                "consent": {
                    "granted": true,
                    "at": "2026-11-16T09:30:00.250Z",
                    "provider": "deepseek",
                },
                "budget": {"dailyUsd": 1.5, "monthlyUsd": 20},
            })
        );
        // Whole dollars are written as JavaScript writes them.
        assert!(body.to_string().contains("\"monthlyUsd\":20}"), "{body}");
        assert!(body.get("llmProvider").is_none());

        let budget_only = Owner {
            llm: LlmSettings {
                consent: None,
                budget: decided.llm.budget,
            },
            ..owner.clone()
        };
        assert_eq!(
            user(&budget_only)["llm"],
            json!({"budget": {"dailyUsd": 1.5, "monthlyUsd": 20}})
        );

        let last = Page {
            items: vec![inbox],
            next_cursor: None,
        };
        let listed = page(&last, |item| project(item, &id('0')));
        assert_eq!(listed["nextCursor"], Value::Null);
        assert_eq!(listed["items"].as_array().unwrap().len(), 1);
    }
}
