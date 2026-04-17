//! Streaming JSONL reader — port of `packages/sdk/src/io/streaming-jsonl-reader.ts`.
//!
//! Reads a JSONL file line-by-line using a fixed 64KB buffer, yielding each
//! non-empty line as a `&str` along with its byte offset in the file. The
//! reader itself does **not** parse JSON — callers feed the `&str` to
//! sonic-rs or serde_json. This keeps the I/O layer independent of the
//! message schema.
//!
//! Matches the TypeScript original on:
//! - 64KB buffer size
//! - UTF-8 safety via raw-byte leftover carry-over across chunk boundaries
//! - Byte offset tracking per line (needed for incremental warm-start reads)
//! - Forgiving file handling: missing files return an empty result, not an error
//! - Line indices skip blank / whitespace-only lines
//! - `from_byte_position` supports incremental re-reads

use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;

const BUFFER_SIZE: usize = 65_536;

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct StreamingResult {
    /// Number of non-empty lines the reader yielded.
    pub total_lines: u32,
    /// File position just past the last byte read.
    pub final_byte_position: u64,
}

#[derive(Debug, thiserror::Error)]
pub enum JsonlError {
    #[error("I/O error reading JSONL: {0}")]
    Io(#[from] std::io::Error),
}

/// Read a JSONL file line-by-line from `from_byte_position`, calling
/// `on_line` for each non-empty, trimmed line.
///
/// The callback receives:
/// - `line`: the trimmed UTF-8 line (invalid UTF-8 bytes are replaced).
/// - `line_index`: a zero-based counter over **non-empty** lines.
/// - `byte_offset`: the file byte position where this line starts
///   (i.e. where the caller can restart reading to re-process from here).
///
/// File-open and stat failures return `Ok` with an empty result. This
/// matches the TS behavior — session files can disappear mid-ingest and
/// the pipeline should keep going.
pub fn read_jsonl_streaming<F>(
    path: &Path,
    from_byte_position: u64,
    mut on_line: F,
) -> Result<StreamingResult, JsonlError>
where
    F: FnMut(&str, u32, u64),
{
    let file_size = match std::fs::metadata(path) {
        Ok(m) => m.len(),
        Err(_) => return Ok(StreamingResult::default()),
    };

    if from_byte_position >= file_size {
        return Ok(StreamingResult {
            total_lines: 0,
            final_byte_position: from_byte_position,
        });
    }

    let mut file = match File::open(path) {
        Ok(f) => f,
        Err(_) => return Ok(StreamingResult::default()),
    };
    file.seek(SeekFrom::Start(from_byte_position))?;

    let mut chunk = [0u8; BUFFER_SIZE];
    let mut leftover: Vec<u8> = Vec::with_capacity(BUFFER_SIZE);
    // File byte where leftover[0] sits.
    let mut leftover_file_start = from_byte_position;
    let mut file_offset = from_byte_position;
    let mut line_index: u32 = 0;

    while file_offset < file_size {
        let to_read = std::cmp::min(BUFFER_SIZE as u64, file_size - file_offset) as usize;
        let bytes_read = file.read(&mut chunk[..to_read])?;
        if bytes_read == 0 {
            break;
        }
        leftover.extend_from_slice(&chunk[..bytes_read]);
        file_offset += bytes_read as u64;

        // Scan for newlines in leftover. Emit each completed line; keep any
        // trailing partial line for the next iteration.
        let mut scan_from = 0;
        while let Some(rel) = leftover[scan_from..].iter().position(|&b| b == b'\n') {
            let nl_pos = scan_from + rel;
            let line_bytes = &leftover[scan_from..nl_pos];
            let line_byte_offset = leftover_file_start + scan_from as u64;
            emit_line(line_bytes, line_byte_offset, &mut line_index, &mut on_line);
            scan_from = nl_pos + 1;
        }

        if scan_from > 0 {
            leftover.drain(..scan_from);
            leftover_file_start += scan_from as u64;
        }
    }

    // File tail without a trailing newline.
    if !leftover.is_empty() {
        let offset = leftover_file_start;
        let bytes = std::mem::take(&mut leftover);
        emit_line(&bytes, offset, &mut line_index, &mut on_line);
    }

    Ok(StreamingResult {
        total_lines: line_index,
        final_byte_position: file_offset,
    })
}

fn emit_line<F>(bytes: &[u8], byte_offset: u64, line_index: &mut u32, on_line: &mut F)
where
    F: FnMut(&str, u32, u64),
{
    let cow = String::from_utf8_lossy(bytes);
    let trimmed = cow.trim();
    if !trimmed.is_empty() {
        on_line(trimmed, *line_index, byte_offset);
        *line_index += 1;
    }
}

// ─── Tests ──────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use tempfile::NamedTempFile;

    struct Collected {
        lines: Vec<(String, u32, u64)>,
    }

    impl Collected {
        fn new() -> Self {
            Self { lines: Vec::new() }
        }
    }

    fn run(path: &Path, from: u64) -> (StreamingResult, Collected) {
        let mut collected = Collected::new();
        let result = read_jsonl_streaming(path, from, |line, idx, off| {
            collected.lines.push((line.to_string(), idx, off));
        })
        .expect("read_jsonl_streaming should not return Err for valid paths");
        (result, collected)
    }

