// TokenBeacon BLE helper for macOS.
//
// Relays device-state/v1 bytes between TokenBeacon (Node) and the TokenBeacon
// Display app on an Android phone (BLE GATT peripheral). Public APIs only:
// CoreBluetooth for Bluetooth, POSIX sockets for the link to Node.
//
// It runs as a small app bundle started with /usr/bin/open, so macOS treats it
// as its own app: it asks for Bluetooth access once for "TokenBeacon BLE" and
// grants it to this helper only, not to the terminal that runs TokenBeacon.
// TokenBeacon passes a private Unix socket path and a one-time token:
//   tokenbeacon-ble --connect <socket path> <token>
// Without arguments it uses stdin/stdout (manual diagnostics).
//
// The Mac only scans for one service UUID and connects out: no advertising,
// no GATT server, no network access.
//
// Protocol (one ASCII line each):
//   in:  SCAN | OPEN <uuid> | AUTH <base64> | SEND <base64> | CLOSE | EXIT
//   out: HELLO <token> | READY | DEVICES <json> | OPENED | AUTHED <base64> | SENT | CLOSED
//        | DATA <base64> | LOST | ERR <code>
// <uuid> is CoreBluetooth's per-Mac identifier of the phone, never its address.

import CoreBluetooth
import Foundation

let serviceUUID = CBUUID(string: "B3F2A6C0-4E1D-4C8A-9F0B-7D2E5A1C9E40")
let rxUUID = CBUUID(string: "B3F2A6C0-4E1D-4C8A-9F0B-7D2E5A1C9E41")
let txUUID = CBUUID(string: "B3F2A6C0-4E1D-4C8A-9F0B-7D2E5A1C9E42")
let authUUID = CBUUID(string: "B3F2A6C0-4E1D-4C8A-9F0B-7D2E5A1C9E43")
/// A scan ends this long after the first match, or after maxScanSeconds.
let settleSeconds = 0.6
let maxScanSeconds = 4.0
let maxSendBytes = 512
let maxAuthBytes = 64

func say(_ line: String) {
    let data = Array((line + "\n").utf8)
    var offset = 0
    while offset < data.count {
        let written = data[offset...].withUnsafeBufferPointer { write(1, $0.baseAddress, $0.count) }
        if written <= 0 { exit(0) } // TokenBeacon went away
        offset += written
    }
}

final class Central: NSObject, CBCentralManagerDelegate, CBPeripheralDelegate {
    private var manager: CBCentralManager!
    private var ready = false
    private var seen: [UUID: CBPeripheral] = [:]
    private var scanning = false
    private var scanGeneration = 0
    private var peripheral: CBPeripheral?
    private var rx: CBCharacteristic?
    private var auth: CBCharacteristic?
    private var opened = false
    private var chunks: [Data] = []
    private var sendBusy = false
    private var authBusy = false

    override init() {
        super.init()
        manager = CBCentralManager(delegate: self, queue: .main)
    }

    // MARK: commands (main queue)

    func handle(_ command: String) {
        let parts = command.split(separator: " ", maxSplits: 1).map(String.init)
        let verb = parts.first ?? ""
        let arg = parts.count > 1 ? parts[1] : ""
        if verb == "EXIT" {
            close()
            exit(0)
        }
        guard ready else { return say("ERR bluetooth_unavailable") }
        switch verb {
        case "SCAN": scan()
        case "OPEN": open(arg)
        case "AUTH": authenticate(arg)
        case "SEND": send(arg)
        case "CLOSE":
            close()
            say("CLOSED")
        default: say("ERR unknown_command")
        }
    }

    private func scan() {
        if scanning { return }
        scanning = true
        scanGeneration += 1
        let generation = scanGeneration
        seen = [:]
        // A phone this Mac is already connected to does not advertise.
        for known in manager.retrieveConnectedPeripherals(withServices: [serviceUUID]) { seen[known.identifier] = known }
        manager.scanForPeripherals(withServices: [serviceUUID], options: [CBCentralManagerScanOptionAllowDuplicatesKey: false])
        if !seen.isEmpty { scheduleScanEnd(after: settleSeconds, generation: generation) }
        scheduleScanEnd(after: maxScanSeconds, generation: generation)
    }

