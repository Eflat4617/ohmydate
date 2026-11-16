//! The HTTP contract, read from `packages/contracts/openapi.json`.
//!
//! The OpenAPI document generated from the TypeBox schemas is the single
//! source of the API (ADR-005). It is embedded at build time and drives:
//!
//! * the route table (method, path template, operation id);
//! * the header rules (which operations need `If-Match` / `Idempotency-Key`);
//! * request validation (path parameters, query, body) with the contract's
//!   own JSON schemas.
//!
//! A handler is therefore only a function registered under an operation id;
//! it never re-states paths, headers or shapes.

use std::collections::BTreeMap;
use std::sync::OnceLock;

use jsonschema::{Draft, Validator};
use serde_json::{Map, Value, json};

use crate::problem::FieldError;

/// The committed contract, embedded so the binary needs no files at run time.
const OPENAPI_JSON: &str = include_str!("../../../../packages/contracts/openapi.json");

/// Path prefix of every contract route (08 §1).
pub const API_PREFIX: &str = "/api/v1";

/// Which `If-Match` tag an operation requires (08 §1 header table).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum IfMatchRule {
    /// No `If-Match` (reads and creations).
    None,
    /// `W/"<version>"` of the entity being changed.
    Version,
    /// `W/"availability:<n>"`, the owner-wide availability version.
    Availability,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum Segment {
    Literal(String),
    /// `{name}` or `{name}:action`.
    Param {
        name: String,
        action: Option<String>,
    },
}

/// A contract path such as `/tasks/{id}:complete`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PathTemplate {
    segments: Vec<Segment>,
}

impl PathTemplate {
    fn parse(template: &str) -> Self {
        let segments = template
            .split('/')
            .filter(|segment| !segment.is_empty())
            .map(|segment| {
                match segment
                    .strip_prefix('{')
                    .and_then(|rest| rest.split_once('}'))
                {
                    Some((name, "")) => Segment::Param {
                        name: name.to_owned(),
                        action: None,
                    },
                    Some((name, action)) => Segment::Param {
                        name: name.to_owned(),
                        action: Some(action.trim_start_matches(':').to_owned()),
                    },
                    None => Segment::Literal(segment.to_owned()),
                }
            })
            .collect();
        Self { segments }
    }

    /// Path parameters when `path` (without the API prefix) fits the template.
    fn capture(&self, path: &str) -> Option<BTreeMap<String, String>> {
        let parts: Vec<&str> = path.split('/').filter(|part| !part.is_empty()).collect();
        if parts.len() != self.segments.len() {
            return None;
        }
        let mut params = BTreeMap::new();
        for (segment, part) in self.segments.iter().zip(parts) {
            match segment {
                Segment::Literal(literal) => {
                    if literal != part {
                        return None;
                    }
                }
                Segment::Param { name, action: None } => {
                    params.insert(name.clone(), percent_decode(part));
                }
                Segment::Param {
                    name,
                    action: Some(action),
                } => {
                    let (value, found) = part.rsplit_once(':')?;
                    if found != action || value.is_empty() || value.contains(':') {
                        return None;
                    }
                    params.insert(name.clone(), percent_decode(value));
                }
            }
        }
        Some(params)
    }

    /// Higher is more specific: literals and action suffixes beat bare
    /// parameters when two templates fit the same path.
    fn specificity(&self) -> usize {
        self.segments
            .iter()
            .map(|segment| match segment {
                Segment::Literal(_) => 2,
                Segment::Param {
                    action: Some(_), ..
                } => 1,
                Segment::Param { action: None, .. } => 0,
            })
            .sum()
    }
}

struct Validators {
    params: Option<Validator>,
    query: Option<Validator>,
    body: Option<Validator>,
}

/// One operation of the contract.
pub struct Operation {
    pub id: String,
    /// Upper-case HTTP method.
    pub method: String,
    /// Path template as written in the contract, e.g. `/tasks/{id}`.
    pub path: String,
    template: PathTemplate,
    pub if_match: IfMatchRule,
    pub idempotency_key: bool,
    /// Status codes the contract declares for this operation.
    pub declared_statuses: Vec<u16>,
    /// Query parameters declared as integers: their text is converted
    /// before validation, as the TypeScript core does for `limit`.
    integer_query_params: Vec<String>,
    params_schema: Option<Value>,
    query_schema: Option<Value>,
    body_schema: Option<Value>,
    validators: OnceLock<Validators>,
}

