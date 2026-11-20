package dev.tokenbeacon.display;

/**
 * Decides how the display behaves from the user's settings and the phone's
 * power state. Plain Java (no Android types) so JVM tests cover every rule.
 *
 *   Desk      – on a charger: screen can stay on, normal Bluetooth advertising.
 *   Portable  – on battery: the system screen timeout applies, brightness is
 *               capped and the phone advertises less often (reconnects slower).
 *   Auto      – Desk while charging, Portable otherwise.
 *
 * Battery protection (on battery only): saves power at 20 %, pauses Bluetooth
 * at 10 % and resumes above 15 % or on the charger. Android does not let an
 * app limit charging without root, so on the charger it can only advise.
 */
final class PowerPolicy {
    private PowerPolicy() {}

    enum Mode { AUTO, DESK, PORTABLE }

    static final int SAVE_LEVEL = 20;
    static final int PAUSE_LEVEL = 10;
    static final int RESUME_LEVEL = 15;
    static final int FULL_LEVEL = 90;
    /** Tenths of a degree Celsius. */
    static final int HOT_TENTHS = 420;
    static final float PORTABLE_MAX_BRIGHTNESS = 0.4f;
    static final float SAVE_BRIGHTNESS = 0.15f;
    static final float HOT_MAX_BRIGHTNESS = 0.3f;
    /** Factor applied while there is no fresh data (always-on screens dim themselves). */
    static final float OFFLINE_DIM = 0.3f;

    static final class Settings {
        Mode mode = Mode.AUTO;
        /** Keep the screen on in Desk mode. */
        boolean alwaysOn = true;
        /** 5–100 %, or -1 to follow the system brightness. */
        int brightnessPercent = -1;
        boolean batteryProtection = true;
    }

    static final class Power {
        boolean plugged;
        /** 0–100, or -1 when unknown. */
        int level = -1;
        /** Tenths of °C, or Integer.MIN_VALUE when unknown. */
        int temperatureTenths = Integer.MIN_VALUE;
    }

    enum Notice { NONE, SAVING, PAUSED, HOT, FULL_ON_CHARGER }

    static final class Profile {
        boolean desk;
        boolean keepScreenOn;
        /** 0.01–1, or -1 for the system brightness. */
        float brightness = -1;
        boolean lowPowerAdvertising;
        /** Bluetooth stops: no advertising, the host is disconnected. */
        boolean paused;
        /** Move the content slightly from time to time (screen stays on for hours). */
        boolean pixelShift;
        Notice notice = Notice.NONE;
    }

    static Profile decide(Settings settings, Power power, boolean wasPaused) {
        Profile p = new Profile();
        p.desk = settings.mode == Mode.DESK || (settings.mode == Mode.AUTO && power.plugged);
        p.keepScreenOn = p.desk && settings.alwaysOn;
        p.lowPowerAdvertising = !p.desk;
        p.brightness = settings.brightnessPercent < 0 ? -1 : clamp(settings.brightnessPercent / 100f);
        if (!p.desk && p.brightness > PORTABLE_MAX_BRIGHTNESS) p.brightness = PORTABLE_MAX_BRIGHTNESS;

        boolean onBattery = !power.plugged;
        boolean known = power.level >= 0;
        if (settings.batteryProtection && onBattery && known) {
            boolean pause = wasPaused ? power.level <= RESUME_LEVEL : power.level <= PAUSE_LEVEL;
            if (pause) {
                p.paused = true;
                p.keepScreenOn = false;
                p.lowPowerAdvertising = true;
                p.brightness = SAVE_BRIGHTNESS;
                p.notice = Notice.PAUSED;
            } else if (power.level <= SAVE_LEVEL) {
                p.keepScreenOn = false;
                p.lowPowerAdvertising = true;
                p.brightness = SAVE_BRIGHTNESS;
                p.notice = Notice.SAVING;
            }
        }
        if (settings.batteryProtection && power.temperatureTenths != Integer.MIN_VALUE && power.temperatureTenths >= HOT_TENTHS) {
            p.brightness = p.brightness < 0 ? HOT_MAX_BRIGHTNESS : Math.min(p.brightness, HOT_MAX_BRIGHTNESS);
            if (p.notice == Notice.NONE) p.notice = Notice.HOT;
        }
        if (settings.batteryProtection && power.plugged && known && power.level >= FULL_LEVEL && p.notice == Notice.NONE) {
            p.notice = Notice.FULL_ON_CHARGER;
        }
        p.pixelShift = p.keepScreenOn;
        return p;
    }

    /** Brightness while there is no fresh data: dimmer, never brighter than the profile. */
    static float offlineBrightness(Profile profile) {
        float base = profile.brightness < 0 ? 0.5f : profile.brightness;
        return Math.max(0.01f, base * OFFLINE_DIM);
    }

    static Mode parseMode(String value) {
        if ("desk".equals(value)) return Mode.DESK;
        if ("portable".equals(value)) return Mode.PORTABLE;
        return Mode.AUTO;
    }

    static String modeKey(Mode mode) {
        return mode == Mode.DESK ? "desk" : mode == Mode.PORTABLE ? "portable" : "auto";
    }

    private static float clamp(float value) {
        return Math.max(0.05f, Math.min(1f, value));
    }
}
