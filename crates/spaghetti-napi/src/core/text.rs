//! Shared text helpers used by every source's message extractor.
//!
//! The TS extractors measure truncation limits in JS string units — i.e.
//! UTF-16 code units (`String.prototype.length` / `.slice` / `.substring`).
//! Truncating by UTF-8 bytes instead diverges whenever the text contains
//! multi-byte characters, so the FTS/preview blobs the two engines store
//! would differ. These helpers count UTF-16 code units to stay byte-for-byte
//! (semantically) aligned with the TS source.

/// Truncate `text` to at most `max_units` UTF-16 code units, never splitting
/// a `char`.
///
/// Mirrors JS `str.substring(0, max)` / `str.slice(0, max)` where the length
/// unit is a UTF-16 code unit — so a BMP character counts as 1 and an
/// astral-plane character (emoji, some CJK ext.) counts as 2. Unlike raw JS
/// slicing, we never emit a lone surrogate: if including the next character
/// would exceed `max_units`, we stop at the preceding `char` boundary.
///
/// Returns a borrowed prefix slice of `text`.
pub fn truncate_utf16(text: &str, max_units: usize) -> &str {
    let mut units = 0usize;
    for (byte_idx, ch) in text.char_indices() {
        let w = ch.len_utf16();
        if units + w > max_units {
            return &text[..byte_idx];
        }
        units += w;
    }
    text
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ascii_under_limit_is_unchanged() {
        assert_eq!(truncate_utf16("hello", 2000), "hello");
    }

    #[test]
    fn ascii_at_limit_is_unchanged() {
        let s = "a".repeat(2000);
        assert_eq!(truncate_utf16(&s, 2000), s.as_str());
    }

    #[test]
    fn ascii_over_limit_cuts_at_unit_count() {
        let s = "b".repeat(2100);
        let out = truncate_utf16(&s, 2000);
        assert_eq!(out.chars().count(), 2000);
        assert_eq!(out.len(), 2000);
    }

    #[test]
    fn bmp_char_counts_as_one_unit() {
        // '€' is 3 UTF-8 bytes but a single UTF-16 code unit. 2000 of them
        // fit exactly under a 2000-unit cap and must not be truncated.
        let s = "€".repeat(2000);
        let out = truncate_utf16(&s, 2000);
        assert_eq!(out.chars().count(), 2000);
        assert_eq!(out, s.as_str());
    }

    #[test]
    fn astral_char_counts_as_two_units() {
        // '😀' is 2 UTF-16 code units. A 2000-unit cap admits exactly 1000.
        let s = "😀".repeat(1500);
        let out = truncate_utf16(&s, 2000);
        assert_eq!(out.chars().count(), 1000);
    }

    #[test]
    fn never_splits_a_char_at_the_boundary() {
        // 1999 units of ASCII, then a 2-unit astral char would push to 2001;
        // the astral char is dropped whole rather than emitting a surrogate.
        let mut s = "a".repeat(1999);
        s.push('😀');
        s.push_str("tail");
        let out = truncate_utf16(&s, 2000);
        assert_eq!(out, "a".repeat(1999));
    }

    #[test]
    fn bmp_char_included_when_it_fits_exactly() {
        // 1999 ASCII + 1-unit '€' = 2000 units → the '€' IS included.
        let mut s = "a".repeat(1999);
        s.push('€');
        s.push_str("tail");
        let out = truncate_utf16(&s, 2000);
        assert_eq!(out, format!("{}€", "a".repeat(1999)));
    }

    #[test]
    fn empty_is_empty() {
        assert_eq!(truncate_utf16("", 2000), "");
    }
}
