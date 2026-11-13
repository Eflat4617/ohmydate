use std::fmt;
use std::sync::Mutex;

use crate::{Clock, IdGenerator, RandomSource};

/// An entity identifier: a `UUIDv7` in its canonical lowercase form.
///
/// The accepted shape is the contract's `UUID_V7_PATTERN`
/// (`packages/contracts/src/common.ts`): version nibble 7, RFC variant, lower
/// case hex. Because the first 48 bits are a millisecond timestamp, ids sort
/// by creation time; storage and pagination rely on that.
#[derive(Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct Id(String);

impl Id {
    /// Returns `None` unless `text` is a canonical lowercase `UUIDv7`.
    #[must_use]
    pub fn parse(text: &str) -> Option<Self> {
        let bytes = text.as_bytes();
        if bytes.len() != 36 {
            return None;
        }
        for (index, byte) in bytes.iter().enumerate() {
            let valid = match index {
                8 | 13 | 18 | 23 => *byte == b'-',
                14 => *byte == b'7',
                19 => matches!(byte, b'8' | b'9' | b'a' | b'b'),
                _ => byte.is_ascii_digit() || (b'a'..=b'f').contains(byte),
            };
            if !valid {
                return None;
            }
        }
        Some(Self(text.to_owned()))
    }

    #[must_use]
    pub fn as_str(&self) -> &str {
        &self.0
    }

    fn from_bytes(bytes: [u8; 16]) -> Self {
        const HEX: &[u8; 16] = b"0123456789abcdef";
        let mut text = String::with_capacity(36);
        for (index, byte) in bytes.iter().enumerate() {
            if matches!(index, 4 | 6 | 8 | 10) {
                text.push('-');
            }
            text.push(char::from(HEX[usize::from(byte >> 4)]));
            text.push(char::from(HEX[usize::from(byte & 0x0f)]));
        }
        Self(text)
    }
}

impl fmt::Display for Id {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

impl fmt::Debug for Id {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "Id({})", self.0)
    }
}

const MAX_SEQUENCE: u16 = 0x0fff;
const MAX_TIMESTAMP_MS: i64 = 0xffff_ffff_ffff;

#[derive(Debug)]
struct GeneratorState {
    last_ms: i64,
    sequence: u16,
}

/// Monotonic `UUIDv7` generator, a port of `createUuidV7Generator`
/// (`packages/domain/src/uuid.ts`).
///
/// Layout: 48-bit millisecond timestamp, version 7, a 12-bit counter that
/// orders ids created in the same millisecond, the RFC variant, and 62 random
/// bits. When the clock does not advance, the counter increases; when the
/// counter is exhausted the timestamp is moved one millisecond ahead. Ids from
/// one generator are therefore strictly increasing even if the clock steps
/// backwards.
pub struct UuidV7Generator<C, R> {
    clock: C,
    random: R,
    state: Mutex<GeneratorState>,
}

impl<C: Clock, R: RandomSource> UuidV7Generator<C, R> {
    pub fn new(clock: C, random: R) -> Self {
        Self {
            clock,
            random,
            state: Mutex::new(GeneratorState {
                last_ms: -1,
                sequence: 0,
            }),
        }
    }
}

impl<C, R> fmt::Debug for UuidV7Generator<C, R> {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("UuidV7Generator")
            .finish_non_exhaustive()
    }
}

