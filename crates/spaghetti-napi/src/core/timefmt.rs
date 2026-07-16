//! Shared epoch-millisecond → ISO 8601 formatter.
//!
//! Every source that derives a session `created`/`modified` timestamp from a
//! file mtime needs the exact string JS `new Date(ms).toISOString()` produces
//! — a UTC instant with a 3-digit millisecond fraction and a trailing `Z`
//! (e.g. `2026-04-17T14:36:40.342Z`). The `time` crate's `Rfc3339` formatter
//! trims trailing fractional zeros (`.340Z` → `.34Z`, `.000Z` → `Z`), which
//! diverges from JS; this helper pins the fraction to exactly 3 digits.

/// Format an epoch-millisecond timestamp as an ISO 8601 UTC string matching
/// JS `new Date(ms).toISOString()` (always exactly 3 fractional digits + `Z`).
///
/// Values outside the representable range fall back to the Unix epoch, matching
/// how JS coerces `NaN`/`Invalid Date` at the boundaries.
pub fn epoch_ms_to_iso8601(ms: f64) -> String {
    use time::format_description::well_known::{iso8601, Iso8601};

    let nanos = (ms * 1_000_000.0) as i128;
    let dt = time::OffsetDateTime::from_unix_timestamp_nanos(nanos)
        .unwrap_or(time::OffsetDateTime::UNIX_EPOCH);

    // JS's toISOString() renders milliseconds (3 digits) in UTC with a
    // trailing 'Z'. `Iso8601::DEFAULT` would emit nanoseconds, so use a
    // 3-digit subsecond config to match JS byte-for-byte.
    const CFG: iso8601::EncodedConfig = iso8601::Config::DEFAULT
        .set_time_precision(iso8601::TimePrecision::Second {
            decimal_digits: std::num::NonZeroU8::new(3),
        })
        .encode();
    dt.format(&Iso8601::<CFG>)
        .unwrap_or_else(|_| "1970-01-01T00:00:00.000Z".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn matches_js_to_iso_string_with_three_digit_ms() {
        // JS: new Date(1700000000342).toISOString() === "2023-11-14T22:13:20.342Z"
        assert_eq!(
            epoch_ms_to_iso8601(1_700_000_000_342.0),
            "2023-11-14T22:13:20.342Z"
        );
    }

    #[test]
    fn keeps_trailing_zero_fraction() {
        // JS: new Date(1700000000340).toISOString() === "2023-11-14T22:13:20.340Z"
        // (Rfc3339 would trim this to ".34Z" — the bug this helper fixes.)
        assert_eq!(
            epoch_ms_to_iso8601(1_700_000_000_340.0),
            "2023-11-14T22:13:20.340Z"
        );
    }

    #[test]
    fn whole_second_keeps_three_zeros() {
        // JS: new Date(1700000000000).toISOString() === "2023-11-14T22:13:20.000Z"
        assert_eq!(
            epoch_ms_to_iso8601(1_700_000_000_000.0),
            "2023-11-14T22:13:20.000Z"
        );
    }

    #[test]
    fn epoch_zero() {
        assert_eq!(epoch_ms_to_iso8601(0.0), "1970-01-01T00:00:00.000Z");
    }
}