    private func scheduleScanEnd(after seconds: Double, generation: Int) {
        DispatchQueue.main.asyncAfter(deadline: .now() + seconds) { [self] in
            guard scanning, generation == scanGeneration else { return }
            manager.stopScan()
            scanning = false
            let ids = seen.keys.map { "\"\($0.uuidString.lowercased())\"" }.sorted().prefix(8)
            say("DEVICES [" + ids.joined(separator: ",") + "]")
        }
    }

    private func open(_ id: String) {
        close()
        guard let uuid = UUID(uuidString: id),
              let target = seen[uuid] ?? manager.retrievePeripherals(withIdentifiers: [uuid]).first else {
            return say("ERR not_found")
        }
        peripheral = target
        target.delegate = self
        manager.connect(target, options: nil)
    }

    private func authenticate(_ base64: String) {
        guard opened, let target = peripheral, let auth = auth, !authBusy, !sendBusy,
              let challenge = Data(base64Encoded: base64), !challenge.isEmpty, challenge.count <= maxAuthBytes else {
            return say("ERR auth_failed")
        }
        authBusy = true
        target.writeValue(challenge, for: auth, type: .withResponse)
    }

    private func send(_ base64: String) {
        guard opened, let target = peripheral, let rx = rx, !sendBusy, !authBusy,
              let data = Data(base64Encoded: base64), !data.isEmpty, data.count <= maxSendBytes else {
            return say("ERR write_failed")
        }
        // One ATT payload per write, each with response: no long (prepared)
        // writes, and the phone acknowledges every chunk.
        let size = max(20, target.maximumWriteValueLength(for: .withoutResponse))
        chunks = stride(from: 0, to: data.count, by: size).map { data.subdata(in: $0..<min(data.count, $0 + size)) }
        sendBusy = true
        target.writeValue(chunks.removeFirst(), for: rx, type: .withResponse)
    }

    private func close() {
        if let target = peripheral { manager.cancelPeripheralConnection(target) }
        peripheral = nil
        rx = nil
        auth = nil
        opened = false
        chunks = []
        sendBusy = false
        authBusy = false
    }

    private func lost(_ code: String) {
        let wasOpened = opened
        close()
        say(wasOpened ? "LOST" : "ERR " + code)
    }

    // MARK: CBCentralManagerDelegate

    func centralManagerDidUpdateState(_ central: CBCentralManager) {
        switch central.state {
        case .poweredOn:
            if !ready { say("READY") }
            ready = true
        case .poweredOff:
            ready = false
            if opened { lost("bluetooth_off") }
            say("ERR bluetooth_off")
        case .unauthorized:
            ready = false
            say("ERR bluetooth_unauthorized")
        case .unsupported:
            ready = false
            say("ERR unsupported")
        default:
            break
        }
    }

    func centralManager(_ central: CBCentralManager, didDiscover found: CBPeripheral, advertisementData: [String: Any], rssi RSSI: NSNumber) {
        let services = (advertisementData[CBAdvertisementDataServiceUUIDsKey] as? [CBUUID] ?? [])
            + (advertisementData[CBAdvertisementDataOverflowServiceUUIDsKey] as? [CBUUID] ?? [])
        guard services.contains(serviceUUID), seen.count < 8 else { return }
        let first = seen.isEmpty
        seen[found.identifier] = found
        if first && scanning { scheduleScanEnd(after: settleSeconds, generation: scanGeneration) }
    }

    func centralManager(_ central: CBCentralManager, didConnect connected: CBPeripheral) {
        guard connected == peripheral else { return }
        connected.discoverServices([serviceUUID])
    }

    func centralManager(_ central: CBCentralManager, didFailToConnect failed: CBPeripheral, error: Error?) {
        if failed == peripheral { lost("open_failed") }
    }

    func centralManager(_ central: CBCentralManager, didDisconnectPeripheral gone: CBPeripheral, error: Error?) {
        if gone == peripheral { lost("open_failed") }
    }

    // MARK: CBPeripheralDelegate