impl std::fmt::Debug for Operation {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("Operation")
            .field("id", &self.id)
            .field("method", &self.method)
            .field("path", &self.path)
            .finish_non_exhaustive()
    }
}

impl Operation {
    #[must_use]
    pub fn has_body_schema(&self) -> bool {
        self.body_schema.is_some()
    }

    fn validators(&self) -> &Validators {
        self.validators.get_or_init(|| Validators {
            params: self.params_schema.as_ref().and_then(compile),
            query: self.query_schema.as_ref().and_then(compile),
            body: self.body_schema.as_ref().and_then(compile),
        })
    }

    /// Checks path parameters against the contract.
    pub fn validate_params(&self, params: &BTreeMap<String, String>) -> Vec<FieldError> {
        let instance = Value::Object(
            params
                .iter()
                .map(|(name, value)| (name.clone(), Value::String(value.clone())))
                .collect(),
        );
        errors(self.validators().params.as_ref(), &instance)
    }

    /// Parses and checks a raw query string. For an operation that declares
    /// query parameters, unknown ones are rejected (the contract's query
    /// objects allow no additional properties); other operations ignore it.
    pub fn validate_query(&self, raw: Option<&str>) -> Result<Map<String, Value>, Vec<FieldError>> {
        let mut query = Map::new();
        for (name, value) in parse_query(raw.unwrap_or("")) {
            let value = if self.integer_query_params.contains(&name) && is_integer_text(&value) {
                value
                    .parse::<i64>()
                    .map_or(Value::String(value), Value::from)
            } else {
                Value::String(value)
            };
            // A repeated parameter becomes an array, which no contract
            // parameter accepts.
            match query.remove(&name) {
                None => query.insert(name, value),
                Some(Value::Array(mut values)) => {
                    values.push(value);
                    query.insert(name, Value::Array(values))
                }
                Some(first) => query.insert(name, Value::Array(vec![first, value])),
            };
        }
        let instance = Value::Object(query);
        let found = errors(self.validators().query.as_ref(), &instance);
        match (found.is_empty(), instance) {
            (true, Value::Object(query)) => Ok(query),
            _ => Err(found),
        }
    }

    /// Checks a request body against the contract. A missing body is checked
    /// as `null`, so operations with a body schema reject it.
    pub fn validate_body(&self, body: Option<&Value>) -> Vec<FieldError> {
        errors(
            self.validators().body.as_ref(),
            body.unwrap_or(&Value::Null),
        )
    }
}

fn compile(schema: &Value) -> Option<Validator> {
    jsonschema::options()
        .with_draft(Draft::Draft202012)
        .should_validate_formats(true)
        .with_format("iana-time-zone", is_iana_time_zone)
        .build(schema)
        .ok()
}

/// The contract's custom `iana-time-zone` format: a name of the bundled tz
/// database, spelled exactly as the database spells it.
///
/// The reference accepts the names its JavaScript runtime lists
/// (`Intl.supportedValuesOf('timeZone')`, plus `UTC` and `Etc/UTC`), compared
/// as written. The core keeps "compared as written" — `asia/seoul` is not a
/// zone name, and a stored name must be one every client can echo — and
/// takes the list from the tz database instead of from one runtime's ICU, so
/// link names such as `Asia/Calcutta` are zones here (blueprint 15 §2.3 ⑧).
#[must_use]
pub fn is_iana_time_zone(name: &str) -> bool {
    // The lookup itself ignores case; the zone it finds knows its spelling.
    jiff::tz::TimeZone::get(name).is_ok_and(|zone| zone.iana_name() == Some(name))
}

fn errors(validator: Option<&Validator>, instance: &Value) -> Vec<FieldError> {
    let Some(validator) = validator else {
        return Vec::new();
    };
    validator
        .iter_errors(instance)
        .map(|error| {
            let pointer = error.instance_path().to_string();
            FieldError {
                path: if pointer.is_empty() {
                    "/".to_owned()
                } else {
                    pointer
                },
                // Masked: the message names the rule, never the offending
                // value, so user text cannot leak into responses or logs.
                message: error.masked().to_string(),
            }
        })
        .collect()
}

