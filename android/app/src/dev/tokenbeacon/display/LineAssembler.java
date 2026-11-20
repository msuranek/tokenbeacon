package dev.tokenbeacon.display;

import java.io.ByteArrayOutputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;

/**
 * Joins BLE write chunks into protocol lines. A line longer than
 * MAX_LINE_BYTES is dropped up to its newline and reported once as
 * "line_too_long", so a broken sender cannot grow memory.
 */
final class LineAssembler {
    private final ByteArrayOutputStream buffer = new ByteArrayOutputStream();
    private boolean overflow;

    /** Lines (with "\n") and, for dropped lines, null entries. */
    List<String> push(byte[] chunk) {
        List<String> lines = new ArrayList<>();
        for (byte b : chunk) {
            if (b == '\n') {
                if (overflow) {
                    lines.add(null);
                } else {
                    buffer.write(b);
                    lines.add(new String(buffer.toByteArray(), StandardCharsets.UTF_8));
                }
                buffer.reset();
                overflow = false;
            } else if (!overflow) {
                buffer.write(b);
                if (buffer.size() >= Protocol.MAX_LINE_BYTES) {
                    overflow = true;
                    buffer.reset();
                }
            }
        }
        return lines;
    }

    void reset() {
        buffer.reset();
        overflow = false;
    }
}
