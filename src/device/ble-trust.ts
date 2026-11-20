import { createHash, createPublicKey, randomBytes, verify, type KeyObject } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Identity of a Bluetooth display (the TokenBeacon Display Android app).
 *
 * The phone keeps an ECDSA P-256 key in the Android Keystore that cannot be
 * exported. Its display ID is derived from the public key. On every
 * connection TokenBeacon sends a fresh random challenge and the phone signs
 * it. The first phone that does so over an encrypted, authenticated (paired)
 * Bluetooth link is remembered by its public key – no secret is stored on the
 * Mac. Every later connection, including automatic reconnects, is accepted
 * only from a phone that proves it holds that same key.
 *
 * TOKENBEACON_DEVICE_ID only selects which phone to use; it proves nothing.
 */

export const AUTH_CONTEXT = Buffer.from("tokenbeacon-ble-auth/v1\n", "utf8");
export const CHALLENGE_BYTES = 32;
export const DISPLAY_ID = /^[0-9a-f]{16}$/;
const MAX_SPKI_BYTES = 256;
const MAX_SIGNATURE_BYTES = 80;

export function makeChallenge(): Buffer {
  return randomBytes(CHALLENGE_BYTES);
}

/** First 16 hex digits of SHA-256 over the public key (SPKI DER). Shown in the phone app. */
export function displayId(spki: Buffer): string {
  return createHash("sha256").update(spki).digest("hex").slice(0, 16);
}

export interface PresentedIdentity {
  id: string;
  /** SPKI DER of the phone's public key. */
  publicKey: Buffer;
}

/**
 * Checks the phone's answer: [u16 big-endian key length][SPKI DER][ECDSA signature DER]
 * over AUTH_CONTEXT + challenge. Only P-256 keys are accepted.
 */
export function verifyAuthResponse(challenge: Buffer, response: Buffer): PresentedIdentity | null {
  if (challenge.length !== CHALLENGE_BYTES || response.length < 2) return null;
  const keyLength = response.readUInt16BE(0);
  if (keyLength < 1 || keyLength > MAX_SPKI_BYTES || response.length <= 2 + keyLength) return null;
  const spki = response.subarray(2, 2 + keyLength);
  const signature = response.subarray(2 + keyLength);
  if (signature.length > MAX_SIGNATURE_BYTES) return null;
  const key = p256Key(spki);
  if (!key) return null;
  try {
    const ok = verify("sha256", Buffer.concat([AUTH_CONTEXT, challenge]), { key, dsaEncoding: "der" }, signature);
    return ok ? { id: displayId(spki), publicKey: Buffer.from(spki) } : null;
  } catch {
    return null;
  }
}

function p256Key(spki: Buffer): KeyObject | null {
  try {
    const key = createPublicKey({ key: spki, format: "der", type: "spki" });
    return key.asymmetricKeyType === "ec" && key.asymmetricKeyDetails?.namedCurve === "prime256v1" ? key : null;
  } catch {
    return null;
  }
}

export interface PairedDisplay {
  id: string;
  publicKey: Buffer;
  pairedAt: string;
}

export type TrustDecision = "trusted" | "pair" | "untrusted" | "not_selected";

/**
 * - not_selected: TOKENBEACON_DEVICE_ID names another phone (selection only);
 * - trusted:      the same key as the paired phone;
 * - pair:         nothing paired yet – remember this phone;
 * - untrusted:    a phone is paired and this is a different key.
 */
export function decideTrust(paired: PairedDisplay | null, presented: PresentedIdentity, selectedId: string | null): TrustDecision {
  if (selectedId !== null && presented.id !== selectedId) return "not_selected";
  if (!paired) return "pair";
  return paired.publicKey.equals(presented.publicKey) ? "trusted" : "untrusted";
}

export class PairingUnreadableError extends Error {
  constructor() {
    super("pairing_unreadable");
    this.name = "PairingUnreadableError";
  }
}

/** Default: ~/Library/Application Support/TokenBeacon (macOS). */
export function defaultPairingDir(): string {
  return path.join(os.homedir(), "Library", "Application Support", "TokenBeacon");
}

const PAIRING_FILE = "bluetooth-display.json";

/**
 * The paired phone's public key and ID (not secret). The directory is 0700 and
 * the file 0600, written atomically. An unreadable or altered file fails
 * closed: no phone is trusted until the pairing is removed.
 */
export class PairingStore {
  readonly file: string;
  private readonly dir: string;

  constructor(dir: string = defaultPairingDir()) {
    this.dir = dir;
    this.file = path.join(dir, PAIRING_FILE);
  }

  /** null when nothing is paired; throws PairingUnreadableError when the file is damaged. */
  load(): PairedDisplay | null {
    if (!existsSync(this.file)) return null;
    try {
      const record = JSON.parse(readFileSync(this.file, "utf8")) as Record<string, unknown>;
      if (record.version !== 1 || typeof record.id !== "string" || typeof record.publicKey !== "string" || typeof record.pairedAt !== "string") {
        throw new Error("shape");
      }
      const publicKey = Buffer.from(record.publicKey, "base64");
      if (!p256Key(publicKey) || displayId(publicKey) !== record.id) throw new Error("key");
      return { id: record.id, publicKey, pairedAt: record.pairedAt };
    } catch {
      throw new PairingUnreadableError();
    }
  }

  save(display: PresentedIdentity, now: Date = new Date()): PairedDisplay {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const paired: PairedDisplay = { id: display.id, publicKey: display.publicKey, pairedAt: now.toISOString() };
    const temp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(
      temp,
      `${JSON.stringify({ version: 1, id: paired.id, publicKey: paired.publicKey.toString("base64"), pairedAt: paired.pairedAt }, null, 2)}\n`,
      { mode: 0o600 },
    );
    chmodSync(temp, 0o600);
    renameSync(temp, this.file);
    return paired;
  }

  /** Removes the pairing; returns whether there was one. */
  forget(): boolean {
    if (!existsSync(this.file)) return false;
    rmSync(this.file, { force: true });
    return true;
  }
}
