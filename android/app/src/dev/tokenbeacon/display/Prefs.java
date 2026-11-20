package dev.tokenbeacon.display;

import android.content.Context;
import android.content.SharedPreferences;

/** The app's own settings (private SharedPreferences). */
final class Prefs {
    static final String FILE = "tokenbeacon";
    static final String MODE = "mode";
    static final String ALWAYS_ON = "always_on";
    static final String BRIGHTNESS = "brightness_percent";
    static final String BATTERY_PROTECTION = "battery_protection";
    static final String REQUIRE_PAIRING = "require_pairing";

    private Prefs() {}

    static SharedPreferences of(Context context) {
        return context.getSharedPreferences(FILE, Context.MODE_PRIVATE);
    }

    static PowerPolicy.Settings load(Context context) {
        SharedPreferences prefs = of(context);
        PowerPolicy.Settings settings = new PowerPolicy.Settings();
        settings.mode = PowerPolicy.parseMode(prefs.getString(MODE, "auto"));
        settings.alwaysOn = prefs.getBoolean(ALWAYS_ON, true);
        int brightness = prefs.getInt(BRIGHTNESS, -1);
        settings.brightnessPercent = brightness < 0 ? -1 : Math.max(5, Math.min(100, brightness));
        settings.batteryProtection = prefs.getBoolean(BATTERY_PROTECTION, true);
        return settings;
    }

    static boolean requirePairing(Context context) {
        return of(context).getBoolean(REQUIRE_PAIRING, true);
    }
}
