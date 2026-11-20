package dev.tokenbeacon.display;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.bluetooth.BluetoothAdapter;
import android.bluetooth.BluetoothDevice;
import android.bluetooth.BluetoothGatt;
import android.bluetooth.BluetoothGattCharacteristic;
import android.bluetooth.BluetoothGattDescriptor;
import android.bluetooth.BluetoothGattServer;
import android.bluetooth.BluetoothGattServerCallback;
import android.bluetooth.BluetoothGattService;
import android.bluetooth.BluetoothManager;
import android.bluetooth.BluetoothProfile;
import android.bluetooth.le.AdvertiseCallback;
import android.bluetooth.le.AdvertiseData;
import android.bluetooth.le.AdvertiseSettings;
import android.bluetooth.le.BluetoothLeAdvertiser;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.ParcelUuid;
import android.os.SystemClock;

import java.io.ByteArrayOutputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayDeque;
import java.util.Arrays;
import java.util.UUID;

/**
 * BLE peripheral (GATT server) that TokenBeacon on the Mac connects to.
 *
 *   RX    host -> phone   write (with response), device-state/v1 lines in chunks
 *   TX    phone -> host   notify, hello/alive/err lines in chunks
 *   AUTH  write a 32-byte challenge, then read the signed answer (Identity)
 *
 * Both need an encrypted, authenticated link by default, so the first
 * connection triggers the system pairing dialog (numeric comparison) on the
 * Mac and on the phone; afterwards the bonded Mac reconnects without prompts.
 * Advertising carries only the service UUID – no device name. One host at a
 * time; while it is connected the phone stops advertising.
 */
public final class DisplayService extends Service {
    static final UUID SERVICE_UUID = UUID.fromString("b3f2a6c0-4e1d-4c8a-9f0b-7d2e5a1c9e40");
    static final UUID RX_UUID = UUID.fromString("b3f2a6c0-4e1d-4c8a-9f0b-7d2e5a1c9e41");
    static final UUID TX_UUID = UUID.fromString("b3f2a6c0-4e1d-4c8a-9f0b-7d2e5a1c9e42");
    static final UUID AUTH_UUID = UUID.fromString("b3f2a6c0-4e1d-4c8a-9f0b-7d2e5a1c9e43");
    private static final UUID CCCD_UUID = UUID.fromString("00002902-0000-1000-8000-00805f9b34fb");

    static final String FIRMWARE = "android-0.1.0";
    private static final String CHANNEL_ID = "link";
    private static final long ALIVE_MS = 10_000;

    private final Handler main = new Handler(Looper.getMainLooper());
    private final DisplayStore store = DisplayStore.get();
    private final LineAssembler lines = new LineAssembler();
    private final ByteArrayOutputStream prepared = new ByteArrayOutputStream();
    private final ArrayDeque<byte[]> outbox = new ArrayDeque<>();

    private BluetoothManager manager;
    private BluetoothGattServer server;
    private BluetoothGattCharacteristic tx;
    private BluetoothLeAdvertiser advertiser;
    private boolean advertising;
    private BluetoothDevice host;
    private boolean subscribed;
    private boolean handshaken;
    private boolean sending;
    private int mtu = 23;
    private long lastSeq = -1;
    private long aliveSeq;
    private long startedAt;
    private Identity identity;
    /** Battery protection has stopped Bluetooth (PowerPolicy). */
    private boolean paused;
    /** Advertising mode currently in use; null when not advertising. */
    private Boolean advertisingLowPower;
    private byte[] authAnswer;

    private final Runnable aliveTask = new Runnable() {
        @Override
        public void run() {
            if (handshaken) send(Protocol.alive(aliveSeq++, (SystemClock.elapsedRealtime() - startedAt) / 1000));
            main.postDelayed(this, ALIVE_MS);
        }
    };

    private final BroadcastReceiver adapterReceiver = new BroadcastReceiver() {
        @Override
        public void onReceive(Context context, Intent intent) {
            int state = intent.getIntExtra(BluetoothAdapter.EXTRA_STATE, BluetoothAdapter.ERROR);
            if (state == BluetoothAdapter.STATE_ON) startPeripheral();
            else if (state == BluetoothAdapter.STATE_TURNING_OFF || state == BluetoothAdapter.STATE_OFF) stopPeripheral(DisplayStore.Link.BLUETOOTH_OFF);
        }
    };

    private final BroadcastReceiver batteryReceiver = new BroadcastReceiver() {
        @Override
        public void onReceive(Context context, Intent intent) {
            onBattery(intent);
        }
    };

