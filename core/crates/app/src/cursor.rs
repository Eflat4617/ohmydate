//! Cursor pagination (08 §1: `{items, nextCursor}`).
//!
//! A list cursor is the base64url form of `{"c":"<createdAt>","i":"<id>"}` —
//! the position of the last item of the previous page in `(createdAt, id)`
//! order. It is the same encoding as the TypeScript core
//! (`packages/provider-native/src/in-memory/cursor.ts`). Clients must treat it
//! as opaque.

use ohmydate_domain::{DomainError, Id, Instant};
use ohmydate_store::PageAfter;

pub const DEFAULT_PAGE_LIMIT: u32 = 20;
pub const MAX_PAGE_LIMIT: u32 = 100;

/// Paging part of a list request.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct PageQuery {
    pub cursor: Option<String>,
    pub limit: Option<u32>,
}

/// One page of a list. `next_cursor` is `None` on the last page.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Page<T> {
    pub items: Vec<T>,
    pub next_cursor: Option<String>,
}

const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

fn to_base64_url(input: &[u8]) -> String {
    let mut output = String::with_capacity(input.len().div_ceil(3) * 4);
    for chunk in input.chunks(3) {
        let first = chunk[0];
        let second = chunk.get(1).copied();
        let third = chunk.get(2).copied();
        output.push(char::from(ALPHABET[usize::from(first >> 2)]));
        output.push(char::from(
            ALPHABET[usize::from(((first & 0b11) << 4) | (second.unwrap_or(0) >> 4))],
        ));
        if let Some(second) = second {
            output.push(char::from(
                ALPHABET[usize::from(((second & 0b1111) << 2) | (third.unwrap_or(0) >> 6))],
            ));
        }
        if let Some(third) = third {
            output.push(char::from(ALPHABET[usize::from(third & 0b11_1111)]));
        }
    }
    output
}

fn from_base64_url(input: &str) -> Option<Vec<u8>> {
    let mut output = Vec::with_capacity(input.len() * 3 / 4);
    let mut buffer = 0_u32;
    let mut bits = 0_u32;
    for byte in input.bytes() {
        let value = ALPHABET.iter().position(|&letter| letter == byte)?;
        buffer = (buffer << 6) | u32::try_from(value).ok()?;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            output.push(u8::try_from((buffer >> bits) & 0xff).ok()?);
        }
    }
    Some(output)
}

pub(crate) fn encode(position: &PageAfter) -> String {
    let json = serde_json::json!({
        "c": position.created_at.to_rfc3339(),
        "i": position.id.as_str(),
    });
    to_base64_url(json.to_string().as_bytes())
}

pub(crate) fn decode(cursor: &str) -> Result<PageAfter, DomainError> {
    let parsed = from_base64_url(cursor)
        .and_then(|bytes| serde_json::from_slice::<serde_json::Value>(&bytes).ok())
        .and_then(|value| {
            let created_at = Instant::parse_rfc3339(value.get("c")?.as_str()?).ok()?;
            let id = Id::parse(value.get("i")?.as_str()?)?;
            Some(PageAfter { created_at, id })
        });
    parsed.ok_or_else(|| DomainError::invalid("cursor", "invalid list cursor"))
}

/// Resolves the page size and start of a list request.
pub(crate) fn resolve(query: &PageQuery) -> Result<(Option<PageAfter>, u32), DomainError> {
    let limit = query.limit.unwrap_or(DEFAULT_PAGE_LIMIT);
    if !(1..=MAX_PAGE_LIMIT).contains(&limit) {
        return Err(DomainError::invalid(
            "limit",
            &format!("expected an integer between 1 and {MAX_PAGE_LIMIT}"),
        ));
    }
    let after = query.cursor.as_deref().map(decode).transpose()?;
    Ok((after, limit))
}

/// Builds a page from `limit + 1` fetched rows.
pub(crate) fn page<T>(mut rows: Vec<T>, limit: u32, position: impl Fn(&T) -> PageAfter) -> Page<T> {
    let limit = usize::try_from(limit).unwrap_or(usize::MAX);
    let has_more = rows.len() > limit;
    rows.truncate(limit);
    let next_cursor = if has_more {
        rows.last().map(|last| encode(&position(last)))
    } else {
        None
    };
    Page {
        items: rows,
        next_cursor,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn position() -> PageAfter {
        PageAfter {
            created_at: Instant::parse_rfc3339("2026-11-13T12:00:00.000Z").unwrap(),
            id: Id::parse("0193a8f2-6c1e-7b41-9a2e-1f1d6a0b3c55").unwrap(),
        }
    }

    #[test]
    fn cursors_use_the_typescript_encoding() {
        // Buffer.from(JSON.stringify({c, i})).toString('base64url') in Node.
        let expected = "eyJjIjoiMjAyNi0xMS0xM1QxMjowMDowMC4wMDBaIiwiaSI6IjAxOTNhOGYyLTZjMWUtN2I0MS05YTJlLTFmMWQ2YTBiM2M1NSJ9";
        assert_eq!(encode(&position()), expected);
        assert_eq!(decode(expected).unwrap(), position());
    }

    #[test]
    fn every_input_length_round_trips_through_base64url() {
        for length in 0..=9_u8 {
            let bytes: Vec<u8> = (0..length)
                .map(|index| index.wrapping_mul(53).wrapping_add(200))
                .collect();
            assert_eq!(from_base64_url(&to_base64_url(&bytes)).unwrap(), bytes);
        }
    }

    #[test]
    fn malformed_cursors_are_validation_errors() {
        for cursor in [
            "!!!",
            "",
            "eyJ9",
            &to_base64_url(b"{\"c\":\"yesterday\",\"i\":\"0193a8f2-6c1e-7b41-9a2e-1f1d6a0b3c55\"}"),
            &to_base64_url(b"{\"c\":\"2026-11-13T12:00:00.000Z\",\"i\":\"not-an-id\"}"),
            &to_base64_url(b"[1,2]"),
        ] {
            assert_eq!(
                decode(cursor),
                Err(DomainError::invalid("cursor", "invalid list cursor")),
                "{cursor}"
            );
        }
    }

    #[test]
    fn limits_default_to_twenty_and_are_bounded() {
        assert_eq!(resolve(&PageQuery::default()).unwrap(), (None, 20));
        assert_eq!(
            resolve(&PageQuery {
                cursor: None,
                limit: Some(100)
            })
            .unwrap(),
            (None, 100)
        );
        for limit in [0, 101] {
            let error = resolve(&PageQuery {
                cursor: None,
                limit: Some(limit),
            })
            .unwrap_err();
            assert_eq!(
                error,
                DomainError::invalid("limit", "expected an integer between 1 and 100")
            );
        }
    }

    #[test]
    fn a_page_reports_a_cursor_only_when_more_rows_exist() {
        let rows = vec![1, 2, 3];
        let last = page(rows.clone(), 3, |_| position());
        assert_eq!(
            last,
            Page {
                items: vec![1, 2, 3],
                next_cursor: None
            }
        );
        let first = page(rows, 2, |_| position());
        assert_eq!(first.items, vec![1, 2]);
        assert_eq!(first.next_cursor, Some(encode(&position())));
    }
}
