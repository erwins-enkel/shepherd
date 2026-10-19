#if os(macOS)
import Foundation
import Synchronization

enum BatteryPaneTargets {
  static func resolve(owner: LocalServerOwnership, runner: URL, socket: String) async throws -> [BatteryProcess] {
    let database = LocalServerIdentity.canonical(owner.expectedIdentity.databasePath)
    let terminalIDs = try BatterySessionIDs.read(database, sql: "SELECT herdrAgentId FROM sessions UNION SELECT terminalPaneId FROM sessions WHERE terminalPaneId IS NOT NULL")
    var paneIDs = Set<String>()
    let ledger = URL(fileURLWithPath: database + ".power-panes")
    // Older backends have no complete auxiliary ownership journal. Refuse a partial pause.
    let lines = try String(contentsOf: ledger, encoding: .utf8).split(separator: "\n")
    for line in lines { paneIDs.insert(try JSONDecoder().decode(String.self, from: Data(line.utf8))) }
    let agents = try await command(runner, socket, ["agent", "list"])
    if let rows = agents["agents"] as? [[String: Any]] {
      for agent in rows {
        if let terminal = agent["terminal_id"] as? String, terminalIDs.contains(terminal),
           let pane = agent["pane_id"] as? String { paneIDs.insert(pane) }
      }
    } else { throw BatteryPauseError.helper }
    let panes = try await command(runner, socket, ["pane", "list"])
    guard let rows = panes["panes"] as? [[String: Any]] else { throw BatteryPauseError.helper }
    let live = Set(rows.compactMap { $0["pane_id"] as? String })
    paneIDs.formUnion(terminalIDs.intersection(live))
    paneIDs.formIntersection(live) // Closed historical panes do not cause a failed pause.
    var result: [BatteryProcess] = []
    for pane in paneIDs.sorted() {
      let value = try await command(runner, socket, ["pane", "process-info", "--pane", pane])
      guard let info = value["process_info"] as? [String: Any],
            let pid = info["shell_pid"] as? Int32, pid > 1 else { throw BatteryPauseError.helper }
      if let process = BatteryProcess(pid) { result.append(process) }
    }
    return result
  }

  /// Bounded, private CLI output. Nothing is logged, and no backend token is required.
  static func command(_ runner: URL, _ socket: String, _ args: [String]) async throws -> [String: Any] {
    let process = Process()
    let pipe = Pipe()
    let status = Mutex<Int32?>(nil)
    process.executableURL = runner
    process.arguments = args
    process.environment = ["PATH": "/usr/bin:/bin:/usr/sbin:/sbin", "HOME": NSHomeDirectory(), "HERDR_SOCKET_PATH": socket]
    process.standardInput = FileHandle.nullDevice
    process.standardOutput = pipe
    process.standardError = FileHandle.nullDevice
    process.terminationHandler = { child in status.withLock { $0 = child.terminationStatus } }
    try process.run()
    // Drain concurrently: a large pane list must not deadlock on a full pipe.
    let read = Task.detached { try pipe.fileHandleForReading.readToEnd() ?? Data() }
    let deadline = Date().addingTimeInterval(5)
    while status.withLock({ $0 }) == nil && Date() < deadline && !Task.isCancelled {
      try? await Task.sleep(for: .milliseconds(20))
    }
    guard status.withLock({ $0 }) == 0 else {
      if process.isRunning { kill(process.processIdentifier, SIGKILL) }
      throw BatteryPauseError.helper
    }
    let bytes = try await read.value
    guard bytes.count <= 8 * 1024 * 1024,
          let json = try JSONSerialization.jsonObject(with: bytes) as? [String: Any],
          let result = json["result"] as? [String: Any] else { throw BatteryPauseError.helper }
    return result
  }
}
#endif