    /** Settings changed in SettingsActivity (same process). Kept as a field: prefs hold listeners weakly. */
    private final android.content.SharedPreferences.OnSharedPreferenceChangeListener prefsListener = (prefs, key) -> applyPolicy();

    private PowerPolicy.Power power = new PowerPolicy.Power();

    @Override
    public void onCreate() {
        super.onCreate();
        startedAt = SystemClock.elapsedRealtime();
        try {
            identity = Identity.load();
            store.setDisplayId(identity.displayText());
        } catch (Exception e) {
            identity = null; // without a key the phone cannot prove its identity; TokenBeacon will ignore it
            store.setLastError("identity_unavailable");
        }
        manager = (BluetoothManager) getSystemService(Context.BLUETOOTH_SERVICE);
        startInForeground();
        registerReceiver(adapterReceiver, new IntentFilter(BluetoothAdapter.ACTION_STATE_CHANGED));
        Prefs.of(this).registerOnSharedPreferenceChangeListener(prefsListener);
        Intent battery = registerReceiver(batteryReceiver, new IntentFilter(Intent.ACTION_BATTERY_CHANGED));
        if (battery != null) onBattery(battery); // sticky: the current state right away
        main.postDelayed(aliveTask, ALIVE_MS);
        startPeripheral();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (server == null) startPeripheral();
        return START_STICKY;
    }

