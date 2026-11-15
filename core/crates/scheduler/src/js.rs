//! JavaScript number semantics the port has to reproduce.
//!
//! The reference computes with doubles and `Math.*`. Rust's `f64` methods
//! agree with JavaScript for `floor`, `ceil`, `trunc`, `abs`, `%` and the
//! four operations, but not for the functions below.

/// `Math.max(a, b)`: NaN if either is NaN (`f64::max` would drop it), and
/// `+0` wins over `-0`.
#[must_use]
pub fn max(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        f64::NAN
    } else if a > b || (a == b && a.is_sign_positive()) {
        a
    } else {
        b
    }
}

/// `Math.min(a, b)`: NaN if either is NaN, and `-0` wins over `+0`.
#[must_use]
pub fn min(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        f64::NAN
    } else if a < b || (a == b && a.is_sign_negative()) {
        a
    } else {
        b
    }
}

/// `Math.round(x)`: to the nearest integer, halves towards +∞
/// (`f64::round` sends halves away from zero).
#[must_use]
pub fn round(x: f64) -> f64 {
    if !x.is_finite() {
        return x;
    }
    let floor = x.floor();
    let rounded = if x - floor >= 0.5 { floor + 1.0 } else { floor };
    if rounded == 0.0 && x.is_sign_negative() {
        -0.0
    } else {
        rounded
    }
}

/// `Number.isInteger(x)`.
#[must_use]
pub fn is_integer(x: f64) -> bool {
    x.is_finite() && x.fract() == 0.0
}

/// `String(x)` / `` `${x}` `` of a number: the shortest text that reads back
/// as the same double, `NaN`, `Infinity` or `-Infinity`.
#[must_use]
pub fn number_to_string(x: f64) -> String {
    ryu_js::Buffer::new().format(x).to_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn max_and_min_propagate_nan_unlike_the_f64_methods() {
        assert!(max(1.0, f64::NAN).is_nan());
        assert!(max(f64::NAN, 1.0).is_nan());
        assert!(min(f64::NAN, f64::INFINITY).is_nan());
        // The standard library would answer 1 here.
        assert!(!1.0_f64.max(f64::NAN).is_nan());
        assert_eq!(max(1.0, 2.0).to_bits(), 2.0_f64.to_bits());
        assert_eq!(min(1.0, 2.0).to_bits(), 1.0_f64.to_bits());
        assert_eq!(max(f64::NEG_INFINITY, 3.0).to_bits(), 3.0_f64.to_bits());
        assert_eq!(min(f64::INFINITY, 3.0).to_bits(), 3.0_f64.to_bits());
    }

    #[test]
    fn signed_zeros_are_ordered_as_in_javascript() {
        assert_eq!(max(0.0, -0.0).to_bits(), 0.0_f64.to_bits());
        assert_eq!(max(-0.0, 0.0).to_bits(), 0.0_f64.to_bits());
        assert_eq!(min(0.0, -0.0).to_bits(), (-0.0_f64).to_bits());
        assert_eq!(min(-0.0, 0.0).to_bits(), (-0.0_f64).to_bits());
    }

    #[test]
    fn round_sends_halves_up() {
        let cases: [(f64, f64); 11] = [
            (0.5, 1.0),
            (1.5, 2.0),
            (2.5, 3.0),
            (-0.5, -0.0),
            (-1.5, -1.0),
            (-2.5, -2.0),
            (2.4, 2.0),
            (-2.6, -3.0),
            (7.0, 7.0),
            (0.499_999_999_999_999_94, 0.0),
            (9_007_199_254_740_991.0, 9_007_199_254_740_991.0),
        ];
        for (input, expected) in cases {
            assert_eq!(round(input).to_bits(), expected.to_bits(), "{input}");
        }
        // `f64::round` disagrees on negative halves.
        assert_eq!((-2.5_f64).round().to_bits(), (-3.0_f64).to_bits());
        assert!(round(f64::NAN).is_nan());
        assert_eq!(round(f64::INFINITY), f64::INFINITY);
    }

    #[test]
    fn integers_and_number_text() {
        assert!(is_integer(5.0));
        assert!(is_integer(-0.0));
        assert!(is_integer(1e21));
        assert!(!is_integer(12.5));
        assert!(!is_integer(f64::NAN));
        assert!(!is_integer(f64::INFINITY));
        for (number, text) in [
            (5.0, "5"),
            (-0.0, "0"),
            (12.5, "12.5"),
            (1e21, "1e+21"),
            (f64::NAN, "NaN"),
            (f64::INFINITY, "Infinity"),
            (f64::NEG_INFINITY, "-Infinity"),
        ] {
            assert_eq!(number_to_string(number), text);
        }
    }
}
