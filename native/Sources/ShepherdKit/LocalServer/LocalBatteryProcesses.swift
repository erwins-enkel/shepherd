#if os(macOS)
import Darwin
import Foundation
import SQLite3

/// Persist the kernel birth time with every signal target: a recycled pid is never ours.
struct BatteryProcess: Codable, Equatable, Sendable {
  let pid: Int32
  let birth: KernelProcessIdentity

  init?(_ pid: Int32) {
    guard let birth = KernelProcessIdentity.read(pid) else { return nil }
    self.pid = pid
    self.birth = birth
  }

  var alive: Bool { KernelProcessIdentity.read(pid) == birth }
  var info: proc_bsdinfo? {
    var value = proc_bsdinfo()
    let size = Int32(MemoryLayout<proc_bsdinfo>.size)
    guard alive, proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &value, size) == size, alive else { return nil }
    return value
  }

  var isControlProcess: Bool {
    var path = [UInt8](repeating: 0, count: 4 * Int(MAXPATHLEN))
    let count = path.withUnsafeMutableBytes { proc_pidpath(pid, $0.baseAddress, UInt32($0.count)) }
    guard count > 0 else { return false }
    let name = URL(fileURLWithPath: String(decoding: path.prefix { $0 != 0 }, as: UTF8.self)).lastPathComponent
    return ["Shepherd", "ShepherdPowerHelper", "herdr"].contains(name)
  }

  func signal(_ signal: Int32) throws {
    guard alive else { return }
    guard Darwin.kill(pid, signal) == 0 || errno == ESRCH else { throw BatteryPauseError.signal(pid: pid, code: errno) }
  }

  static func snapshot() -> [BatteryProcess] {
    let size = proc_listpids(UInt32(PROC_ALL_PIDS), 0, nil, 0)
    guard size > 0 else { return [] }
    var pids = [Int32](repeating: 0, count: Int(size) / MemoryLayout<Int32>.size + 256)
    let bytes = pids.withUnsafeMutableBytes {
      proc_listpids(UInt32(PROC_ALL_PIDS), 0, $0.baseAddress, Int32($0.count))
    }
    return pids.prefix(max(0, Int(bytes)) / MemoryLayout<Int32>.size).compactMap {
      guard let process = BatteryProcess($0), process.info?.pbi_uid == getuid() else { return nil }
      return process
    }
  }

  /// Read ownership markers only; argv and unrelated environment values never leave here.
  var provenance: BatteryProcessProvenance? {
    var mib: [Int32] = [CTL_KERN, KERN_PROCARGS2, pid]
    var size = 0
    guard sysctl(&mib, 3, nil, &size, nil, 0) == 0, size > 4, size <= 4 * 1024 * 1024 else { return nil }
    var bytes = [UInt8](repeating: 0, count: size)
    let result = bytes.withUnsafeMutableBytes { sysctl(&mib, 3, $0.baseAddress, &size, nil, 0) }
    guard result == 0, alive else { return nil }
    return Self.provenance(in: Array(bytes.prefix(size)))
  }

  static func provenance(in bytes: [UInt8]) -> BatteryProcessProvenance? {
    guard bytes.count > 4 else { return nil }
    let argc = bytes.prefix(4).withUnsafeBytes { $0.loadUnaligned(as: Int32.self) }
    guard argc > 0 else { return nil }
    var cursor = 4
    // Executable path, padding, then argc arguments (including empty arguments).
    while cursor < bytes.count && bytes[cursor] != 0 { cursor += 1 }
    while cursor < bytes.count && bytes[cursor] == 0 { cursor += 1 }
    var arguments: [String] = []
    for _ in 0..<argc {
      let start = cursor
      while cursor < bytes.count && bytes[cursor] != 0 { cursor += 1 }
      guard cursor < bytes.count else { return nil }
      arguments.append(String(decoding: bytes[start..<cursor], as: UTF8.self))
      cursor += 1
    }
    var result = BatteryProcessProvenance()
    // Existing Claude reviewers predate the ownership marker. Their explicit --session-id
    // is recorded in this database; never infer ownership from cwd, a name or prompt text.
    for (index, argument) in arguments.enumerated() where argument == "--session-id" || argument == "--resume" {
      if index + 1 < arguments.count { result.invocationIDs.insert(arguments[index + 1]) }
    }
    for entry in bytes[cursor...].split(separator: 0) {
      let prefix = Array("SHEPHERD_SESSION_ID=".utf8)
      if entry.starts(with: prefix) {
        result.sessionID = String(decoding: entry.dropFirst(prefix.count), as: UTF8.self)
      }
    }
    return result
  }
}

struct BatteryProcessProvenance {
  var sessionID: String?
  var invocationIDs = Set<String>()

  func matches(ids: Set<String>) -> Bool {
    return sessionID.map(ids.contains) == true || !invocationIDs.isDisjoint(with: ids)
  }
}

enum BatteryPauseError: Error {
  case ownership, database, helper, alreadyRunning, unstableProcessTree
  case signal(pid: Int32, code: Int32)
  case stopTimeout(pid: Int32, status: UInt32?)
}

enum BatterySessionIDs {
  /// Read the existing local database without opening a writable connection or running migrations.
  static func read(_ path: String, sql: String = "SELECT id FROM sessions UNION SELECT reviewerSessionId FROM reviewer_spawns UNION SELECT providerSessionId FROM reviewer_spawns WHERE providerSessionId IS NOT NULL") throws -> Set<String> {
    var db: OpaquePointer?
    guard sqlite3_open_v2(path, &db, SQLITE_OPEN_READONLY, nil) == SQLITE_OK else {
      if let db { sqlite3_close(db) }
      throw BatteryPauseError.database
    }
    defer { sqlite3_close(db) }
    var query: OpaquePointer?
    guard sqlite3_prepare_v2(db, sql, -1, &query, nil) == SQLITE_OK else {
      throw BatteryPauseError.database
    }
    defer { sqlite3_finalize(query) }
    var ids = Set<String>()
    var result = sqlite3_step(query)
    while result == SQLITE_ROW {
      if let value = sqlite3_column_text(query, 0) { ids.insert(String(cString: value)) }
      result = sqlite3_step(query)
    }
    guard result == SQLITE_DONE else { throw BatteryPauseError.database }
    return ids
  }
}
#endif
