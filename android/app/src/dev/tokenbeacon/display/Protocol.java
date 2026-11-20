package dev.tokenbeacon.display;

import java.nio.charset.StandardCharsets;
import java.util.Map;
import java.util.regex.Pattern;

/**
 * device-state/v1 (docs/device-protocol.md), the same protocol as the ESP32
 * display: the phone only receives limits, context, states and ages. The rules
 * mirror src/device/protocol.ts and are checked against the shared vectors in
 * tests/device-vectors/ (android/test/ProtocolTest.java).
 */
final class Protocol {
    static final int VERSION = 1;
    static final int MAX_LINE_BYTES = 512;
    static final String DEVICE_NAME = "tokenbeacon-display";
    static final String HOST_NAME = "tokenbeacon";
    static final long MAX_INT = 2147483647L;

    private static final Pattern NONCE = Pattern.compile("^[0-9a-f]{8,32}$");
    private static final Pattern VERSION_TEXT = Pattern.compile("^[0-9A-Za-z.+-]{1,32}$");

    private Protocol() {}

    enum Status { CURRENT, LAST_KNOWN, UNAVAILABLE }

    /** A 5h or weekly limit as sent by the host. Missing numbers are -1. */
    static final class Limit {
        Status status = Status.UNAVAILABLE;
        boolean expired;
        int left = -1;
        long resetSeconds = -1;
        long ageSeconds = -1;
    }

    static final class Context {
        Status status = Status.UNAVAILABLE;
        int used = -1;
        long ageSeconds = -1;
    }

    static final class State {
        long seq;
        Limit five;
        Limit week;
        Context ctx;
        int nextSeconds;
    }

    static final class HostHello {
        String version;
        String nonce;
    }

    /** Either a message (HostHello or State) or a stable error code. */
    static final class Result {
        final Object message;
        final String error;

        private Result(Object message, String error) {
            this.message = message;
            this.error = error;
        }

        static Result ok(Object message) {
            return new Result(message, null);
        }

        static Result fail(String code) {
            return new Result(null, code);
        }
    }

    static Result parseHostLine(String line) {
        if (line == null) return Result.fail("bad_json");
        if (line.getBytes(StandardCharsets.UTF_8).length > MAX_LINE_BYTES) return Result.fail("line_too_long");
        String text = line.endsWith("\r\n") ? line.substring(0, line.length() - 2)
                : line.endsWith("\n") ? line.substring(0, line.length() - 1) : line;
        Object value;
        try {
            value = Json.parse(text);
        } catch (Json.ParseException e) {
            return Result.fail("bad_json");
        }
        if (!(value instanceof Map)) return Result.fail("bad_json");
        @SuppressWarnings("unchecked")
        Map<String, Object> record = (Map<String, Object>) value;
        Object tb = record.get("tb");
        if (!(tb instanceof Double) || (Double) tb != VERSION) {
            return Result.fail(isInteger(tb) ? "unsupported_version" : "bad_field");
        }
        Object type = record.get("t");
        if (!(type instanceof String)) return Result.fail("bad_field");
        if ("hello".equals(type)) {
            Object ver = record.get("ver");
            Object nonce = record.get("nonce");
            if (!HOST_NAME.equals(record.get("host"))
                    || !(ver instanceof String) || !VERSION_TEXT.matcher((String) ver).matches()
                    || !(nonce instanceof String) || !NONCE.matcher((String) nonce).matches()) {
                return Result.fail("bad_field");
            }
            HostHello hello = new HostHello();
            hello.version = (String) ver;
            hello.nonce = (String) nonce;
            return Result.ok(hello);
        }
        if ("state".equals(type)) {
            Limit five = readLimit(record.get("five"));
            Limit week = readLimit(record.get("week"));
            Context ctx = readContext(record.get("ctx"));
            Object next = record.get("next");
            if (!isCount(record.get("seq")) || five == null || week == null || ctx == null
                    || !isInteger(next) || (Double) next < 1 || (Double) next > 60) {
                return Result.fail("bad_field");
            }
            State state = new State();
            state.seq = ((Double) record.get("seq")).longValue();
            state.five = five;
            state.week = week;
            state.ctx = ctx;
            state.nextSeconds = ((Double) next).intValue();
            return Result.ok(state);
        }
        return Result.fail("unknown_type");
    }

    private static Limit readLimit(Object value) {
        if (!(value instanceof Map)) return null;
        Map<?, ?> map = (Map<?, ?>) value;
        Limit limit = new Limit();
        Object st = map.get("st");
        if ("unavailable".equals(st)) return limit;
        Status status = readStatus(st);
        if (status == null) return null;
        limit.status = status;
        Object age = map.get("age");
        if (age != null && !isCount(age)) return null;
        if (age != null) limit.ageSeconds = ((Double) age).longValue();
        Object win = map.get("win");
        if ("expired".equals(win)) {
            if (map.containsKey("left")) return null; // an ended window never carries a percentage
            limit.expired = true;
            return limit;
        }
        if (!"active".equals(win) || !isPercent(map.get("left"))) return null;
        limit.left = ((Double) map.get("left")).intValue();
        Object reset = map.get("reset");
        if (reset != null && !isCount(reset)) return null;
        if (reset != null) limit.resetSeconds = ((Double) reset).longValue();
        return limit;
    }

    private static Context readContext(Object value) {
        if (!(value instanceof Map)) return null;
        Map<?, ?> map = (Map<?, ?>) value;
        Context ctx = new Context();
        Object st = map.get("st");
        if ("unavailable".equals(st)) return ctx;
        Status status = readStatus(st);
        if (status == null) return null;
        Object age = map.get("age");
        if (!isPercent(map.get("used")) || (age != null && !isCount(age))) return null;
        ctx.status = status;
        ctx.used = ((Double) map.get("used")).intValue();
        if (age != null) ctx.ageSeconds = ((Double) age).longValue();
        return ctx;
    }

    private static Status readStatus(Object st) {
        if ("current".equals(st)) return Status.CURRENT;
        if ("last-known".equals(st)) return Status.LAST_KNOWN;
        return null;
    }

    private static boolean isInteger(Object value) {
        if (!(value instanceof Double)) return false;
        double d = (Double) value;
        return !Double.isInfinite(d) && d == Math.floor(d);
    }

    private static boolean isCount(Object value) {
        return isInteger(value) && (Double) value >= 0 && (Double) value <= MAX_INT;
    }

    private static boolean isPercent(Object value) {
        return isInteger(value) && (Double) value >= 0 && (Double) value <= 100;
    }

    // --- Device -> host lines (fixed fields only; never echo host data) -----

    static String hello(String firmware, String nonce, String deviceId) {
        return "{\"tb\":1,\"t\":\"hello\",\"dev\":\"" + DEVICE_NAME + "\",\"fw\":\"" + firmware
                + "\",\"proto\":[1],\"nonce\":\"" + nonce + "\",\"id\":\"" + deviceId + "\"}\n";
    }

    static String alive(long seq, long uptimeSeconds) {
        return "{\"tb\":1,\"t\":\"alive\",\"seq\":" + seq + ",\"up\":" + uptimeSeconds + "}\n";
    }

    static String error(String code) {
        return "{\"tb\":1,\"t\":\"err\",\"code\":\"" + code + "\"}\n";
    }
}
