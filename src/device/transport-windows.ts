import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import path from "node:path";
import type { DeviceConfig } from "./config.ts";
import { LineAssembler } from "./lines.ts";
import {
  DISPLAY_PRODUCT_NAME,
  TransportError,
  type DeviceCandidate,
  type DeviceConnection,
  type DeviceTransport,
  type TransportErrorCode,
} from "./transport.ts";

/**
 * Windows: Node.js has no serial port API, and reading a COM port through fs
 * would block libuv worker threads. A long-lived helper – the built-in Windows
 * PowerShell 5.1 with a fixed script and System.IO.Ports – lists the ports and
 * relays bytes over stdio. Started only when the display is enabled; no npm
 * packages, no script files, no change to the execution policy.
 */

const PORT_NAME = /^COM[1-9][0-9]{0,2}$/;
const SERIAL = /^[0-9A-Za-z]{4,64}$/;
const MAX_HELPER_LINE = 64 * 1024;
const TIMEOUTS = { LIST: 15_000, OPEN: 5_000, SEND: 3_000, CLOSE: 3_000 } as const;

/**
 * Helper protocol (one line each, ASCII):
 *   in:  LIST | OPEN COMn | SEND <base64> | CLOSE | EXIT
 *   out: READY | PORTS <json> | OPENED | SENT | CLOSED | ERR <code> | DATA <base64> | LOST
 * The port is opened with DTR on and RTS off and never at 1200 baud, so the
 * display does not reset or enter its bootloader.
 */