fn is_integer_text(text: &str) -> bool {
    let digits = text.strip_prefix('-').unwrap_or(text);
    !digits.is_empty() && digits.bytes().all(|byte| byte.is_ascii_digit())
}

fn hex_value(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}

fn percent_decode_bytes(text: &str, plus_is_space: bool) -> String {
    let bytes = text.as_bytes();
    let mut output = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        let decoded = match bytes[index] {
            b'%' => match (
                bytes.get(index + 1).copied().and_then(hex_value),
                bytes.get(index + 2).copied().and_then(hex_value),
            ) {
                (Some(high), Some(low)) => {
                    index += 2;
                    high * 16 + low
                }
                _ => b'%',
            },
            b'+' if plus_is_space => b' ',
            other => other,
        };
        output.push(decoded);
        index += 1;
    }
    String::from_utf8_lossy(&output).into_owned()
}

fn percent_decode(text: &str) -> String {
    percent_decode_bytes(text, false)
}

fn parse_query(raw: &str) -> Vec<(String, String)> {
    raw.split('&')
        .filter(|pair| !pair.is_empty())
        .map(|pair| {
            let (name, value) = pair.split_once('=').unwrap_or((pair, ""));
            (
                percent_decode_bytes(name, true),
                percent_decode_bytes(value, true),
            )
        })
        .collect()
}

/// The parsed contract.
#[derive(Debug)]
pub struct Contract {
    operations: Vec<Operation>,
    problem_codes: Vec<String>,
}

impl Contract {
    /// The contract embedded in this build.
    ///
    /// # Panics
    /// When the embedded document is not the shape `generate-openapi.ts`
    /// writes. That is a build defect, caught by this crate's tests.
    #[must_use]
    pub fn embedded() -> &'static Contract {
        static CONTRACT: OnceLock<Contract> = OnceLock::new();
        CONTRACT.get_or_init(|| {
            Contract::parse(OPENAPI_JSON)
                .unwrap_or_else(|reason| panic!("embedded openapi.json is unusable: {reason}"))
        })
    }

    fn parse(text: &str) -> Result<Self, String> {
        let document: Value = serde_json::from_str(text).map_err(|error| error.to_string())?;
        let schemas = document
            .pointer("/components/schemas")
            .and_then(Value::as_object)
            .ok_or("components.schemas is missing")?;
        let resolve = |schema: &Value| -> Result<Value, String> {
            match schema.get("$ref").and_then(Value::as_str) {
                None => Ok(schema.clone()),
                Some(reference) => reference
                    .strip_prefix("#/components/schemas/")
                    .and_then(|name| schemas.get(name))
                    .cloned()
                    .ok_or_else(|| format!("unresolved reference {reference}")),
            }
        };

        let paths = document
            .get("paths")
            .and_then(Value::as_object)
            .ok_or("paths is missing")?;
        let mut operations = Vec::new();
        for (path, methods) in paths {
            let methods = methods.as_object().ok_or("a path item is not an object")?;
            for (method, operation) in methods {
                let id = operation
                    .get("operationId")
                    .and_then(Value::as_str)
                    .ok_or_else(|| format!("{method} {path} has no operationId"))?;
                operations.push(parse_operation(id, method, path, operation, &resolve)?);
            }
        }

        let problem_codes = schemas
            .get("Problem")
            .and_then(|problem| problem.pointer("/properties/code/anyOf"))
            .and_then(Value::as_array)
            .ok_or("Problem.code is missing")?
            .iter()
            .filter_map(|entry| {
                entry
                    .get("const")
                    .and_then(Value::as_str)
                    .map(str::to_owned)
            })
            .collect();
        Ok(Self {
            operations,
            problem_codes,
        })
    }

    #[must_use]
    pub fn operations(&self) -> &[Operation] {
        &self.operations
    }

    /// The contract's closed list of problem codes.
    #[must_use]
    pub fn problem_codes(&self) -> &[String] {
        &self.problem_codes
    }

    #[must_use]
    pub fn operation(&self, id: &str) -> Option<&Operation> {
        self.operations.iter().find(|operation| operation.id == id)
    }

    /// The operation serving `method` on `path` (below the API prefix), with
    /// its path parameters.
    #[must_use]
    pub fn route(
        &self,
        method: &str,
        path: &str,
    ) -> Option<(&Operation, BTreeMap<String, String>)> {
        self.operations
            .iter()
            .filter(|operation| operation.method == method)
            .filter_map(|operation| {
                operation
                    .template
                    .capture(path)
                    .map(|params| (operation, params))
            })
            .max_by_key(|(operation, _)| operation.template.specificity())
    }
}

