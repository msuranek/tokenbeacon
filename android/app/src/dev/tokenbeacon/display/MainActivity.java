package dev.tokenbeacon.display;

import android.Manifest;
import android.app.Activity;
import android.bluetooth.BluetoothAdapter;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Paint;
import android.graphics.RectF;
import android.graphics.Typeface;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.view.Gravity;
import android.view.View;
import android.view.WindowManager;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.Switch;
import android.widget.TextView;

/** Full-screen dashboard: 5h limit, weekly limit, context and link state. */
public final class MainActivity extends Activity {
    private static final int BG = Color.rgb(14, 16, 20);
    private static final int TEXT = Color.rgb(236, 238, 242);
    private static final int MUTED = Color.rgb(140, 146, 158);
    private static final int GOOD = Color.rgb(64, 196, 120);
    private static final int WARN = Color.rgb(240, 176, 48);
    private static final int BAD = Color.rgb(236, 80, 72);
    private static final int ACCENT = Color.rgb(96, 150, 255);
    private static final int REQUEST_PERMISSIONS = 1;
    private static final int REQUEST_ENABLE_BT = 2;

    private final Handler main = new Handler(Looper.getMainLooper());
    private final DisplayStore store = DisplayStore.get();
    private TextView linkText;
    private View linkDot;
    private MetricView five;
    private MetricView week;
    private MetricView context;
    private TextView footer;
    private Button action;

    private final Runnable listener = this::render;
    private final Runnable ticker = new Runnable() {
        @Override
        public void run() {
            render();
            main.postDelayed(this, 1000);
        }
    };

