import { PairingStore, PairingUnreadableError, type PresentedIdentity } from "./ble-trust.ts";
import { TransportError, type DeviceCandidate } from "./transport.ts";

/**
 * `npm run ble:pair`: the only way a phone becomes trusted.
 *
 * TokenBeacon cannot tell from macOS whether a Bluetooth link is encrypted,
 * so it never trusts the first phone that answers. Instead the user types the
 * display ID shown on their own phone; only a phone that proves it holds the
 * key behind exactly that ID (64-bit fingerprint) is paired. The full ID is
 * required: a short code could be matched by a crafted key.
 */

export interface PairingTransport {
  scan(): Promise<DeviceCandidate[]>;
  identify(candidate: DeviceCandidate): Promise<PresentedIdentity>;
  dispose(): void;
}

export interface PairOptions {
  transport: PairingTransport;
  store: PairingStore;
  ask: (question: string) => Promise<string>;
  print: (line: string) => void;
  /** TOKENBEACON_DEVICE_ID: only this phone is offered (selection only). */
  deviceId?: string | null;
  scanAttempts?: number;
}

export type PairResult = "paired" | "already_paired" | "none_found" | "cancelled" | "mismatch" | "failed";

const BLUETOOTH_HINTS: Partial<Record<string, string>> = {
  bluetooth_off: "Bluetooth is off on this Mac. Turn it on and try again.",
  bluetooth_unauthorized:
    "TokenBeacon BLE may not use Bluetooth. Allow it in System Settings → Privacy & Security → Bluetooth, then try again.",
  bluetooth_unavailable: "Bluetooth is not ready yet. If macOS asks whether TokenBeacon BLE may use Bluetooth, allow it and try again.",
  helper_unavailable: "The Bluetooth helper is not available. Install the Xcode Command Line Tools (`xcode-select --install`) and try again.",
  unsupported: "This Mac does not support Bluetooth Low Energy.",
};

export function normalizeDisplayId(text: string): string {
  return text.replace(/[\s-]+/g, "").toLowerCase();
}

export function formatDisplayId(id: string): string {
  return id.match(/.{1,4}/g)?.join(" ") ?? id;
}

export async function pairBluetoothDisplay(options: PairOptions): Promise<PairResult> {
  const { transport, store, ask, print } = options;
  try {
    let existing;
    try {
      existing = store.load();
    } catch (error) {
      if (!(error instanceof PairingUnreadableError)) throw error;
      print("The saved pairing is damaged. Run `npm run ble:unpair` first.");
      return "failed";
    }
    if (existing) {
      print(`A phone is already paired (display ID ${formatDisplayId(existing.id)}).`);
      print("To pair another phone, run `npm run ble:unpair` first.");
      return "already_paired";
    }

    print("Open the TokenBeacon Display app on the phone and keep it on screen.");
    print("Looking for the phone over Bluetooth…");
    const found = new Map<string, PresentedIdentity>();
    for (let attempt = 0; attempt < (options.scanAttempts ?? 4) && found.size === 0; attempt += 1) {
      let candidates: DeviceCandidate[];
      try {
        candidates = await transport.scan();
      } catch (error) {
        const code = error instanceof TransportError ? error.code : "discover_failed";
        if (code === "bluetooth_unavailable" && attempt + 1 < (options.scanAttempts ?? 4)) {
          await new Promise((resolve) => setTimeout(resolve, 3_000)); // the permission dialog may be open
          continue;
        }
        print(BLUETOOTH_HINTS[code] ?? `Bluetooth search failed (${code}).`);
        return "failed";
      }
      for (const candidate of candidates.slice(0, 8)) {
        print("Found a phone. If macOS or the phone asks to pair, check that both show the same number and confirm.");
        try {
          const presented = await transport.identify(candidate);
          if (!options.deviceId || presented.id === options.deviceId) found.set(presented.id, presented);
        } catch {
          print("A phone did not prove its identity and is skipped.");
        }
      }
    }
    if (found.size === 0) {
      print("No TokenBeacon Display phone was found. Check that Bluetooth is on and the app is open, then try again.");
      return "none_found";
    }

    print(found.size === 1 ? "Found 1 phone." : `Found ${found.size} phones.`);
    const answer = await ask("Type the display ID shown on your phone (16 characters, spaces optional), or press Enter to cancel: ");
    const typed = normalizeDisplayId(answer);
    if (!typed) {
      print("Cancelled. Nothing was paired.");
      return "cancelled";
    }
    const match = found.get(typed);
    if (!match) {
      print("No phone nearby has this display ID. Nothing was paired; check the ID on the phone and try again.");
      return "mismatch";
    }
    store.save(match);
    print(`Paired with display ID ${formatDisplayId(match.id)}.`);
    print("TokenBeacon with TOKENBEACON_DEVICE=ble now uses this phone and checks its key on every connection.");
    return "paired";
  } finally {
    transport.dispose();
  }
}