fn parse_operation(
    id: &str,
    method: &str,
    path: &str,
    operation: &Value,
    resolve: &dyn Fn(&Value) -> Result<Value, String>,
) -> Result<Operation, String> {
    let mut path_properties = Map::new();
    let mut query_properties = Map::new();
    let mut path_required = Vec::new();
    let mut query_required = Vec::new();
    let mut integer_query_params = Vec::new();
    let mut if_match = IfMatchRule::None;
    let mut idempotency_key = false;

    let parameters = operation.get("parameters").and_then(Value::as_array);
    for parameter in parameters.into_iter().flatten() {
        let name = parameter
            .get("name")
            .and_then(Value::as_str)
            .ok_or("parameter without name")?;
        let location = parameter.get("in").and_then(Value::as_str).unwrap_or("");
        let required = parameter
            .get("required")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let schema = resolve(parameter.get("schema").unwrap_or(&Value::Null))?;
        match location {
            "path" => {
                path_properties.insert(name.to_owned(), schema);
                path_required.push(Value::from(name));
            }
            "query" => {
                if schema.get("type").and_then(Value::as_str) == Some("integer") {
                    integer_query_params.push(name.to_owned());
                }
                query_properties.insert(name.to_owned(), schema);
                if required {
                    query_required.push(Value::from(name));
                }
            }
            "header" if required && name == "If-Match" => {
                let pattern = schema.get("pattern").and_then(Value::as_str).unwrap_or("");
                if_match = if pattern.contains("availability:") {
                    IfMatchRule::Availability
                } else {
                    IfMatchRule::Version
                };
            }
            "header" if required && name == "Idempotency-Key" => idempotency_key = true,
            _ => {}
        }
    }

    let object_schema = |properties: Map<String, Value>, required: Vec<Value>| {
        json!({
            "type": "object",
            "properties": properties,
            "required": required,
            "additionalProperties": false,
        })
    };
    let body_schema = operation
        .pointer("/requestBody/content/application~1json/schema")
        .map(resolve)
        .transpose()?;
    let declared_statuses = operation
        .get("responses")
        .and_then(Value::as_object)
        .map(|responses| {
            responses
                .keys()
                .filter_map(|status| status.parse().ok())
                .collect()
        })
        .unwrap_or_default();

    Ok(Operation {
        id: id.to_owned(),
        method: method.to_ascii_uppercase(),
        path: path.to_owned(),
        template: PathTemplate::parse(path),
        if_match,
        idempotency_key,
        declared_statuses,
        integer_query_params,
        params_schema: (!path_properties.is_empty())
            .then(|| object_schema(path_properties, path_required)),
        // As in the TypeScript core: an operation that declares query
        // parameters accepts exactly those; one that declares none does not
        // look at the query string at all.
        query_schema: (!query_properties.is_empty())
            .then(|| object_schema(query_properties, query_required)),
        body_schema,
        validators: OnceLock::new(),
    })
}

#[cfg(test)]
mod tests {
    use ohmydate_domain::ProblemCode;

    use super::*;

    const TASK_ID: &str = "0193a8f2-6c1e-7b41-9a2e-1f1d6a0b3c55";

    fn route(method: &str, path: &str) -> Option<(String, BTreeMap<String, String>)> {
        Contract::embedded()
            .route(method, path)
            .map(|(operation, params)| (operation.id.clone(), params))
    }

    #[test]
    fn the_embedded_contract_has_the_expected_shape() {
        let contract = Contract::embedded();
        assert_eq!(contract.operations().len(), 85);
        let mut ids: Vec<&str> = contract
            .operations()
            .iter()
            .map(|op| op.id.as_str())
            .collect();
        ids.sort_unstable();
        ids.dedup();
        assert_eq!(ids.len(), 85, "operation ids are unique");
    }

    #[test]
    fn the_domain_problem_codes_are_exactly_the_contract_codes() {
        let domain: Vec<&str> = ProblemCode::ALL.iter().map(|code| code.as_str()).collect();
        assert_eq!(Contract::embedded().problem_codes(), domain);
    }