export const HELPER_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$utf8 = New-Object System.Text.UTF8Encoding $false
[Console]::OutputEncoding = $utf8
# Console.In is synchronized in .NET Framework (its ReadLineAsync blocks);
# a plain StreamReader reads stdin on a worker thread, so the port keeps being read.
$in = New-Object System.IO.StreamReader([Console]::OpenStandardInput(), $utf8)
$out = [Console]::Out
function Say([string]$text) { $out.WriteLine($text); $out.Flush() }
function Code($err) {
  $name = $err.Exception.GetBaseException().GetType().Name
  if ($name -eq 'UnauthorizedAccessException') { return 'busy' }
  if ($name -eq 'IOException' -or $name -eq 'FileNotFoundException' -or $name -eq 'ArgumentException') { return 'not_found' }
  return 'open_failed'
}
$port = $null
$pending = $in.ReadLineAsync()
$running = $true
Say 'READY'
while ($running) {
  if ($pending.IsCompleted) {
    $command = $pending.Result
    if ($null -eq $command) { break }
    $pending = $in.ReadLineAsync()
    $verb = $command.Split(' ')[0]
    $arg = if ($command.Length -gt $verb.Length) { $command.Substring($verb.Length + 1) } else { '' }
    if ($verb -eq 'LIST') {
      try {
        $found = @()
        $devices = @(Get-CimInstance -ClassName Win32_PnPEntity -Filter "PNPDeviceID LIKE 'USB\\VID_303A%'")
        foreach ($device in $devices) {
          if ($device.Name -notmatch '\((COM[0-9]+)\)') { continue }
          $com = $Matches[1]
          $id = [string]$device.PNPDeviceID
          $product = $null
          try { $product = [string](Get-PnpDeviceProperty -InstanceId $id -KeyName 'DEVPKEY_Device_BusReportedDeviceDesc').Data } catch { }
          $serialSource = $id
          if ($id -match '&MI_[0-9A-F]{2}') {
            try { $serialSource = [string](Get-PnpDeviceProperty -InstanceId $id -KeyName 'DEVPKEY_Device_Parent').Data } catch { }
          }
          $serial = ($serialSource -split '\\')[-1]
          $found += New-Object PSObject -Property @{ port = $com; product = $product; serial = $serial }
        }
        Say ('PORTS ' + (ConvertTo-Json -InputObject @($found) -Compress))
      } catch { Say 'ERR discover_failed' }
    } elseif ($verb -eq 'OPEN') {
      try {
        if ($null -ne $port) { $port.Dispose(); $port = $null }
        if ($arg -notmatch '^COM[1-9][0-9]{0,2}$') { throw (New-Object System.ArgumentException 'port') }
        $candidate = New-Object System.IO.Ports.SerialPort $arg, 115200, ([System.IO.Ports.Parity]::None), 8, ([System.IO.Ports.StopBits]::One)
        $candidate.DtrEnable = $true
        $candidate.RtsEnable = $false
        $candidate.WriteTimeout = 1000
        $candidate.Open()
        $port = $candidate
        Say 'OPENED'
      } catch { Say ('ERR ' + (Code $_)) }
    } elseif ($verb -eq 'SEND') {
      try {
        $bytes = [Convert]::FromBase64String($arg)
        $port.Write($bytes, 0, $bytes.Length)
        Say 'SENT'
      } catch { Say 'ERR write_failed' }
    } elseif ($verb -eq 'CLOSE') {
      if ($null -ne $port) { try { $port.Dispose() } catch { } ; $port = $null }
      Say 'CLOSED'
    } elseif ($verb -eq 'EXIT') {
      $running = $false
    } else {
      Say 'ERR unknown_command'
    }
  }
  if ($null -ne $port) {
    try {
      $count = $port.BytesToRead
      if ($count -gt 0) {
        if ($count -gt 4096) { $count = 4096 }
        $buffer = New-Object byte[] $count
        $read = $port.Read($buffer, 0, $count)
        Say ('DATA ' + [Convert]::ToBase64String($buffer, 0, $read))
      }
    } catch {
      try { $port.Dispose() } catch { }
      $port = $null
      Say 'LOST'
    }
  }
  Start-Sleep -Milliseconds 20
}
if ($null -ne $port) { try { $port.Dispose() } catch { } }
`;

interface HelperPort {
  port: unknown;
  product: unknown;
  serial: unknown;
}

/** Filters the helper's port list to TokenBeacon displays. */
export function parseHelperPorts(json: string): DeviceCandidate[] {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    return [];
  }
  const items = (Array.isArray(value) ? value : [value]) as HelperPort[];
  const candidates: DeviceCandidate[] = [];
  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    if (item.product !== DISPLAY_PRODUCT_NAME || typeof item.port !== "string" || !PORT_NAME.test(item.port)) continue;
    const serial = typeof item.serial === "string" && SERIAL.test(item.serial) ? item.serial : null;
    candidates.push({ id: item.port, port: item.port, serial });
  }
  return candidates;
}

export function powershellPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.win32.join(env.SystemRoot ?? env.windir ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

export class WindowsTransport implements DeviceTransport {
  private readonly config: Exclude<DeviceConfig, { mode: "off" }>;
  private helper: ChildProcessWithoutNullStreams | null = null;
  private ready: Promise<void> | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private reply: { resolve: (line: string) => void; reject: (error: Error) => void } | null = null;
  private connection: HelperConnection | null = null;
  private stdoutBuffer = "";

  constructor(config: Exclude<DeviceConfig, { mode: "off" }>) {
    this.config = config;
  }

  async discover(): Promise<DeviceCandidate[]> {
    if (this.config.mode === "port") return [{ id: this.config.port, port: this.config.port, serial: null }];
    const answer = await this.command("LIST", TIMEOUTS.LIST, "discover_failed");
    if (!answer.startsWith("PORTS ")) throw new TransportError("discover_failed");
    return parseHelperPorts(answer.slice(6));
  }

  async open(candidate: DeviceCandidate): Promise<DeviceConnection> {
    if (!PORT_NAME.test(candidate.port)) throw new TransportError("open_failed");
    this.connection?.markClosed();
    const answer = await this.command(`OPEN ${candidate.port}`, TIMEOUTS.OPEN, "open_failed");
    if (answer !== "OPENED") throw new TransportError(errorCode(answer));
    const connection = new HelperConnection(
      (line) => this.send(line),
      () => {
        if (this.connection === connection) this.connection = null;
        void this.command("CLOSE", TIMEOUTS.CLOSE, "open_failed").catch(() => undefined);
      },
    );
    this.connection = connection;
    return connection;
  }

  dispose(): void {
    const helper = this.helper;
    this.helper = null;
    this.ready = null;
    this.connection?.markClosed();
    this.connection = null;
    this.reply?.reject(new TransportError("open_failed"));
    this.reply = null;
    if (!helper) return;
    try {
      helper.stdin.write("EXIT\n");
      helper.stdin.end();
    } catch {
      // The helper may already be gone.
    }
    setTimeout(() => helper.kill(), 1_000).unref();
  }

  private async send(line: string): Promise<void> {
    const answer = await this.command(`SEND ${Buffer.from(line, "utf8").toString("base64")}`, TIMEOUTS.SEND, "open_failed");
    if (answer !== "SENT") throw new Error("write failed");
  }

  /** Runs one helper command at a time and waits for its reply line. */
  private command(text: string, timeoutMs: number, failure: TransportErrorCode): Promise<string> {
    const run = async () => {
      await this.startHelper();
      const helper = this.helper;
      if (!helper) throw new TransportError(failure);
      return new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => {
          this.reply = null;
          this.dispose(); // a stuck helper is replaced on the next command
          reject(new TransportError(failure));
        }, timeoutMs);
        this.reply = {
          resolve: (line) => {
            clearTimeout(timer);
            resolve(line);
          },
          reject: (error) => {
            clearTimeout(timer);
            reject(error);
          },
        };
        helper.stdin.write(`${text}\n`);
      });
    };
    const result = this.queue.then(run, run);
    this.queue = result.catch(() => undefined);
    return result;
  }

  private startHelper(): Promise<void> {
    if (this.ready) return this.ready;
    const helper = spawn(
      powershellPath(),
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(HELPER_SCRIPT, "utf16le").toString("base64")],
      { stdio: ["pipe", "pipe", "pipe"], windowsHide: true },
    );
    this.helper = helper;
    this.stdoutBuffer = "";
    helper.stderr.resume(); // never shown: may contain system paths
    this.ready = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new TransportError("unsupported")), 15_000);
      helper.stdout.setEncoding("utf8");
      helper.stdout.on("data", (chunk: string) => {
        this.stdoutBuffer += chunk;
        if (this.stdoutBuffer.length > MAX_HELPER_LINE && !this.stdoutBuffer.includes("\n")) this.stdoutBuffer = "";
        let newline = this.stdoutBuffer.indexOf("\n");
        while (newline >= 0) {
          const line = this.stdoutBuffer.slice(0, newline).replace(/\r$/, "");
          this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
          if (line === "READY") {
            clearTimeout(timer);
            resolve();
          } else {
            this.onHelperLine(line);
          }
          newline = this.stdoutBuffer.indexOf("\n");
        }
      });
      const gone = () => {
        clearTimeout(timer);
        reject(new TransportError("unsupported"));
        if (this.helper === helper) {
          this.helper = null;
          this.ready = null;
          this.connection?.markClosed();
          this.connection = null;
          this.reply?.reject(new TransportError("open_failed"));
          this.reply = null;
        }
      };
      helper.on("error", gone);
      helper.on("exit", gone);
    });
    this.ready.catch(() => undefined);
    return this.ready;
  }

  private onHelperLine(line: string): void {
    if (line.startsWith("DATA ")) {
      this.connection?.receive(Buffer.from(line.slice(5), "base64"));
    } else if (line === "LOST") {
      this.connection?.markClosed();
      this.connection = null;
    } else if (this.reply) {
      const reply = this.reply;
      this.reply = null;
      reply.resolve(line);
    }
  }
}

function errorCode(answer: string): TransportErrorCode {
  const code = answer.startsWith("ERR ") ? answer.slice(4) : "";
  return code === "busy" || code === "not_found" ? code : "open_failed";
}

class HelperConnection implements DeviceConnection {
  private readonly sendLine: (line: string) => Promise<void>;
  private readonly release: () => void;
  private readonly lineListeners: Array<(line: string) => void> = [];
  private readonly closeListeners: Array<() => void> = [];
  private closed = false;
  private readonly assembler = new LineAssembler((line) => {
    for (const listener of this.lineListeners) listener(line);
  });

  constructor(sendLine: (line: string) => Promise<void>, release: () => void) {
    this.sendLine = sendLine;
    this.release = release;
  }

  write(line: string): Promise<void> {
    return this.closed ? Promise.reject(new Error("closed")) : this.sendLine(line);
  }

  close(): void {
    if (this.closed) return;
    this.release();
    this.markClosed();
  }

  onLine(listener: (line: string) => void): void {
    this.lineListeners.push(listener);
  }

  onClose(listener: () => void): void {
    this.closeListeners.push(listener);
  }

  receive(chunk: Buffer): void {
    if (!this.closed) this.assembler.push(chunk);
  }

  markClosed(): void {
    if (this.closed) return;
    this.closed = true;
    for (const listener of this.closeListeners) listener();
  }
}