impl<C: Clock, R: RandomSource> IdGenerator for UuidV7Generator<C, R> {
    fn next_id(&self) -> Id {
        let now_ms = self.clock.now().epoch_ms();
        let (timestamp_ms, sequence) = {
            // A poisoned lock only means another thread panicked mid-update;
            // the two integers are still usable.
            let mut state = self
                .state
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            if now_ms > state.last_ms {
                state.last_ms = now_ms;
                state.sequence = 0;
            } else if state.sequence < MAX_SEQUENCE {
                state.sequence += 1;
            } else {
                state.last_ms += 1;
                state.sequence = 0;
            }
            (state.last_ms.clamp(0, MAX_TIMESTAMP_MS), state.sequence)
        };

        let mut random = [0_u8; 8];
        self.random.fill(&mut random);

        let mut bytes = [0_u8; 16];
        let timestamp = timestamp_ms.to_be_bytes();
        bytes[..6].copy_from_slice(&timestamp[2..]);
        let sequence = sequence.to_be_bytes();
        bytes[6] = 0x70 | (sequence[0] & 0x0f);
        bytes[7] = sequence[1];
        bytes[8] = (random[0] & 0x3f) | 0x80;
        bytes[9..].copy_from_slice(&random[1..]);
        Id::from_bytes(bytes)
    }
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicI64, Ordering};

    use super::*;
    use crate::Instant;

    struct StepClock(AtomicI64);

    impl Clock for &StepClock {
        fn now(&self) -> Instant {
            Instant::from_epoch_ms(self.0.load(Ordering::SeqCst)).unwrap()
        }
    }

    struct FixedRandom(u8);

    impl RandomSource for FixedRandom {
        fn fill(&self, buffer: &mut [u8]) {
            buffer.fill(self.0);
        }
    }

    #[test]
    fn canonical_uuid_v7_strings_are_accepted() {
        let id = Id::parse("0193a8f2-6c1e-7b41-9a2e-1f1d6a0b3c55").unwrap();
        assert_eq!(id.as_str(), "0193a8f2-6c1e-7b41-9a2e-1f1d6a0b3c55");
        assert_eq!(id.to_string(), "0193a8f2-6c1e-7b41-9a2e-1f1d6a0b3c55");
    }

    #[test]
    fn other_versions_variants_cases_and_shapes_are_rejected() {
        for text in [
            "",
            "0193a8f2-6c1e-4b41-9a2e-1f1d6a0b3c55",
            "0193a8f2-6c1e-7b41-ca2e-1f1d6a0b3c55",
            "0193A8F2-6C1E-7B41-9A2E-1F1D6A0B3C55",
            "0193a8f26c1e7b419a2e1f1d6a0b3c55",
            "0193a8f2-6c1e-7b41-9a2e-1f1d6a0b3c5",
            "0193a8f2-6c1e-7b41-9a2e-1f1d6a0b3c555",
            "0193a8f2-6c1e-7b41-9a2e-1f1d6a0b3cg5",
            " 0193a8f2-6c1e-7b41-9a2e-1f1d6a0b3c55",
        ] {
            assert_eq!(Id::parse(text), None, "{text}");
        }
    }

    #[test]
    fn generated_ids_are_valid_and_carry_the_timestamp() {
        let clock = StepClock(AtomicI64::new(0x0193_a8f2_6c1e));
        let generator = UuidV7Generator::new(&clock, FixedRandom(0xff));
        let id = generator.next_id();
        assert_eq!(id.as_str(), "0193a8f2-6c1e-7000-bfff-ffffffffffff");
        assert!(Id::parse(id.as_str()).is_some());
    }

    #[test]
    fn ids_increase_within_one_millisecond_and_across_a_clock_step_back() {
        let clock = StepClock(AtomicI64::new(1_000));
        let generator = UuidV7Generator::new(&clock, FixedRandom(0));
        let first = generator.next_id();
        let second = generator.next_id();
        clock.0.store(900, Ordering::SeqCst);
        let third = generator.next_id();
        clock.0.store(2_000, Ordering::SeqCst);
        let fourth = generator.next_id();
        assert!(first < second, "{first} < {second}");
        assert!(second < third, "{second} < {third}");
        assert!(third < fourth, "{third} < {fourth}");
    }

    #[test]
    fn an_exhausted_counter_moves_to_the_next_millisecond() {
        let clock = StepClock(AtomicI64::new(5));
        let generator = UuidV7Generator::new(&clock, FixedRandom(0));
        let mut previous = generator.next_id();
        for _ in 0..=usize::from(MAX_SEQUENCE) {
            let next = generator.next_id();
            assert!(previous < next);
            previous = next;
        }
        assert!(
            previous.as_str().starts_with("00000000-0006-7000-"),
            "{previous}"
        );
    }
}