    #[test]
    fn paths_resolve_to_operations_with_their_parameters() {
        let with_id = BTreeMap::from([("id".to_owned(), TASK_ID.to_owned())]);
        assert_eq!(
            route("GET", "/tasks"),
            Some(("listTasks".into(), BTreeMap::new()))
        );
        assert_eq!(
            route("POST", "/tasks"),
            Some(("createTask".into(), BTreeMap::new()))
        );
        assert_eq!(
            route("GET", &format!("/tasks/{TASK_ID}")),
            Some(("getTask".into(), with_id.clone()))
        );
        assert_eq!(
            route("POST", &format!("/tasks/{TASK_ID}:complete")),
            Some(("completeTask".into(), with_id.clone()))
        );
        assert_eq!(
            route("POST", &format!("/tasks/{TASK_ID}/dependencies")),
            Some(("createTaskDependency".into(), with_id.clone()))
        );
        assert_eq!(
            route("PATCH", &format!("/projects/{TASK_ID}")),
            Some(("updateProject".into(), with_id))
        );
        assert_eq!(
            route("POST", "/tasks:parse"),
            Some(("parseTasks".into(), BTreeMap::new()))
        );
        assert_eq!(
            route("POST", "/plans/a/candidates/b:approve").map(|(id, params)| (id, params.len())),
            Some(("approvePlanCandidate".into(), 2))
        );
    }

    #[test]
    fn unknown_methods_actions_and_paths_do_not_resolve() {
        assert_eq!(route("PUT", "/tasks"), None);
        assert_eq!(route("POST", &format!("/tasks/{TASK_ID}")), None);
        assert_eq!(route("POST", &format!("/tasks/{TASK_ID}:explode")), None);
        assert_eq!(route("POST", "/tasks/:complete"), None);
        // A project is renamed and archived, never read alone or deleted.
        assert_eq!(route("GET", &format!("/projects/{TASK_ID}")), None);
        assert_eq!(route("DELETE", &format!("/projects/{TASK_ID}")), None);
        assert_eq!(route("PUT", &format!("/projects/{TASK_ID}")), None);
        assert_eq!(route("GET", "/does-not-exist"), None);
        assert_eq!(route("GET", "/tasks/a/b/c"), None);
    }

    #[test]
    fn every_contract_path_resolves_to_its_own_operation() {
        for operation in Contract::embedded().operations() {
            let concrete = operation
                .path
                .replace("{id}", TASK_ID)
                .replace("{cid}", TASK_ID)
                .replace("{linkId}", TASK_ID);
            let found = route(&operation.method, &concrete).map(|(id, _)| id);
            assert_eq!(
                found.as_deref(),
                Some(operation.id.as_str()),
                "{} {}",
                operation.method,
                operation.path
            );
        }
    }

    #[test]
    fn header_rules_follow_the_contract_table() {
        let contract = Contract::embedded();
        let rule = |id: &str| {
            let operation = contract.operation(id).unwrap();
            (operation.if_match, operation.idempotency_key)
        };
        assert_eq!(rule("getTask"), (IfMatchRule::None, false));
        assert_eq!(rule("createTask"), (IfMatchRule::None, true));
        assert_eq!(rule("updateTask"), (IfMatchRule::Version, true));
        assert_eq!(rule("updateProject"), (IfMatchRule::Version, true));
        assert_eq!(rule("createProject"), (IfMatchRule::None, true));
        assert_eq!(rule("deleteTask"), (IfMatchRule::Version, true));
        assert_eq!(rule("createTaskDependency"), (IfMatchRule::Version, true));
        assert_eq!(rule("putAvailability"), (IfMatchRule::Availability, true));
        assert_eq!(
            rule("approvePlanCandidate"),
            (IfMatchRule::Availability, true)
        );
        assert_eq!(rule("login"), (IfMatchRule::None, false));
        assert!(contract.operation("noSuchOperation").is_none());
    }

    #[test]
    fn bodies_are_checked_with_the_contract_schema() {
        let operation = Contract::embedded().operation("createTask").unwrap();
        assert!(
            operation
                .validate_body(Some(&json!({"title": "Read papers"})))
                .is_empty()
        );

        let unexpected =
            operation.validate_body(Some(&json!({"title": "x", "unexpectedField": true})));
        assert_eq!(unexpected.len(), 1);
        let missing = operation.validate_body(Some(&json!({})));
        assert_eq!(missing[0].path, "/");
        let wrong_type = operation.validate_body(Some(&json!({"title": 7})));
        assert_eq!(wrong_type[0].path, "/title");
        let bad_date = operation.validate_body(Some(&json!({"title": "x", "dueAt": "tomorrow"})));
        assert_eq!(bad_date[0].path, "/dueAt");
        assert!(
            !operation.validate_body(None).is_empty(),
            "a required body must be present"
        );
    }

