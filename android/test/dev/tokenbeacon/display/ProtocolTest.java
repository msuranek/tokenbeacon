package dev.tokenbeacon.display;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.List;
import java.util.Map;

/**
 * Plain JVM test (no Android, no JUnit): the phone's parser must give the same
 * verdict as the host and the ESP32 for every shared vector in
 * tests/device-vectors/host-to-device.jsonl. Run by android/build.sh.
 */
public final class ProtocolTest {
    private static int failures;
    private static int passed;

    public static void main(String[] args) throws Exception {
        Path vectors = Paths.get(args.length > 0 ? args[0] : "tests/device-vectors/host-to-device.jsonl");
        List<String> rows = Files.readAllLines(vectors, StandardCharsets.UTF_8);
        for (String row : rows) {
            if (row.trim().isEmpty()) continue;
            @SuppressWarnings("unchecked")
            Map<String, Object> vector = (Map<String, Object>) Json.parse(row);
            Protocol.Result result = Protocol.parseHostLine((String) vector.get("line"));
            String actual = result.error == null ? "ok" : result.error;
            check(vector.get("expect").equals(actual), "vector \"" + vector.get("note") + "\": expected " + vector.get("expect") + ", got " + actual);
        }

        // The first vector decodes to the documented values.
        Protocol.State state = (Protocol.State) Protocol.parseHostLine((String) ((Map<?, ?>) Json.parse(rows.get(0))).get("line")).message;
        check(state.seq == 128 && state.five.left == 58 && state.five.resetSeconds == 7920 && state.five.ageSeconds == 312, "state fields");
        check(state.week.left == 37 && state.ctx.used == 46 && state.ctx.status == Protocol.Status.CURRENT && state.nextSeconds == 10, "state fields 2");

        // Lines split across BLE chunks are joined; an overlong line is dropped once.
        LineAssembler lines = new LineAssembler();
        check(lines.push("{\"a\":".getBytes(StandardCharsets.UTF_8)).isEmpty(), "partial line");
        List<String> joined = lines.push("1}\n{\"b\"".getBytes(StandardCharsets.UTF_8));
        check(joined.size() == 1 && joined.get(0).equals("{\"a\":1}\n"), "joined line");
        lines.reset();
        byte[] big = new byte[700];
        java.util.Arrays.fill(big, (byte) 'x');
        check(lines.push(big).isEmpty(), "overlong line pending");
        List<String> dropped = lines.push("tail\nok\n".getBytes(StandardCharsets.UTF_8));
        check(dropped.size() == 2 && dropped.get(0) == null && "ok\n".equals(dropped.get(1)), "overlong line dropped");
        byte[] exact = new byte[512];
        java.util.Arrays.fill(exact, (byte) 'y');
        exact[511] = '\n';
        List<String> max = new LineAssembler().push(exact);
        check(max.size() == 1 && max.get(0) != null, "512-byte line kept");

        // Device lines are accepted by the host parser rules (fixed fields only).
        check(Protocol.hello(DisplayService.FIRMWARE, "5f1c9a2e", "c3a9f01b").equals(
                "{\"tb\":1,\"t\":\"hello\",\"dev\":\"tokenbeacon-display\",\"fw\":\"android-0.1.0\",\"proto\":[1],\"nonce\":\"5f1c9a2e\",\"id\":\"c3a9f01b\"}\n"), "hello line");

        // Display texts.
        check(DisplayFormat.duration(7920).equals("2h 12m") && DisplayFormat.duration(288000).equals("3d 8h") && DisplayFormat.duration(45).equals("45s"), "durations");
        DisplayFormat.Metric five = DisplayFormat.limit(state.five, 0);
        check(five.value.equals("58") && five.level == DisplayFormat.Level.GOOD && five.note.equals("resets in 2h 12m") && five.tag.equals("LAST"), "5h metric");
        Protocol.Limit expired = new Protocol.Limit();
        expired.status = Protocol.Status.LAST_KNOWN;
        expired.expired = true;
        check(DisplayFormat.limit(expired, 0).value.equals("WAIT") && DisplayFormat.limit(expired, 0).bar == -1, "expired shows no percentage");
        check(DisplayFormat.limit(new Protocol.Limit(), 0).value.equals("N/A"), "unavailable");
        Protocol.Context current = new Protocol.Context();
        current.status = Protocol.Status.CURRENT;
        current.used = 40;
        check(DisplayFormat.context(current, 29).tag.equals("NOW") && DisplayFormat.context(current, 30).tag.equals("LAST")
                && DisplayFormat.context(current, 720).tag.equals("LAST"), "NOW only while data is fresh");
        Protocol.Limit currentLimit = new Protocol.Limit();
        currentLimit.status = Protocol.Status.CURRENT;
        currentLimit.left = 59;
        check(DisplayFormat.limit(currentLimit, 0).tag.equals("NOW") && DisplayFormat.limit(currentLimit, 720).tag.equals("LAST"), "stale limit is LAST");
        check(DisplayFormat.freshness(state, 29_999) == DisplayFormat.Freshness.LIVE && DisplayFormat.freshness(state, 30_000) == DisplayFormat.Freshness.STALE
                && DisplayFormat.freshness(state, 120_000) == DisplayFormat.Freshness.OFFLINE, "freshness");

        // Power policy (BLE-B): modes, always-on, brightness, battery protection.
        PowerPolicy.Settings auto = new PowerPolicy.Settings();
        PowerPolicy.Power charging = power(true, 80, 300);
        PowerPolicy.Power battery = power(false, 60, 300);
        PowerPolicy.Profile p = PowerPolicy.decide(auto, charging, false);
        check(p.desk && p.keepScreenOn && p.pixelShift && !p.lowPowerAdvertising && !p.paused && p.brightness == -1, "auto on charger = desk, always-on");
        p = PowerPolicy.decide(auto, battery, false);
        check(!p.desk && !p.keepScreenOn && p.lowPowerAdvertising && !p.pixelShift, "auto on battery = portable");
        PowerPolicy.Settings desk = new PowerPolicy.Settings();
        desk.mode = PowerPolicy.Mode.DESK;
        desk.alwaysOn = false;
        check(PowerPolicy.decide(desk, battery, false).desk && !PowerPolicy.decide(desk, battery, false).keepScreenOn, "desk without always-on");
        PowerPolicy.Settings bright = new PowerPolicy.Settings();
        bright.brightnessPercent = 90;
        check(PowerPolicy.decide(bright, charging, false).brightness == 0.9f, "brightness on charger");
        check(PowerPolicy.decide(bright, battery, false).brightness == PowerPolicy.PORTABLE_MAX_BRIGHTNESS, "portable caps brightness");
        p = PowerPolicy.decide(auto, power(false, 20, 300), false);
        check(p.notice == PowerPolicy.Notice.SAVING && !p.paused && p.brightness == PowerPolicy.SAVE_BRIGHTNESS, "saving at 20 %");
        p = PowerPolicy.decide(auto, power(false, 10, 300), false);
        check(p.paused && p.notice == PowerPolicy.Notice.PAUSED, "pause at 10 %");
        check(PowerPolicy.decide(auto, power(false, 14, 300), true).paused, "stays paused below resume level");
        check(!PowerPolicy.decide(auto, power(false, 16, 300), true).paused, "resumes above 15 %");
        check(!PowerPolicy.decide(auto, power(true, 5, 300), true).paused, "resumes on the charger");
        PowerPolicy.Settings off = new PowerPolicy.Settings();
        off.batteryProtection = false;
        check(!PowerPolicy.decide(off, power(false, 3, 500), false).paused && PowerPolicy.decide(off, power(false, 3, 500), false).notice == PowerPolicy.Notice.NONE, "protection off");
        p = PowerPolicy.decide(bright, power(true, 50, 450), false);
        check(p.notice == PowerPolicy.Notice.HOT && p.brightness == PowerPolicy.HOT_MAX_BRIGHTNESS, "hot phone dims");
        check(PowerPolicy.decide(auto, power(true, 95, 300), false).notice == PowerPolicy.Notice.FULL_ON_CHARGER, "full on charger advice");
        check(PowerPolicy.decide(auto, power(false, -1, Integer.MIN_VALUE), false).notice == PowerPolicy.Notice.NONE, "unknown battery state");
        check(PowerPolicy.offlineBrightness(PowerPolicy.decide(bright, charging, false)) < 0.9f, "dims without fresh data");
        check(PowerPolicy.parseMode("desk") == PowerPolicy.Mode.DESK && PowerPolicy.parseMode("x") == PowerPolicy.Mode.AUTO, "mode keys");

        System.out.println("ProtocolTest: " + passed + " passed, " + failures + " failed");
        if (failures > 0) System.exit(1);
    }

    private static PowerPolicy.Power power(boolean plugged, int level, int tenths) {
        PowerPolicy.Power power = new PowerPolicy.Power();
        power.plugged = plugged;
        power.level = level;
        power.temperatureTenths = tenths;
        return power;
    }

    private static void check(boolean ok, String name) {
        if (ok) {
            passed++;
        } else {
            failures++;
            System.out.println("FAIL " + name);
        }
    }
}
