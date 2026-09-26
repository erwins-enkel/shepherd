import CryptoKit
import Foundation
import Network
import ShepherdKit

/// One loopback listener exercises AppModel's production HTTP and WebSocket composition.
/// All mutable networking state is confined to queue; accessors synchronously snapshot it.
final class AppModelEventFixture: @unchecked Sendable {
    private let queue = DispatchQueue(label: "run.shepherd.tests.app-events")
    private let listener: NWListener
    private var connections: [NWConnection] = []
    private var socket: NWConnection?
    private var texts: [String] = []
    private var upgrades = 0
    private var closes = 0
    let url: URL

    init() throws {
        let parameters = NWParameters.tcp
        parameters.requiredLocalEndpoint = .hostPort(host: .ipv4(.loopback), port: .any)
        listener = try NWListener(using: parameters)
        let ready = DispatchSemaphore(value: 0)
        listener.stateUpdateHandler = { if case .ready = $0 { ready.signal() } }
        // Initializing the URL precedes installing callbacks that capture self.
        listener.newConnectionHandler = { $0.cancel() }
        listener.start(queue: queue)
        guard ready.wait(timeout: .now() + 5) == .success, let port = listener.port else {
            listener.cancel()
            throw FixtureError.bind
        }
        url = URL(string: "http://127.0.0.1:\(port.rawValue)")!
        listener.newConnectionHandler = { [weak self] connection in
            guard let self else { connection.cancel(); return }
            connections.append(connection)
            connection.start(queue: queue)
            receiveHTTP(connection, buffer: Data())
        }
    }

    var connectionCount: Int { queue.sync { upgrades } }
    var closeCount: Int { queue.sync { closes } }
    var receivedTexts: [String] { queue.sync { texts } }

    func send(_ json: String) {
        queue.sync { if let socket { sendFrame(Data(json.utf8), opcode: 1, on: socket) } }
    }

    func stop() {
        queue.sync {
            connections.forEach { $0.cancel() }
            connections.removeAll()
            socket = nil
            listener.cancel()
        }
    }

    private func receiveHTTP(_ connection: NWConnection, buffer: Data) {
        connection.receive(minimumIncompleteLength: 1, maximumLength: 65536) { [weak self] data, _, done, error in
            guard let self, error == nil, let data else { return }
            let buffer = buffer + data
            guard let end = buffer.range(of: Data("\r\n\r\n".utf8)) else {
                if !done { receiveHTTP(connection, buffer: buffer) }
                return
            }
            let lines = String(decoding: buffer[..<end.lowerBound], as: UTF8.self).components(separatedBy: "\r\n")
            let path = lines[0].split(separator: " ").dropFirst().first.map(String.init) ?? ""
            let headers = Dictionary(lines.dropFirst().compactMap { line -> (String, String)? in
                guard let colon = line.firstIndex(of: ":") else { return nil }
                return (line[..<colon].lowercased(), line[line.index(after: colon)...].trimmingCharacters(in: .whitespaces))
            }, uniquingKeysWith: { _, last in last })
            if path == "/events", let key = headers["sec-websocket-key"] {
                let digest = Insecure.SHA1.hash(data: Data((key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").utf8))
                let response = "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: \(Data(digest).base64EncodedString())\r\n\r\n"
                socket = connection
                upgrades += 1
                connection.send(content: Data(response.utf8), completion: .contentProcessed { _ in })
                receiveFrames(connection, buffer: Data(buffer[end.upperBound...]))
            } else {
                let body = responseBody(path: path)
                let response = "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: \(body.count)\r\nConnection: close\r\n\r\n"
                connection.send(content: Data(response.utf8) + body, completion: .contentProcessed { _ in connection.cancel() })
            }
        }
    }

    private func responseBody(path: String) -> Data {
        switch path.split(separator: "?").first.map(String.init) {
        case "/api/sessions": return Data("[]".utf8)
        case "/api/settings":
            return try! JSONEncoder().encode(Settings(repoRoot: "/repos", repoRootDisplay: "/repos", firstRunPending: false, defaultModel: "sonnet", defaultEffort: "medium", defaultAgentProvider: .claude, authMode: .subscription, operatorLanguage: .en))
        case "/api/repos": return try! JSONEncoder().encode(RepoList(repos: [], recentWindowDays: 14))
        case "/api/health": return try! JSONEncoder().encode(Health(ok: true, version: "1.47.0"))
        default: return Data("{}".utf8)
        }
    }

    private func receiveFrames(_ connection: NWConnection, buffer: Data) {
        var remaining = [UInt8](buffer)
        while remaining.count >= 2 {
            let opcode = remaining[0] & 0x0f
            let masked = remaining[1] & 0x80 != 0
            var length = Int(remaining[1] & 0x7f)
            var offset = 2
            if length == 126 {
                guard remaining.count >= 4 else { break }
                length = Int(remaining[2]) << 8 | Int(remaining[3]); offset = 4
            } else if length == 127 { connection.cancel(); return }
            let maskLength = masked ? 4 : 0
            guard remaining.count >= offset + maskLength + length else { break }
            let mask = Array(remaining[offset..<(offset + maskLength)])
            offset += maskLength
            let payload = Data((0..<length).map { remaining[offset + $0] ^ (masked ? mask[$0 % 4] : 0) })
            remaining.removeFirst(offset + length)
            if opcode == 1 { texts.append(String(decoding: payload, as: UTF8.self)) }
            if opcode == 9 { sendFrame(payload, opcode: 10, on: connection) }
            if opcode == 8 { closes += 1; connection.cancel(); return }
        }
        let pending = Data(remaining)
        connection.receive(minimumIncompleteLength: 1, maximumLength: 65536) { [weak self] data, _, done, error in
            guard let self else { return }
            if let data, !data.isEmpty { receiveFrames(connection, buffer: pending + data) }
            else if done || error != nil { closes += 1 }
        }
    }

    private func sendFrame(_ payload: Data, opcode: UInt8, on connection: NWConnection) {
        var frame = Data([0x80 | opcode])
        if payload.count < 126 { frame.append(UInt8(payload.count)) }
        else { frame.append(contentsOf: [126, UInt8(payload.count >> 8), UInt8(payload.count & 0xff)]) }
        frame.append(payload)
        connection.send(content: frame, completion: .contentProcessed { _ in })
    }

    private enum FixtureError: Error { case bind }
}
