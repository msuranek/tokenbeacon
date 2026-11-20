/** A USB serial port that looks like a TokenBeacon display (before the handshake). */
export interface DeviceCandidate {
  /** Stable key for this port during one run (port name). */
  id: string;
  /** Port to open: /dev/cu.* on macOS, COMn on Windows. Never shown in the API. */
  port: string;
  /** USB serial number, when the system reports one. */
  serial: string | null;
}

export interface DeviceConnection {
  write(line: string): Promise<void>;
  close(): void;
  onLine(listener: (line: string) => void): void;
  onClose(listener: () => void): void;
}

export interface DeviceTransport {
  /** Lists only ports that identify as a TokenBeacon display, or the one port the user named. */
  discover(): Promise<DeviceCandidate[]>;
  open(candidate: DeviceCandidate): Promise<DeviceConnection>;
  dispose(): void;
}

export type TransportErrorCode =
  | "busy"
  | "not_found"
  | "open_failed"
  | "discover_failed"
  | "unsupported"
  // Bluetooth display only:
  | "bluetooth_off"
  | "bluetooth_unauthorized"
  | "bluetooth_unavailable"
  | "helper_unavailable"
  /** The phone did not prove it is the paired display. */
  | "untrusted"
  /** Another phone than TOKENBEACON_DEVICE_ID (selection, not authentication). */
  | "not_selected"
  /** No phone is paired yet (`npm run ble:pair`). */
  | "not_paired"
  /** The saved pairing is damaged; nothing is trusted. */
  | "pairing_unreadable";

export class TransportError extends Error {
  readonly code: TransportErrorCode;

  constructor(code: TransportErrorCode) {
    super(code);
    this.code = code;
    this.name = "TransportError";
  }
}

/** USB vendor ID of Espressif; the display firmware keeps it. */
export const ESPRESSIF_VID = 0x303a;
/** USB product name the TokenBeacon display firmware reports. */
export const DISPLAY_PRODUCT_NAME = "TokenBeacon Display";