    func peripheral(_ target: CBPeripheral, didDiscoverServices error: Error?) {
        guard error == nil, let service = target.services?.first(where: { $0.uuid == serviceUUID }) else { return lost("unrecognized") }
        target.discoverCharacteristics([rxUUID, txUUID, authUUID], for: service)
    }

    func peripheral(_ target: CBPeripheral, didDiscoverCharacteristicsFor service: CBService, error: Error?) {
        let found = service.characteristics ?? []
        guard error == nil,
              let rxChar = found.first(where: { $0.uuid == rxUUID }),
              let txChar = found.first(where: { $0.uuid == txUUID }),
              let authChar = found.first(where: { $0.uuid == authUUID }) else {
            return lost("unrecognized")
        }
        rx = rxChar
        auth = authChar
        // The phone requires an encrypted, authenticated link: the first time,
        // macOS shows its pairing dialog here before this succeeds.
        target.setNotifyValue(true, for: txChar)
    }

    func peripheral(_ target: CBPeripheral, didUpdateNotificationStateFor characteristic: CBCharacteristic, error: Error?) {
        guard characteristic.uuid == txUUID else { return }
        if error != nil || !characteristic.isNotifying { return lost("open_failed") }
        if !opened {
            opened = true
            say("OPENED")
        }
    }

    func peripheral(_ target: CBPeripheral, didUpdateValueFor characteristic: CBCharacteristic, error: Error?) {
        if characteristic.uuid == authUUID {
            guard authBusy else { return }
            authBusy = false
            guard error == nil, let value = characteristic.value, !value.isEmpty, value.count <= 512 else { return say("ERR auth_failed") }
            return say("AUTHED " + value.base64EncodedString())
        }
        guard opened, characteristic.uuid == txUUID, error == nil, let value = characteristic.value, !value.isEmpty, value.count <= 512 else { return }
        say("DATA " + value.base64EncodedString())
    }

    func peripheral(_ target: CBPeripheral, didWriteValueFor characteristic: CBCharacteristic, error: Error?) {
        if characteristic.uuid == authUUID {
            guard authBusy else { return }
            if error != nil {
                authBusy = false
                return say("ERR auth_failed")
            }
            return target.readValue(for: characteristic) // the phone's signed answer
        }
        guard sendBusy else { return }
        if error != nil {
            chunks = []
            sendBusy = false
            return say("ERR write_failed")
        }
        if chunks.isEmpty {
            sendBusy = false
            say("SENT")
        } else if let rx = rx {
            target.writeValue(chunks.removeFirst(), for: rx, type: .withResponse)
        }
    }
}

/// Connects to TokenBeacon's private socket and uses it as stdin/stdout.
func connectToTokenBeacon(path: String, token: String) {
    guard path.hasPrefix("/"), path.utf8.count < 100, token.range(of: "^[0-9a-f]{32}$", options: .regularExpression) != nil else { exit(2) }
    let fd = socket(AF_UNIX, SOCK_STREAM, 0)
    guard fd >= 0 else { exit(2) }
    var address = sockaddr_un()
    address.sun_family = sa_family_t(AF_UNIX)
    withUnsafeMutableBytes(of: &address.sun_path) { buffer in
        let bytes = Array(path.utf8)
        buffer.copyBytes(from: bytes)
        buffer[bytes.count] = 0
    }
    let connected = withUnsafePointer(to: &address) {
        $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { connect(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) }
    }
    guard connected == 0, dup2(fd, 0) >= 0, dup2(fd, 1) >= 0 else { exit(2) }
    Darwin.close(fd)
    say("HELLO " + token)
}

signal(SIGPIPE, SIG_IGN)
let arguments = CommandLine.arguments
if arguments.count == 4, arguments[1] == "--connect" {
    connectToTokenBeacon(path: arguments[2], token: arguments[3])
}

let central = Central()
// Commands are read on a background thread and run on the main queue.
Thread.detachNewThread {
    while let line = readLine(strippingNewline: true) {
        if line.utf8.count > 2048 { continue }
        DispatchQueue.main.async { central.handle(line) }
    }
    DispatchQueue.main.async { central.handle("EXIT") } // TokenBeacon closed the link
}
RunLoop.main.run()