    fn write_file(contents: &[u8]) -> NamedTempFile {
        let mut f = NamedTempFile::new().unwrap();
        f.write_all(contents).unwrap();
        f.flush().unwrap();
        f
    }

    #[test]
    fn empty_file_yields_no_lines() {
        let f = write_file(b"");
        let (result, got) = run(f.path(), 0);
        assert_eq!(result.total_lines, 0);
        assert_eq!(result.final_byte_position, 0);
        assert!(got.lines.is_empty());
    }

    #[test]
    fn missing_file_returns_empty_result() {
        let result = read_jsonl_streaming(
            Path::new("/definitely/not/a/real/path.jsonl"),
            0,
            |_, _, _| {},
        )
        .unwrap();
        assert_eq!(result, StreamingResult::default());
    }

    #[test]
    fn single_line_no_newline() {
        let f = write_file(b"{\"a\":1}");
        let (result, got) = run(f.path(), 0);
        assert_eq!(result.total_lines, 1);
        assert_eq!(result.final_byte_position, 7);
        assert_eq!(got.lines, vec![("{\"a\":1}".to_string(), 0, 0)]);
    }

    #[test]
    fn multiple_lines_offsets_track() {
        let body = b"aaa\nbbbb\ncc\n";
        let f = write_file(body);
        let (result, got) = run(f.path(), 0);
        assert_eq!(result.total_lines, 3);
        assert_eq!(result.final_byte_position, body.len() as u64);
        assert_eq!(
            got.lines,
            vec![
                ("aaa".to_string(), 0, 0),
                ("bbbb".to_string(), 1, 4),
                ("cc".to_string(), 2, 9),
            ],
        );
    }

    #[test]
    fn blank_lines_are_skipped_but_bytes_still_consumed() {
        let body = b"a\n\n\nb\n";
        let f = write_file(body);
        let (result, got) = run(f.path(), 0);
        assert_eq!(result.total_lines, 2);
        assert_eq!(result.final_byte_position, body.len() as u64);
        assert_eq!(got.lines[0], ("a".to_string(), 0, 0));
        // b's byte offset must skip the three newlines.
        assert_eq!(got.lines[1], ("b".to_string(), 1, 4));
    }

    #[test]
    fn from_byte_position_resumes_mid_file() {
        let body = b"alpha\nbeta\ngamma\n";
        let f = write_file(body);
        // Byte 6 is the start of "beta".
        let (result, got) = run(f.path(), 6);
        assert_eq!(result.total_lines, 2);
        assert_eq!(
            got.lines,
            vec![("beta".to_string(), 0, 6), ("gamma".to_string(), 1, 11),],
        );
    }

    #[test]
    fn from_byte_position_at_or_past_eof_is_noop() {
        let body = b"alpha\nbeta\n";
        let f = write_file(body);
        let (result, got) = run(f.path(), body.len() as u64);
        assert_eq!(result.total_lines, 0);
        assert_eq!(result.final_byte_position, body.len() as u64);
        assert!(got.lines.is_empty());
    }

    #[test]
    fn line_longer_than_buffer_is_reassembled() {
        // Force a line ~180KB long so it spans ~3 buffer reads.
        let long = "x".repeat(BUFFER_SIZE * 3 - 100);
        let body = format!("{long}\nshort\n");
        let f = write_file(body.as_bytes());
        let (result, got) = run(f.path(), 0);
        assert_eq!(result.total_lines, 2);
        assert_eq!(got.lines[0].0.len(), long.len());
        assert_eq!(got.lines[0].2, 0);
        assert_eq!(got.lines[1].0, "short");
        assert_eq!(got.lines[1].2, (long.len() + 1) as u64);
    }

    #[test]
    fn utf8_multibyte_char_straddling_chunk_boundary() {
        // "€" is 3 bytes: 0xE2 0x82 0xAC. Position it so its first byte lands
        // on byte BUFFER_SIZE - 1, forcing the last 2 bytes to carry over.
        let pad_len = BUFFER_SIZE - 1;
        let pad = "a".repeat(pad_len);
        let body = format!("{pad}€tail\n");
        let f = write_file(body.as_bytes());
        let (result, got) = run(f.path(), 0);
        assert_eq!(result.total_lines, 1);
        assert_eq!(got.lines[0].0, format!("{pad}€tail"));
        assert_eq!(got.lines[0].2, 0);
        assert_eq!(
            result.final_byte_position,
            body.len() as u64,
            "final byte position should equal file size",
        );
    }

    #[test]
    fn line_offset_survives_chunk_boundary() {
        // Two lines, split exactly at a buffer boundary. The second line's
        // reported offset must still be absolute, not relative.
        let first_len = BUFFER_SIZE - 5;
        let first = "a".repeat(first_len);
        let body = format!("{first}\nsecond\n");
        let f = write_file(body.as_bytes());
        let (result, got) = run(f.path(), 0);
        assert_eq!(result.total_lines, 2);
        assert_eq!(got.lines[0].2, 0);
        assert_eq!(got.lines[1].2, (first_len + 1) as u64);
    }
}
