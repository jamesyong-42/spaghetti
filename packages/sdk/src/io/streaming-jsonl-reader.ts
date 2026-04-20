/**
 * Streaming JSONL Reader — Buffer-based line reader with byte offset tracking
 *
 * Reads JSONL files line-by-line using a fixed-size buffer, avoiding loading
 * the entire file into memory. Supports incremental reads via fromBytePosition.
 */

import { openSync, readSync, closeSync, statSync } from 'fs';

// ═══════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════

export interface JsonlLineCallback<T> {
  /**
   * Invoked per parsed JSON line.
   *
   * @param entry         - Parsed JSON value.
   * @param lineIndex     - 0-based position among successfully parsed lines.
   * @param byteOffset    - Start offset of the line in the file.
   * @param endByteOffset - Byte just past the trailing `\n` for newline-
   *   terminated lines, or just past the last byte of the line when the
   *   file has no final newline.
   * @param terminated    - True when the line ended with an explicit
   *   `\n`. False for the "leftover" tail when a file has no final
   *   newline — live tailers should NOT advance past such lines since
   *   they're typically a partially-written row that will complete on
   *   a subsequent append.
   */
  (entry: T, lineIndex: number, byteOffset: number, endByteOffset: number, terminated: boolean): void;
}

export interface StreamingJsonlOptions {
  fromBytePosition?: number;
  onError?: (lineIndex: number, error: string) => void;
}

export interface StreamingJsonlResult {
  totalLines: number;
  processedLines: number;
  finalBytePosition: number;
  errorCount: number;
}

// ═══════════════════════════════════════════════════════════════════════════
// IMPLEMENTATION
// ═══════════════════════════════════════════════════════════════════════════

const BUFFER_SIZE = 65536; // 64KB

/**
 * Read a JSONL file line-by-line using a fixed buffer, calling the callback
 * for each successfully parsed JSON line.
 *
 * Works by reading chunks of the file into a buffer, scanning for newlines,
 * and carrying over any partial lines across buffer boundaries.
 *
 * @param filePath - Path to the JSONL file
 * @param callback - Called for each parsed entry with the entry, line index, and byte offset
 * @param options  - Optional starting byte position and error handler
 * @returns Result with line counts and final byte position
 */
export function readJsonlStreaming<T>(
  filePath: string,
  callback: JsonlLineCallback<T>,
  options?: StreamingJsonlOptions,
): StreamingJsonlResult {
  const result: StreamingJsonlResult = {
    totalLines: 0,
    processedLines: 0,
    finalBytePosition: 0,
    errorCount: 0,
  };

  let fileSize: number;
  try {
    const stats = statSync(filePath);
    fileSize = stats.size;
  } catch {
    return result;
  }

  const startPosition = options?.fromBytePosition ?? 0;
  if (startPosition >= fileSize) {
    result.finalBytePosition = startPosition;
    return result;
  }

  let fd: number;
  try {
    fd = openSync(filePath, 'r');
  } catch {
    return result;
  }

  try {
    const buffer = Buffer.alloc(BUFFER_SIZE);
    let fileOffset = startPosition;
    let lineIndex = 0;

    // Leftover bytes from previous chunk that didn't end with a newline.
    // We store these as raw bytes (Buffer) to avoid UTF-8 boundary issues.
    let leftoverBuf: Buffer | null = null;

    while (fileOffset < fileSize) {
      const bytesToRead = Math.min(BUFFER_SIZE, fileSize - fileOffset);
      const bytesRead = readSync(fd, buffer, 0, bytesToRead, fileOffset);
      if (bytesRead === 0) break;

      // Build the working buffer: leftover + new chunk
      let workBuf: Buffer;
      let leftoverLen: number;
      if (leftoverBuf && leftoverBuf.length > 0) {
        leftoverLen = leftoverBuf.length;
        workBuf = Buffer.concat([leftoverBuf, buffer.subarray(0, bytesRead)]);
      } else {
        leftoverLen = 0;
        workBuf = buffer.subarray(0, bytesRead);
      }

      // The byte position where workBuf[0] sits in the file
      const workBufFileStart = fileOffset - leftoverLen;

      fileOffset += bytesRead;

      // Scan for newlines in the working buffer
      let scanFrom = 0;

      while (scanFrom < workBuf.length) {
        const newlinePos = workBuf.indexOf(0x0a, scanFrom); // 0x0a = '\n'

        if (newlinePos === -1) {
          // No more newlines in this chunk — keep leftover
          leftoverBuf = Buffer.from(workBuf.subarray(scanFrom));
          scanFrom = workBuf.length; // exit loop
        } else {
          // We have a complete line from scanFrom to newlinePos
          const lineBytes = workBuf.subarray(scanFrom, newlinePos);
          const lineStr = lineBytes.toString('utf-8').trim();
          const lineByteOffset = workBufFileStart + scanFrom;
          const lineEndByteOffset = workBufFileStart + newlinePos + 1;

          if (lineStr.length > 0) {
            result.totalLines++;

            try {
              const entry = JSON.parse(lineStr) as T;
              callback(entry, lineIndex, lineByteOffset, lineEndByteOffset, /* terminated */ true);
              result.processedLines++;
            } catch (error) {
              result.errorCount++;
              options?.onError?.(lineIndex, error instanceof Error ? error.message : String(error));
            }

            lineIndex++;
          }

          scanFrom = newlinePos + 1;
          leftoverBuf = null;
        }
      }
    }

    // Handle final leftover (file doesn't end with newline)
    if (leftoverBuf && leftoverBuf.length > 0) {
      const finalStr = leftoverBuf.toString('utf-8').trim();
      if (finalStr.length > 0) {
        result.totalLines++;
        const lineByteOffset = fileOffset - leftoverBuf.length;
        const lineEndByteOffset = fileOffset;

        try {
          const entry = JSON.parse(finalStr) as T;
          callback(entry, lineIndex, lineByteOffset, lineEndByteOffset, /* terminated */ false);
          result.processedLines++;
        } catch (error) {
          result.errorCount++;
          options?.onError?.(lineIndex, error instanceof Error ? error.message : String(error));
        }
      }
    }

    result.finalBytePosition = fileOffset;
  } finally {
    closeSync(fd);
  }

  return result;
}
