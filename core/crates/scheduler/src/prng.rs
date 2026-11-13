//! Seeded pseudo-random numbers: a port of `packages/scheduler/src/prng.ts`.
//!
//! The generator is mulberry32. Every random choice of the scheduler comes
//! from it, so the sequence must equal the JavaScript one bit for bit. That
//! works because the algorithm only uses 32-bit integer operations and one
//! division by 2^32, all of which are exact in both languages.

/// JavaScript `ToUint32(Math.trunc(x))`: truncate, then wrap modulo 2^32.
/// Non-finite numbers become 0.
fn to_uint32(number: f64) -> u32 {
    if !number.is_finite() {
        return 0;
    }
    let wrapped = number.trunc().rem_euclid(4_294_967_296.0);
    // `wrapped` is an integer in [0, 2^32), so the cast is exact.
    #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
    let value = wrapped as u32;
    value
}

/// A mulberry32 stream.
#[derive(Debug, Clone)]
pub struct Prng {
    state: u32,
}

impl Prng {
    /// `seed` is a JavaScript number: it is truncated and wrapped to 32 bits,
    /// and a resulting 0 is replaced by `0x9e3779b9`, as `createPrng` does.
    #[must_use]
    pub fn new(seed: f64) -> Self {
        let state = to_uint32(seed);
        Self {
            state: if state == 0 { 0x9e37_79b9 } else { state },
        }
    }

    /// Uniform float in `[0, 1)`.
    pub fn next_float(&mut self) -> f64 {
        self.state = self.state.wrapping_add(0x6d2b_79f5);
        let mut value = self.state;
        value = (value ^ (value >> 15)).wrapping_mul(value | 1);
        value ^= value.wrapping_add((value ^ (value >> 7)).wrapping_mul(value | 61));
        f64::from(value ^ (value >> 14)) / 4_294_967_296.0
    }

    /// Uniform integer in `[0, max_exclusive)`; 0 when the range is empty or
    /// not finite. The result is returned as the float JavaScript computes.
    pub fn next_int(&mut self, max_exclusive: f64) -> f64 {
        if !max_exclusive.is_finite() || max_exclusive <= 0.0 {
            return 0.0;
        }
        (self.next_float() * max_exclusive).floor()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_same_seed_gives_the_same_stream() {
        let mut first = Prng::new(42.0);
        let mut second = Prng::new(42.0);
        for _ in 0..100 {
            assert_eq!(first.next_float().to_bits(), second.next_float().to_bits());
        }
        let mut other = Prng::new(43.0);
        assert_ne!(
            Prng::new(42.0).next_float().to_bits(),
            other.next_float().to_bits()
        );
    }

    #[test]
    fn floats_stay_in_the_unit_interval() {
        let mut prng = Prng::new(7.0);
        for _ in 0..10_000 {
            let value = prng.next_float();
            assert!((0.0..1.0).contains(&value), "{value}");
        }
    }

    #[test]
    fn seeds_are_truncated_and_wrapped_like_javascript() {
        let first = |seed: f64| Prng::new(seed).next_float().to_bits();
        assert_eq!(first(2.9), first(2.0));
        assert_eq!(first(-1.0), first(4_294_967_295.0));
        assert_eq!(first(4_294_967_296.0 + 5.0), first(5.0));
        // 0, NaN and infinities all fall back to the fixed non-zero state.
        assert_eq!(first(0.0), first(f64::NAN));
        assert_eq!(first(0.0), first(f64::INFINITY));
        assert_eq!(first(0.0), first(f64::from(0x9e37_79b9_u32)));
    }

    #[test]
    fn empty_and_invalid_ranges_yield_zero_without_consuming_the_stream() {
        let mut prng = Prng::new(1.0);
        let mut reference = Prng::new(1.0);
        for max in [0.0, -3.0, f64::NAN, f64::INFINITY] {
            assert_eq!(prng.next_int(max).to_bits(), 0.0_f64.to_bits());
        }
        assert_eq!(
            prng.next_float().to_bits(),
            reference.next_float().to_bits()
        );
        let value = prng.next_int(7.0);
        assert!((0.0..7.0).contains(&value) && value.fract() == 0.0);
    }
}
