package dev.tokenbeacon.display;

/** Texts and colour levels for the screen; plain Java so JVM tests can check them. */
final class DisplayFormat {
    private DisplayFormat() {}

    enum Level { GOOD, WARN, BAD, ACCENT, NONE }

    /** One metric as shown: big value, small unit, bar fill (0–100 or -1), tag and footnote. */
    static final class Metric {
        String value;
        String unit = "";
        int bar = -1;
        Level level = Level.NONE;
        String tag = "";
        String note = "";
    }

    /** Freshness of the last state, as on the ESP32 display. */
    enum Freshness { NONE, LIVE, STALE, OFFLINE }

    static Freshness freshness(Protocol.State state, long sinceMs) {
        if (state == null) return Freshness.NONE;
        if (sinceMs < DisplayStore.STALE_MS) return Freshness.LIVE;
        if (sinceMs < DisplayStore.OFFLINE_MS) return Freshness.STALE;
        return Freshness.OFFLINE;
    }

    static Metric limit(Protocol.Limit limit, long sinceSeconds) {
        Metric m = new Metric();
        if (limit == null || limit.status == Protocol.Status.UNAVAILABLE) {
            m.value = "N/A";
            return m;
        }
        m.tag = limit.status == Protocol.Status.CURRENT ? "NOW" : "LAST";
        if (limit.expired) {
            m.value = "WAIT";
            m.level = Level.WARN;
            m.note = "window ended · awaiting fresh data";
            return m;
        }
        m.value = Integer.toString(limit.left);
        m.unit = "% left";
        m.bar = limit.left;
        m.level = limit.left >= 50 ? Level.GOOD : limit.left >= 20 ? Level.WARN : Level.BAD;
        StringBuilder note = new StringBuilder();
        if (limit.resetSeconds >= 0) {
            long left = limit.resetSeconds - sinceSeconds;
            note.append(left > 0 ? "resets in " + duration(left) : "reset due");
        }
        appendAge(note, limit.ageSeconds, sinceSeconds);
        m.note = note.toString();
        return m;
    }

    static Metric context(Protocol.Context ctx, long sinceSeconds) {
        Metric m = new Metric();
        if (ctx == null || ctx.status == Protocol.Status.UNAVAILABLE) {
            m.value = "N/A";
            return m;
        }
        m.tag = ctx.status == Protocol.Status.CURRENT ? "NOW" : "LAST";
        m.value = Integer.toString(ctx.used);
        m.unit = "% used";
        m.bar = ctx.used;
        m.level = ctx.used >= 80 ? Level.BAD : ctx.used >= 60 ? Level.WARN : Level.ACCENT;
        StringBuilder note = new StringBuilder("most recent thread");
        appendAge(note, ctx.ageSeconds, sinceSeconds);
        m.note = note.toString();
        return m;
    }

    /** Shows the age of a value only when it is over an hour old. */
    private static void appendAge(StringBuilder note, long ageSeconds, long sinceSeconds) {
        if (ageSeconds < 0) return;
        long age = ageSeconds + sinceSeconds;
        if (age < 3600) return;
        if (note.length() > 0) note.append(" · ");
        note.append("measured ").append(duration(age)).append(" ago");
    }

    /** 45s, 12m, 2h 12m, 3d 8h. */
    static String duration(long seconds) {
        if (seconds < 60) return Math.max(0, seconds) + "s";
        long minutes = seconds / 60;
        if (minutes < 60) return minutes + "m";
        long hours = minutes / 60;
        if (hours < 24) return hours + "h " + (minutes % 60) + "m";
        return (hours / 24) + "d " + (hours % 24) + "h";
    }
}
