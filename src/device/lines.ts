import { MAX_LINE_BYTES } from "./protocol.ts";

/**
 * Splits a byte stream from the device into lines with bounded memory. A line
 * longer than MAX_LINE_BYTES is dropped (counted, never stored) and reading
 * resumes after its newline. Decoding is UTF-8; invalid bytes become U+FFFD,
 * which the protocol parser then rejects.
 */
export class LineAssembler {
  private buffer = Buffer.alloc(0);
  private skipping = false;
  /** Lines dropped because they were too long. */
  dropped = 0;

  private readonly onLine: (line: string) => void;
  private readonly maxBytes: number;

  constructor(onLine: (line: string) => void, maxBytes = MAX_LINE_BYTES) {
    this.onLine = onLine;
    this.maxBytes = maxBytes;
  }

  push(chunk: Buffer): void {
    let data = this.buffer.length > 0 ? Buffer.concat([this.buffer, chunk]) : chunk;
    let newline = data.indexOf(0x0a);
    while (newline >= 0) {
      if (this.skipping) {
        this.skipping = false;
      } else if (newline + 1 <= this.maxBytes) {
        this.onLine(data.subarray(0, newline + 1).toString("utf8"));
      } else {
        this.dropped += 1;
      }
      data = data.subarray(newline + 1);
      newline = data.indexOf(0x0a);
    }
    if (this.skipping) {
      this.buffer = Buffer.alloc(0);
    } else if (data.length > this.maxBytes) {
      this.dropped += 1;
      this.skipping = true;
      this.buffer = Buffer.alloc(0);
    } else {
      this.buffer = Buffer.from(data);
    }
  }
}