    @Override
    public void onDestroy() {
        main.removeCallbacksAndMessages(null);
        Prefs.of(this).unregisterOnSharedPreferenceChangeListener(prefsListener);
        for (BroadcastReceiver receiver : new BroadcastReceiver[] {adapterReceiver, batteryReceiver}) {
            try {
                unregisterReceiver(receiver);
            } catch (IllegalArgumentException ignored) {
                // not registered
            }
        }
        stopPeripheral(DisplayStore.Link.STOPPED);
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    // --- Peripheral lifecycle ------------------------------------------------

    private void startPeripheral() {
        if (server != null) return;
        if (!MainActivity.hasBluetoothPermissions(this)) {
            store.setLink(DisplayStore.Link.NO_PERMISSION);
            return;
        }
        BluetoothAdapter adapter = manager == null ? null : manager.getAdapter();
        if (adapter == null || !adapter.isEnabled()) {
            store.setLink(DisplayStore.Link.BLUETOOTH_OFF);
            return;
        }
        advertiser = adapter.getBluetoothLeAdvertiser();
        if (!adapter.isMultipleAdvertisementSupported() || advertiser == null) {
            store.setLink(DisplayStore.Link.UNSUPPORTED);
            return;
        }
        try {
            server = manager.openGattServer(this, callback);
        } catch (SecurityException e) {
            store.setLink(DisplayStore.Link.NO_PERMISSION);
            return;
        }
        if (server == null) {
            store.setLink(DisplayStore.Link.ADVERTISING_FAILED);
            return;
        }
        boolean secure = Prefs.requirePairing(this);
        int writePermission = secure ? BluetoothGattCharacteristic.PERMISSION_WRITE_ENCRYPTED_MITM : BluetoothGattCharacteristic.PERMISSION_WRITE;
        int readPermission = secure ? BluetoothGattCharacteristic.PERMISSION_READ_ENCRYPTED_MITM : BluetoothGattCharacteristic.PERMISSION_READ;
        BluetoothGattService service = new BluetoothGattService(SERVICE_UUID, BluetoothGattService.SERVICE_TYPE_PRIMARY);
        BluetoothGattCharacteristic rx = new BluetoothGattCharacteristic(RX_UUID,
                BluetoothGattCharacteristic.PROPERTY_WRITE, writePermission);
        tx = new BluetoothGattCharacteristic(TX_UUID, BluetoothGattCharacteristic.PROPERTY_NOTIFY, readPermission);
        tx.addDescriptor(new BluetoothGattDescriptor(CCCD_UUID,
                (secure ? BluetoothGattDescriptor.PERMISSION_READ_ENCRYPTED_MITM | BluetoothGattDescriptor.PERMISSION_WRITE_ENCRYPTED_MITM
                        : BluetoothGattDescriptor.PERMISSION_READ | BluetoothGattDescriptor.PERMISSION_WRITE)));
        BluetoothGattCharacteristic auth = new BluetoothGattCharacteristic(AUTH_UUID,
                BluetoothGattCharacteristic.PROPERTY_WRITE | BluetoothGattCharacteristic.PROPERTY_READ, writePermission | readPermission);
        service.addCharacteristic(rx);
        service.addCharacteristic(tx);
        service.addCharacteristic(auth);
        server.addService(service); // advertising starts in onServiceAdded
    }

    private void stopPeripheral(DisplayStore.Link reason) {
        stopAdvertising();
        if (server != null) {
            try {
                if (host != null) server.cancelConnection(host);
                server.close();
            } catch (SecurityException ignored) {
                // permission revoked meanwhile
            }
        }
        server = null;
        clearHost();
        store.setLink(reason);
    }

    // --- Power policy ----------------------------------------------------------

    private void onBattery(Intent intent) {
        PowerPolicy.Power next = new PowerPolicy.Power();
        next.plugged = intent.getIntExtra(android.os.BatteryManager.EXTRA_PLUGGED, 0) != 0;
        int level = intent.getIntExtra(android.os.BatteryManager.EXTRA_LEVEL, -1);
        int scale = intent.getIntExtra(android.os.BatteryManager.EXTRA_SCALE, -1);
        next.level = level >= 0 && scale > 0 ? Math.round(level * 100f / scale) : -1;
        int temperature = intent.getIntExtra(android.os.BatteryManager.EXTRA_TEMPERATURE, Integer.MIN_VALUE);
        next.temperatureTenths = temperature;
        power = next;
        applyPolicy();
    }

    /** Applies settings and battery state: pause/resume Bluetooth and the advertising mode. */
    private void applyPolicy() {
        PowerPolicy.Profile profile = PowerPolicy.decide(Prefs.load(this), power, paused);
        store.setPower(power, profile);
        if (profile.paused && !paused) {
            paused = true;
            stopAdvertising();
            if (server != null && host != null) {
                try {
                    server.cancelConnection(host);
                } catch (SecurityException ignored) {
                    // permission revoked meanwhile
                }
            }
            store.setLink(DisplayStore.Link.PAUSED_LOW_BATTERY);
        } else if (!profile.paused && paused) {
            paused = false;
            if (server != null && host == null) {
                store.setLink(DisplayStore.Link.WAITING);
                startAdvertising();
            }
        } else if (advertising && advertisingLowPower != null && advertisingLowPower != profile.lowPowerAdvertising) {
            stopAdvertising(); // switch between Desk and Portable advertising
            startAdvertising();
        }
    }

    private void startAdvertising() {
        if (advertising || paused || advertiser == null || server == null) return;
        boolean lowPower = store.profile().lowPowerAdvertising;
        AdvertiseSettings settings = new AdvertiseSettings.Builder()
                // Portable: about once a second (slower reconnect, less battery); Desk: about 4× a second.
                .setAdvertiseMode(lowPower ? AdvertiseSettings.ADVERTISE_MODE_LOW_POWER : AdvertiseSettings.ADVERTISE_MODE_BALANCED)
                .setTxPowerLevel(AdvertiseSettings.ADVERTISE_TX_POWER_MEDIUM)
                .setConnectable(true)
                .setTimeout(0)
                .build();
        AdvertiseData data = new AdvertiseData.Builder()
                .addServiceUuid(new ParcelUuid(SERVICE_UUID))
                .setIncludeDeviceName(false)
                .setIncludeTxPowerLevel(false)
                .build();
        try {
            advertiser.startAdvertising(settings, data, advertiseCallback);
            advertising = true;
            advertisingLowPower = lowPower;
        } catch (SecurityException e) {
            store.setLink(DisplayStore.Link.NO_PERMISSION);
        }
    }

    private void stopAdvertising() {
        if (!advertising || advertiser == null) return;
        try {
            advertiser.stopAdvertising(advertiseCallback);
        } catch (SecurityException | IllegalStateException ignored) {
            // adapter already off
        }
        advertising = false;
        advertisingLowPower = null;
    }

    private final AdvertiseCallback advertiseCallback = new AdvertiseCallback() {
        @Override
        public void onStartSuccess(AdvertiseSettings settingsInEffect) {
            if (host == null && !paused) store.setLink(DisplayStore.Link.WAITING);
        }

        @Override
        public void onStartFailure(int errorCode) {
            advertising = false;
            store.setLastError("advertise_" + errorCode);
            store.setLink(errorCode == ADVERTISE_FAILED_FEATURE_UNSUPPORTED ? DisplayStore.Link.UNSUPPORTED : DisplayStore.Link.ADVERTISING_FAILED);
        }
    };

    private void clearHost() {
        host = null;
        subscribed = false;
        handshaken = false;
        sending = false;
        outbox.clear();
        lines.reset();
        prepared.reset();
        authAnswer = null;
        mtu = 23;
    }

    // --- GATT server callbacks (binder thread -> main thread) --------------

    private final BluetoothGattServerCallback callback = new BluetoothGattServerCallback() {
        @Override
        public void onServiceAdded(int status, BluetoothGattService service) {
            main.post(() -> {
                if (status == BluetoothGatt.GATT_SUCCESS) startAdvertising();
                else store.setLink(DisplayStore.Link.ADVERTISING_FAILED);
            });
        }

        @Override
        public void onConnectionStateChange(BluetoothDevice device, int status, int newState) {
            main.post(() -> onConnection(device, newState));
        }

        @Override
        public void onMtuChanged(BluetoothDevice device, int value) {
            main.post(() -> {
                if (device.equals(host)) mtu = Math.max(23, Math.min(value, 517));
            });
        }

        @Override
        public void onCharacteristicWriteRequest(BluetoothDevice device, int requestId, BluetoothGattCharacteristic characteristic,
                boolean preparedWrite, boolean responseNeeded, int offset, byte[] value) {
            if (AUTH_UUID.equals(characteristic.getUuid())) {
                byte[] challenge = value == null || preparedWrite || offset != 0 ? null : Arrays.copyOf(value, value.length);
                respond(device, requestId, responseNeeded,
                        challenge != null && challenge.length == Identity.CHALLENGE_BYTES ? BluetoothGatt.GATT_SUCCESS : BluetoothGatt.GATT_INVALID_ATTRIBUTE_LENGTH, offset, value);
                main.post(() -> {
                    if (device.equals(host)) authAnswer = identity == null ? null : identity.answer(challenge);
                });
                return;
            }
            boolean accepted = RX_UUID.equals(characteristic.getUuid()) && value != null;
            respond(device, requestId, responseNeeded, accepted ? BluetoothGatt.GATT_SUCCESS : BluetoothGatt.GATT_WRITE_NOT_PERMITTED, offset, value);
            if (!accepted) return;
            byte[] copy = Arrays.copyOf(value, value.length);
            main.post(() -> {
                if (!device.equals(host)) return;
                if (preparedWrite) {
                    if (prepared.size() + copy.length <= Protocol.MAX_LINE_BYTES) prepared.write(copy, 0, copy.length);
                } else {
                    onBytes(copy);
                }
            });
        }

        @Override
        public void onCharacteristicReadRequest(BluetoothDevice device, int requestId, int offset, BluetoothGattCharacteristic characteristic) {
            // The answer is computed on the main thread; reads come in after the write's response.
            main.post(() -> {
                byte[] answer = device.equals(host) && AUTH_UUID.equals(characteristic.getUuid()) ? authAnswer : null;
                if (answer == null) {
                    respond(device, requestId, true, BluetoothGatt.GATT_READ_NOT_PERMITTED, offset, null);
                } else if (offset > answer.length) {
                    respond(device, requestId, true, BluetoothGatt.GATT_INVALID_OFFSET, offset, null);
                } else {
                    respond(device, requestId, true, BluetoothGatt.GATT_SUCCESS, offset, Arrays.copyOfRange(answer, offset, answer.length));
                }
            });
        }

        @Override
        public void onExecuteWrite(BluetoothDevice device, int requestId, boolean execute) {
            respond(device, requestId, true, BluetoothGatt.GATT_SUCCESS, 0, null);
            main.post(() -> {
                if (!device.equals(host)) return;
                byte[] data = prepared.toByteArray();
                prepared.reset();
                if (execute) onBytes(data);
            });
        }

        @Override
        public void onDescriptorWriteRequest(BluetoothDevice device, int requestId, BluetoothGattDescriptor descriptor,
                boolean preparedWrite, boolean responseNeeded, int offset, byte[] value) {
            boolean ok = CCCD_UUID.equals(descriptor.getUuid()) && value != null && value.length == 2;
            respond(device, requestId, responseNeeded, ok ? BluetoothGatt.GATT_SUCCESS : BluetoothGatt.GATT_REQUEST_NOT_SUPPORTED, offset, value);
            if (!ok) return;
            boolean on = Arrays.equals(value, BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE);
            main.post(() -> {
                if (device.equals(host)) subscribed = on;
            });
        }

        @Override
        public void onDescriptorReadRequest(BluetoothDevice device, int requestId, int offset, BluetoothGattDescriptor descriptor) {
            byte[] value = subscribed && device.equals(host)
                    ? BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE : BluetoothGattDescriptor.DISABLE_NOTIFICATION_VALUE;
            respond(device, requestId, true, BluetoothGatt.GATT_SUCCESS, 0, value);
        }

        @Override
        public void onNotificationSent(BluetoothDevice device, int status) {
            main.post(() -> {
                sending = false;
                if (status == BluetoothGatt.GATT_SUCCESS) pump();
                else outbox.clear();
            });
        }
    };

    private void respond(BluetoothDevice device, int requestId, boolean needed, int status, int offset, byte[] value) {
        if (!needed || server == null) return;
        try {
            server.sendResponse(device, requestId, status, offset, value);
        } catch (SecurityException ignored) {
            // permission revoked meanwhile
        }
    }

    private void onConnection(BluetoothDevice device, int newState) {
        if (server == null) return;
        if (newState == BluetoothProfile.STATE_CONNECTED) {
            if (paused || (host != null && !host.equals(device))) {
                // One host at a time, and none while paused for the battery.
                try {
                    server.cancelConnection(device);
                } catch (SecurityException ignored) {
                    // ignore
                }
                return;
            }
            clearHost();
            host = device;
            lastSeq = -1;
            stopAdvertising();
            store.setLink(DisplayStore.Link.HANDSHAKE);
        } else if (newState == BluetoothProfile.STATE_DISCONNECTED && device.equals(host)) {
            clearHost();
            if (paused) return;
            store.setLink(DisplayStore.Link.WAITING);
            startAdvertising(); // the Mac finds the phone again by the service UUID
        }
    }

    // --- Protocol -------------------------------------------------------------

    private void onBytes(byte[] data) {
        for (String line : lines.push(data)) {
            if (line == null) {
                reportError("line_too_long");
                continue;
            }
            Protocol.Result result = Protocol.parseHostLine(line);
            if (result.error != null) {
                reportError(result.error);
            } else if (result.message instanceof Protocol.HostHello) {
                handshaken = true;
                lastSeq = -1;
                if (identity == null) {
                    reportError("identity_unavailable");
                    continue;
                }
                send(Protocol.hello(FIRMWARE, ((Protocol.HostHello) result.message).nonce, identity.id()));
                store.setLink(DisplayStore.Link.CONNECTED);
            } else if (result.message instanceof Protocol.State && handshaken) {
                Protocol.State state = (Protocol.State) result.message;
                if (state.seq <= lastSeq) continue; // older or duplicate
                lastSeq = state.seq;
                store.setState(state, SystemClock.elapsedRealtime());
            }
        }
    }

    private void reportError(String code) {
        store.setLastError(code);
        if (handshaken) send(Protocol.error(code));
    }

    /** Queues a line as notification chunks of at most MTU - 3 bytes. */
    private void send(String line) {
        if (server == null || host == null || !subscribed) return;
        byte[] bytes = line.getBytes(StandardCharsets.UTF_8);
        int size = Math.max(20, mtu - 3);
        for (int i = 0; i < bytes.length; i += size) outbox.add(Arrays.copyOfRange(bytes, i, Math.min(bytes.length, i + size)));
        if (outbox.size() > 64) outbox.clear(); // a host that stopped reading
        pump();
    }

    private void pump() {
        if (sending || outbox.isEmpty() || server == null || host == null) return;
        byte[] chunk = outbox.poll();
        tx.setValue(chunk);
        try {
            sending = server.notifyCharacteristicChanged(host, tx, false);
        } catch (SecurityException e) {
            sending = false;
        }
        if (!sending) outbox.clear();
    }

    // --- Helpers ----------------------------------------------------------------

    private void startInForeground() {
        NotificationManager notifications = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        notifications.createNotificationChannel(new NotificationChannel(CHANNEL_ID, "Display link", NotificationManager.IMPORTANCE_LOW));
        PendingIntent open = PendingIntent.getActivity(this, 0, new Intent(this, MainActivity.class), PendingIntent.FLAG_IMMUTABLE);
        Notification notification = new Notification.Builder(this, CHANNEL_ID)
                .setSmallIcon(android.R.drawable.stat_sys_data_bluetooth)
                .setContentTitle("TokenBeacon Display")
                .setContentText("Waiting for TokenBeacon over Bluetooth")
                .setContentIntent(open)
                .setOngoing(true)
                .build();
        if (Build.VERSION.SDK_INT >= 29) {
            startForeground(1, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE);
        } else {
            startForeground(1, notification);
        }
    }
}