    #[test]
    fn validation_messages_never_repeat_the_rejected_value() {
        let operation = Contract::embedded().operation("createTask").unwrap();
        let secret = "PRIVATE-TITLE-".repeat(20);
        let found = operation.validate_body(Some(
            &json!({"title": secret, "priority": "PRIVATE-PRIORITY"}),
        ));
        assert_eq!(found.len(), 2);
        for error in found {
            assert!(!error.message.contains("PRIVATE"), "{}", error.message);
        }
    }

    #[test]
    fn queries_are_typed_bounded_and_closed() {
        let operation = Contract::embedded().operation("listTasks").unwrap();
        let query = operation
            .validate_query(Some("limit=10&status=done"))
            .unwrap();
        assert_eq!(query.get("limit"), Some(&json!(10)));
        assert_eq!(query.get("status"), Some(&json!("done")));
        assert!(operation.validate_query(None).unwrap().is_empty());

        for raw in [
            "limit=0",
            "limit=101",
            "limit=ten",
            "status=archived",
            "unknown=1",
            "limit=1&limit=2",
            "projectId=nope",
        ] {
            assert!(operation.validate_query(Some(raw)).is_err(), "{raw}");
        }

        // getTask declares no query parameters, so its query is not checked.
        let undeclared = Contract::embedded().operation("getTask").unwrap();
        assert!(undeclared.validate_query(Some("download=1&x=y")).is_ok());
    }

    #[test]
    fn path_parameters_must_be_uuid_v7() {
        let operation = Contract::embedded().operation("getTask").unwrap();
        let params = |id: &str| BTreeMap::from([("id".to_owned(), id.to_owned())]);
        assert!(operation.validate_params(&params(TASK_ID)).is_empty());
        let found = operation.validate_params(&params("0193a8f2-6c1e-4b41-9a2e-1f1d6a0b3c55"));
        assert_eq!(found[0].path, "/id");
        assert!(!operation.validate_params(&params("abc")).is_empty());
    }

    #[test]
    fn the_time_zone_format_knows_iana_names_only() {
        for name in [
            "Asia/Seoul",
            "UTC",
            "Etc/UTC",
            "America/Argentina/Buenos_Aires",
            "America/Port-au-Prince",
            // A link name: a zone of the database, though not of every ICU.
            "Asia/Calcutta",
        ] {
            assert!(is_iana_time_zone(name), "{name}");
        }
        for name in [
            "Mars/Olympus",
            "",
            " ",
            "Asia/Seoul ",
            " Asia/Seoul",
            "Asia/Seoul\n",
            "Asia",
            "Asia/",
            "+09:00",
            "UTC+9",
            "../etc/passwd",
            "Asia/Seoul/../Tokyo",
        ] {
            assert!(!is_iana_time_zone(name), "{name:?}");
        }
    }

    #[test]
    fn a_time_zone_name_is_compared_as_written() {
        for name in [
            "asia/seoul",
            "ASIA/SEOUL",
            "Asia/seoul",
            "utc",
            "Utc",
            "etc/utc",
        ] {
            assert!(!is_iana_time_zone(name), "{name}");
        }
        let operation = Contract::embedded().operation("updateMySettings").unwrap();
        assert!(
            operation
                .validate_body(Some(&json!({"timeZone": "Europe/Berlin"})))
                .is_empty()
        );
        let found = operation.validate_body(Some(&json!({"timeZone": "europe/berlin"})));
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].path, "/timeZone");
    }

    #[test]
    fn query_text_is_percent_decoded() {
        assert_eq!(
            parse_query("q=%EB%85%BC%EB%AC%B8+a&cursor=a%3Db&flag"),
            vec![
                ("q".to_owned(), "논문 a".to_owned()),
                ("cursor".to_owned(), "a=b".to_owned()),
                ("flag".to_owned(), String::new()),
            ]
        );
        assert_eq!(percent_decode("100%"), "100%");
    }
}
