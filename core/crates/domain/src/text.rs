//! Text measures that must agree with the JavaScript core.

/// Length in UTF-16 code units, i.e. JavaScript's `string.length`. The
/// TypeScript validators limit titles and descriptions with it, so a
/// character outside the Basic Multilingual Plane counts as two.
#[must_use]
pub fn utf16_len(text: &str) -> usize {
    text.encode_utf16().count()
}

/// True when JavaScript's `text.trim().length === 0`: the string is empty or
/// consists only of ECMAScript `WhiteSpace` and `LineTerminator` characters.
/// (Rust's `str::trim` uses a slightly different set: it strips U+0085 and
/// keeps U+FEFF.)
#[must_use]
pub fn is_blank_js(text: &str) -> bool {
    text.chars().all(is_js_whitespace)
}

fn is_js_whitespace(character: char) -> bool {
    matches!(
        character,
        '\u{0009}'..='\u{000D}'
            | '\u{0020}'
            | '\u{00A0}'
            | '\u{1680}'
            | '\u{2000}'..='\u{200A}'
            | '\u{2028}'
            | '\u{2029}'
            | '\u{202F}'
            | '\u{205F}'
            | '\u{3000}'
            | '\u{FEFF}'
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn utf16_length_counts_surrogate_pairs_twice() {
        assert_eq!(utf16_len("abc"), 3);
        assert_eq!(utf16_len("논문"), 2);
        assert_eq!(utf16_len("😀"), 2);
        assert_eq!(utf16_len(""), 0);
    }

    #[test]
    fn blank_follows_the_javascript_whitespace_set() {
        assert!(is_blank_js(""));
        assert!(is_blank_js(" \t\r\n"));
        assert!(is_blank_js("\u{3000}\u{00A0}\u{FEFF}\u{2028}"));
    }

    #[test]
    fn visible_text_and_non_javascript_whitespace_are_not_blank() {
        assert!(!is_blank_js(" a "));
        // U+0085 is whitespace for Rust but not for JavaScript's trim().
        assert!(!is_blank_js("\u{0085}"));
        // Zero-width space is not whitespace in either language.
        assert!(!is_blank_js("\u{200B}"));
    }
}