    static boolean hasBluetoothPermissions(Context context) {
        if (Build.VERSION.SDK_INT < 31) return true; // install-time permissions
        return context.checkSelfPermission(Manifest.permission.BLUETOOTH_ADVERTISE) == PackageManager.PERMISSION_GRANTED
                && context.checkSelfPermission(Manifest.permission.BLUETOOTH_CONNECT) == PackageManager.PERMISSION_GRANTED;
    }

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        setContentView(buildLayout());
        if (hasBluetoothPermissions(this)) {
            startDisplayService();
        } else {
            requestPermissions(new String[] {Manifest.permission.BLUETOOTH_ADVERTISE, Manifest.permission.BLUETOOTH_CONNECT}, REQUEST_PERMISSIONS);
        }
    }

    @Override
    protected void onResume() {
        super.onResume();
        store.addListener(listener);
        main.post(ticker);
    }

    @Override
    protected void onPause() {
        store.removeListener(listener);
        main.removeCallbacks(ticker);
        super.onPause();
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] results) {
        if (requestCode == REQUEST_PERMISSIONS && hasBluetoothPermissions(this)) startDisplayService();
        render();
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        if (requestCode == REQUEST_ENABLE_BT) startDisplayService();
    }

    private void startDisplayService() {
        startForegroundService(new Intent(this, DisplayService.class));
    }

    private void restartDisplayService() {
        stopService(new Intent(this, DisplayService.class));
        main.postDelayed(this::startDisplayService, 500);
    }

    // --- Layout ---------------------------------------------------------------

    private View buildLayout() {
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setBackgroundColor(BG);
        int pad = dp(20);
        root.setPadding(pad, dp(28), pad, pad);

        LinearLayout header = new LinearLayout(this);
        header.setGravity(Gravity.CENTER_VERTICAL);
        linkDot = new View(this);
        header.addView(linkDot, new LinearLayout.LayoutParams(dp(12), dp(12)));
        linkText = text(16, TEXT);
        linkText.setPadding(dp(10), 0, 0, 0);
        header.addView(linkText, new LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1));
        TextView title = text(13, MUTED);
        title.setText("TokenBeacon");
        header.addView(title);
        root.addView(header);

        five = new MetricView(this, "5H LIMIT");
        week = new MetricView(this, "WEEKLY LIMIT");
        context = new MetricView(this, "CONTEXT");
        for (MetricView view : new MetricView[] {five, week, context}) {
            LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, 0, 1);
            params.topMargin = dp(16);
            root.addView(view, params);
        }

        action = new Button(this);
        action.setVisibility(View.GONE);
        root.addView(action);

        Switch pairing = new Switch(this);
        pairing.setText("Require Bluetooth pairing (recommended)");
        pairing.setTextColor(MUTED);
        pairing.setChecked(getSharedPreferences(DisplayService.PREFS, MODE_PRIVATE).getBoolean(DisplayService.PREF_REQUIRE_PAIRING, true));
        pairing.setOnCheckedChangeListener((button, checked) -> {
            getSharedPreferences(DisplayService.PREFS, MODE_PRIVATE).edit().putBoolean(DisplayService.PREF_REQUIRE_PAIRING, checked).apply();
            restartDisplayService();
        });
        root.addView(pairing);

        footer = text(12, MUTED);
        root.addView(footer);
        render();
        return root;
    }

    private TextView text(int sp, int color) {
        TextView view = new TextView(this);
        view.setTextSize(sp);
        view.setTextColor(color);
        return view;
    }

    private int dp(int value) {
        return Math.round(value * getResources().getDisplayMetrics().density);
    }

    // --- Rendering --------------------------------------------------------------

    private void render() {
        if (linkText == null) return;
        Protocol.State state = store.state();
        long sinceMs = state == null ? 0 : SystemClock.elapsedRealtime() - store.stateAtMs();
        DisplayFormat.Freshness fresh = DisplayFormat.freshness(state, sinceMs);
        DisplayStore.Link link = store.link();

        String label;
        int dot;
        switch (link) {
            case BLUETOOTH_OFF: label = "Bluetooth is off"; dot = BAD; break;
            case NO_PERMISSION: label = "Bluetooth permission needed"; dot = BAD; break;
            case UNSUPPORTED: label = "This phone cannot act as a BLE display"; dot = BAD; break;
            case ADVERTISING_FAILED: label = "Bluetooth advertising failed"; dot = BAD; break;
            case WAITING: label = "Waiting for TokenBeacon…"; dot = WARN; break;
            case HANDSHAKE: label = "Connecting…"; dot = WARN; break;
            case CONNECTED:
                label = fresh == DisplayFormat.Freshness.LIVE ? "Connected · live"
                        : fresh == DisplayFormat.Freshness.NONE ? "Connected · waiting for data" : "Connected · no recent data";
                dot = fresh == DisplayFormat.Freshness.LIVE ? GOOD : WARN;
                break;
            default: label = "Starting…"; dot = MUTED; break;
        }
        if (link != DisplayStore.Link.CONNECTED && state != null) label += " · data " + DisplayFormat.duration(sinceMs / 1000) + " old";
        linkText.setText(label);
        linkDot.setBackgroundColor(dot);

        boolean dim = fresh == DisplayFormat.Freshness.OFFLINE;
        long since = sinceMs / 1000;
        if (state == null) {
            DisplayFormat.Metric waiting = new DisplayFormat.Metric();
            waiting.value = "—";
            waiting.note = "no data yet";
            five.show(waiting, false);
            week.show(waiting, false);
            context.show(waiting, false);
        } else {
            five.show(DisplayFormat.limit(state.five, since), dim);
            week.show(DisplayFormat.limit(state.week, since), dim);
            context.show(DisplayFormat.context(state.ctx, since), dim);
        }

        if (link == DisplayStore.Link.BLUETOOTH_OFF) {
            action.setText("Turn on Bluetooth");
            action.setOnClickListener(v -> startActivityForResult(new Intent(BluetoothAdapter.ACTION_REQUEST_ENABLE), REQUEST_ENABLE_BT));
            action.setVisibility(View.VISIBLE);
        } else if (link == DisplayStore.Link.NO_PERMISSION) {
            action.setText("Allow Bluetooth");
            action.setOnClickListener(v -> requestPermissions(
                    new String[] {Manifest.permission.BLUETOOTH_ADVERTISE, Manifest.permission.BLUETOOTH_CONNECT}, REQUEST_PERMISSIONS));
            action.setVisibility(View.VISIBLE);
        } else {
            action.setVisibility(View.GONE);
        }

        String error = store.lastError();
        String id = store.displayId();
        footer.setText((id == null ? "" : "Display ID " + id + "\n") + DisplayService.FIRMWARE + " · protocol 1"
                + (error == null ? "" : " · last error " + error));
    }

    private static int levelColor(DisplayFormat.Level level) {
        switch (level) {
            case GOOD: return GOOD;
            case WARN: return WARN;
            case BAD: return BAD;
            case ACCENT: return ACCENT;
            default: return MUTED;
        }
    }

    /** Label + tag, big number with unit, bar and a footnote. */
    private static final class MetricView extends View {
        private final String label;
        private final Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG);
        private final RectF rect = new RectF();
        private DisplayFormat.Metric metric;
        private boolean dim;

        MetricView(Context context, String label) {
            super(context);
            this.label = label;
        }

        void show(DisplayFormat.Metric value, boolean dimmed) {
            metric = value;
            dim = dimmed;
            invalidate();
        }

        @Override
        protected void onDraw(Canvas canvas) {
            if (metric == null) return;
            float d = getResources().getDisplayMetrics().density;
            float w = getWidth();
            float h = getHeight();
            int alpha = dim ? 110 : 255;

            paint.setTypeface(Typeface.DEFAULT_BOLD);
            paint.setTextSize(14 * d);
            paint.setColor(MUTED);
            paint.setAlpha(alpha);
            paint.setTextAlign(Paint.Align.LEFT);
            canvas.drawText(label, 0, 16 * d, paint);
            paint.setTextAlign(Paint.Align.RIGHT);
            canvas.drawText(metric.tag, w, 16 * d, paint);

            float big = Math.min(h * 0.42f, 72 * d);
            float baseline = 20 * d + big;
            paint.setTextAlign(Paint.Align.LEFT);
            paint.setTextSize(big);
            paint.setColor(metric.level == DisplayFormat.Level.WARN && metric.bar < 0 ? WARN : metric.bar < 0 ? MUTED : TEXT);
            paint.setAlpha(alpha);
            canvas.drawText(metric.value, 0, baseline, paint);
            float valueWidth = paint.measureText(metric.value);
            paint.setTypeface(Typeface.DEFAULT);
            paint.setTextSize(18 * d);
            paint.setColor(MUTED);
            paint.setAlpha(alpha);
            canvas.drawText(metric.unit, valueWidth + 8 * d, baseline, paint);

            float barTop = baseline + 12 * d;
            if (metric.bar >= 0) {
                rect.set(0, barTop, w, barTop + 10 * d);
                paint.setColor(Color.rgb(40, 44, 52));
                paint.setAlpha(255);
                canvas.drawRoundRect(rect, 5 * d, 5 * d, paint);
                rect.set(0, barTop, w * metric.bar / 100f, barTop + 10 * d);
                paint.setColor(levelColor(metric.level));
                paint.setAlpha(alpha);
                canvas.drawRoundRect(rect, 5 * d, 5 * d, paint);
            }
            paint.setTextSize(14 * d);
            paint.setColor(MUTED);
            paint.setAlpha(alpha);
            canvas.drawText(metric.note, 0, barTop + 32 * d, paint);
        }
    }
}
