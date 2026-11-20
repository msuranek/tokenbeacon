package dev.tokenbeacon.display;

import android.app.Activity;
import android.content.SharedPreferences;
import android.graphics.Color;
import android.os.Bundle;
import android.view.View;
import android.widget.CheckBox;
import android.widget.LinearLayout;
import android.widget.RadioButton;
import android.widget.RadioGroup;
import android.widget.ScrollView;
import android.widget.SeekBar;
import android.widget.Switch;
import android.widget.TextView;

/** Display mode, always-on, brightness, battery protection and pairing. */
public final class SettingsActivity extends Activity {
    private static final int BG = Color.rgb(14, 16, 20);
    private static final int TEXT = Color.rgb(236, 238, 242);
    private static final int MUTED = Color.rgb(140, 146, 158);

    private SharedPreferences prefs;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        prefs = Prefs.of(this);
        PowerPolicy.Settings settings = Prefs.load(this);

        LinearLayout list = new LinearLayout(this);
        list.setOrientation(LinearLayout.VERTICAL);
        int pad = dp(20);
        list.setPadding(pad, dp(28), pad, pad);

        list.addView(heading("Display mode"));
        RadioGroup modes = new RadioGroup(this);
        String[][] options = {
            {"auto", "Auto – Desk while charging, Portable on battery"},
            {"desk", "Desk – on a charger, screen can stay on"},
            {"portable", "Portable – save battery, screen times out"},
        };
        for (int i = 0; i < options.length; i++) {
            RadioButton button = new RadioButton(this);
            button.setId(View.generateViewId());
            button.setText(options[i][1]);
            button.setTextColor(TEXT);
            button.setTag(options[i][0]);
            modes.addView(button);
            if (options[i][0].equals(PowerPolicy.modeKey(settings.mode))) modes.check(button.getId());
        }
        modes.setOnCheckedChangeListener((group, id) -> {
            View checked = group.findViewById(id);
            if (checked != null) prefs.edit().putString(Prefs.MODE, (String) checked.getTag()).apply();
        });
        list.addView(modes);

        Switch alwaysOn = toggle("Always-on screen in Desk mode", settings.alwaysOn);
        alwaysOn.setOnCheckedChangeListener((b, on) -> prefs.edit().putBoolean(Prefs.ALWAYS_ON, on).apply());
        list.addView(alwaysOn);
        list.addView(note("Moves the content slightly every minute and dims without fresh data, against burn-in."));

        list.addView(heading("Brightness"));
        CheckBox system = new CheckBox(this);
        system.setText("Follow system brightness");
        system.setTextColor(TEXT);
        system.setChecked(settings.brightnessPercent < 0);
        SeekBar level = new SeekBar(this);
        level.setMax(95);
        level.setProgress((settings.brightnessPercent < 0 ? 60 : settings.brightnessPercent) - 5);
        level.setEnabled(settings.brightnessPercent >= 0);
        TextView levelText = note("");
        Runnable showLevel = () -> levelText.setText(system.isChecked() ? "System" : (level.getProgress() + 5) + " % (Portable at most 40 %)");
        showLevel.run();
        system.setOnCheckedChangeListener((b, on) -> {
            level.setEnabled(!on);
            prefs.edit().putInt(Prefs.BRIGHTNESS, on ? -1 : level.getProgress() + 5).apply();
            showLevel.run();
        });
        level.setOnSeekBarChangeListener(new SeekBar.OnSeekBarChangeListener() {
            @Override
            public void onProgressChanged(SeekBar bar, int progress, boolean fromUser) {
                if (fromUser) prefs.edit().putInt(Prefs.BRIGHTNESS, progress + 5).apply();
                showLevel.run();
            }

            @Override
            public void onStartTrackingTouch(SeekBar bar) {}

            @Override
            public void onStopTrackingTouch(SeekBar bar) {}
        });
        list.addView(system);
        list.addView(level);
        list.addView(levelText);

        list.addView(heading("Battery"));
        Switch protection = toggle("Battery protection", settings.batteryProtection);
        protection.setOnCheckedChangeListener((b, on) -> prefs.edit().putBoolean(Prefs.BATTERY_PROTECTION, on).apply());
        list.addView(protection);
        list.addView(note("On battery: saves power at " + PowerPolicy.SAVE_LEVEL + " % and pauses Bluetooth at "
                + PowerPolicy.PAUSE_LEVEL + " % until the charger is connected. Dims the screen when the phone is warm.\n"
                + "Android does not let apps stop charging without root. For a phone that stays on a charger, use the "
                + "phone's own battery protection if it has one, or a smart plug or timer."));

        list.addView(heading("Security"));
        Switch pairing = toggle("Require Bluetooth pairing (recommended)", Prefs.requirePairing(this));
        pairing.setOnCheckedChangeListener((b, on) -> {
            prefs.edit().putBoolean(Prefs.REQUIRE_PAIRING, on).apply();
            MainActivity.restartDisplayService(this);
        });
        list.addView(pairing);
        list.addView(note("Turn off only to diagnose connection problems: without pairing the link is not encrypted."));
        String id = DisplayStore.get().displayId();
        list.addView(note(id == null ? "Display ID unavailable" : "Display ID " + id
                + "\nOptional: set TOKENBEACON_DEVICE_ID to this value to make TokenBeacon use only this phone."));

        ScrollView scroll = new ScrollView(this);
        scroll.setBackgroundColor(BG);
        scroll.addView(list);
        setContentView(scroll);
    }

    private TextView heading(String text) {
        TextView view = new TextView(this);
        view.setText(text);
        view.setTextColor(TEXT);
        view.setTextSize(18);
        view.setPadding(0, dp(18), 0, dp(6));
        return view;
    }

    private TextView note(String text) {
        TextView view = new TextView(this);
        view.setText(text);
        view.setTextColor(MUTED);
        view.setTextSize(13);
        view.setPadding(0, dp(2), 0, dp(6));
        return view;
    }

    private Switch toggle(String text, boolean checked) {
        Switch view = new Switch(this);
        view.setText(text);
        view.setTextColor(TEXT);
        view.setChecked(checked);
        view.setPadding(0, dp(6), 0, dp(6));
        return view;
    }

    private int dp(int value) {
        return Math.round(value * getResources().getDisplayMetrics().density);
    }
}
