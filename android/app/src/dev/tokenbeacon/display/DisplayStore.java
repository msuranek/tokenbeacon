package dev.tokenbeacon.display;

import java.util.concurrent.CopyOnWriteArrayList;

/**
 * What the screen shows, shared by the service and the activity (same process,
 * main thread only). Ages and countdowns advance from the moment a state
 * arrived, using the phone's monotonic clock – the host sends no wall times.
 */
final class DisplayStore {
    enum Link {
        /** Service not running yet. */
        STOPPED,
        BLUETOOTH_OFF,
        NO_PERMISSION,
        /** This phone cannot advertise as a BLE peripheral. */
        UNSUPPORTED,
        ADVERTISING_FAILED,
        /** Advertising, waiting for TokenBeacon to connect. */
        WAITING,
        /** A Mac is connected but has not completed the handshake. */
        HANDSHAKE,
        CONNECTED
    }

    /** Data older than this is shown as stale, then as no connection (same as the ESP32). */
    static final long STALE_MS = 30_000;
    static final long OFFLINE_MS = 120_000;

    private static final DisplayStore INSTANCE = new DisplayStore();

    static DisplayStore get() {
        return INSTANCE;
    }

    private final CopyOnWriteArrayList<Runnable> listeners = new CopyOnWriteArrayList<>();
    private Link link = Link.STOPPED;
    private Protocol.State state;
    private long stateAtMs;
    private String lastError;
    private String displayId;

    Link link() {
        return link;
    }

    Protocol.State state() {
        return state;
    }

    /** Elapsed-realtime when the shown state arrived. */
    long stateAtMs() {
        return stateAtMs;
    }

    String lastError() {
        return lastError;
    }

    /** The display ID (from the identity key) as shown to the user. */
    String displayId() {
        return displayId;
    }

    void setDisplayId(String value) {
        displayId = value;
        notifyListeners();
    }

    void setLink(Link value) {
        if (link == value) return;
        link = value;
        notifyListeners();
    }

    void setState(Protocol.State value, long nowMs) {
        state = value;
        stateAtMs = nowMs;
        notifyListeners();
    }

    void setLastError(String code) {
        lastError = code;
        notifyListeners();
    }

    void addListener(Runnable listener) {
        listeners.add(listener);
    }

    void removeListener(Runnable listener) {
        listeners.remove(listener);
    }

    private void notifyListeners() {
        for (Runnable listener : listeners) listener.run();
    }
}
