#if os(macOS)
import Darwin
import Foundation
import IOKit.ps

public enum MacPowerSource: Sendable, Equatable {
  case battery, external, unknown

  public static func read() -> Self {
    guard let info = IOPSCopyPowerSourcesInfo()?.takeRetainedValue(),
          let type = IOPSGetProvidingPowerSourceType(info)?.takeUnretainedValue() else { return .unknown }
    switch type as String {
    case kIOPSBatteryPowerValue: return .battery
    case kIOPSACPowerValue: return .external
    default: return .unknown
    }
  }
}

public enum BatteryPausePhase: String, Codable, Sendable {
  case pausing, paused, resuming, running, failed
  public var isActive: Bool { self == .pausing || self == .paused || self == .resuming }
}

struct BatteryPauseJournal: Codable, Sendable {
  var phase: BatteryPausePhase
  let helper: BatteryProcess
  let server: BatteryProcess
  var processes: [BatteryProcess]
  var groupKeeper: BatteryProcess?

  func save(_ url: URL) throws {
    try JSONEncoder().encode(self).write(to: url, options: .atomic)
    try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
  }

  mutating func resume(_ url: URL) throws {
    phase = .resuming
    try save(url)
    // Children first, server last: automation must not mistake suspended agents for dead ones.
    for process in processes.reversed() { try process.signal(SIGCONT) }
    processes.removeAll()
    if let keeper = groupKeeper {
      try keeper.signal(SIGKILL)
      _ = waitpid(keeper.pid, nil, 0) // ECHILD is expected during recovery by a new app.
      groupKeeper = nil
    }
    phase = .running
    try save(url)
  }
}

/// The helper owns the pause, not the UI. Closing the app cannot strand suspended work.
public struct LocalBatteryPause: Sendable {
  private let environment: LocalServerEnvironment
  public let journalURL: URL
  let ownershipURL: URL
  var resumeURL: URL { journalURL.appendingPathExtension("resume") }

  public init(environment: LocalServerEnvironment) {
    self.environment = environment
    let directory = environment.homeDirectory.appendingPathComponent(".shepherd/run")
    let name = LocalServerOwnership.configurationName(environment)
    ownershipURL = directory.appendingPathComponent(name + ".json")
    journalURL = directory.appendingPathComponent(name + "-battery.json")
  }

  var journal: BatteryPauseJournal? {
    guard let data = try? Data(contentsOf: journalURL) else { return nil }
    return try? JSONDecoder().decode(BatteryPauseJournal.self, from: data)
  }

  public var phase: BatteryPausePhase { journal?.phase ?? .running }
  public var pausedServerPID: Int32? {
    guard let journal, journal.phase.isActive, journal.server.alive else { return nil }
    return journal.server.pid
  }

  public func resume() throws { try Data().write(to: resumeURL, options: .atomic) }

  /// A killed helper is recovered on the next app launch/tick. Never signal recycled pids.
  public func recoverAbandonedPause() throws {
    guard var journal, journal.phase.isActive, !journal.helper.alive else { return }
    try journal.resume(journalURL)
  }

  public func start(helper: URL) throws {
    try recoverAbandonedPause()
    guard !phase.isActive else { return }
    _ = try Self.owner(at: ownershipURL)
    guard let runner = environment.locateRunner(),
          let socket = environment.childEnvironment()["HERDR_SOCKET_PATH"] else { throw BatteryPauseError.helper }
    try? FileManager.default.removeItem(at: resumeURL)
    let process = Process()
    process.executableURL = URL(fileURLWithPath: "/bin/sh")
    process.arguments = ["-c", "trap '' HUP; exec \"$@\"", "shepherd-battery",
                         helper.path, ownershipURL.path, journalURL.path, runner.path, socket]
    // Do not inherit a parent agent's session marker into the independent guardian.
    process.environment = ["PATH": "/usr/bin:/bin:/usr/sbin:/sbin", "HOME": NSHomeDirectory()]
    process.standardInput = FileHandle.nullDevice
    process.standardOutput = FileHandle.nullDevice
    process.standardError = FileHandle.nullDevice
    try process.run()
  }

  static func owner(at url: URL) throws -> LocalServerOwnership {
    let owner = try JSONDecoder().decode(LocalServerOwnership.self, from: Data(contentsOf: url))
    guard let start = owner.processStart, KernelProcessIdentity.read(owner.pid) == start,
          owner.processGroup == owner.pid, getpgid(owner.pid) == owner.processGroup,
          owner.pid != getpid(), owner.identity != nil else { throw BatteryPauseError.ownership }
    return owner
  }

  /// Called only by the bundled command-line helper, never in the app process.
  public static func runHelper(ownershipURL: URL, journalURL: URL, runner: URL, socket: String) async throws {
    try await runHelper(ownershipURL: ownershipURL, journalURL: journalURL, power: MacPowerSource.read,
      paneRoots: { owner in try await BatteryPaneTargets.resolve(owner: owner, runner: runner, socket: socket) })
  }

  static func runHelper(ownershipURL: URL, journalURL: URL,
                        power: @Sendable () -> MacPowerSource,
                        paneRoots: @Sendable (LocalServerOwnership) async throws -> [BatteryProcess] = { _ in [] }) async throws {
    let lock = open(journalURL.appendingPathExtension("lock").path, O_CREAT | O_RDWR | O_NOFOLLOW, 0o600)
    guard lock >= 0 else { throw BatteryPauseError.helper }
    defer { close(lock) }
    guard flock(lock, LOCK_EX | LOCK_NB) == 0 else { throw BatteryPauseError.alreadyRunning }
    let owner = try owner(at: ownershipURL)
    guard let server = BatteryProcess(owner.pid), let helper = BatteryProcess(getpid()) else {
      throw BatteryPauseError.ownership
    }
    var journal = BatteryPauseJournal(phase: .pausing, helper: helper, server: server, processes: [])
    try journal.save(journalURL)
    let resumeURL = journalURL.appendingPathExtension("resume")
    do {
      let sessions = try BatterySessionIDs.read(owner.expectedIdentity.databasePath)
      // Check again after the DB read: no process is frozen if power has already returned.
      guard power() == .battery else {
        journal.phase = .running
        try journal.save(journalURL)
        return
      }
      journal.groupKeeper = try keepProcessGroup(server.pid)
      try journal.save(journalURL)
      try await suspend(server, journal: &journal, url: journalURL)
      let roots = try await paneRoots(owner)
      for process in roots {
        try await suspend(process, journal: &journal, url: journalURL)
      }
      try await suspendWork(sessions: sessions, roots: roots, journal: &journal, url: journalURL)
      journal.phase = .paused
      try journal.save(journalURL)
      // One cheap IOKit read every two seconds; no subprocesses, HTTP polling or busy loop.
      // This also picks up manual Resume while the app's connection is intentionally asleep.
      while power() != .external && server.alive
        && !FileManager.default.fileExists(atPath: resumeURL.path) {
        try await Task.sleep(for: .seconds(2))
      }
      try journal.resume(journalURL)
      try? FileManager.default.removeItem(at: resumeURL)
    } catch {
      try journal.resume(journalURL)
      journal.phase = .failed
      try journal.save(journalURL)
      throw error
    }
  }

  /// When the app quits, Darwin resumes orphaned stopped process groups. Keep one sleeping
  /// member whose parent is this independent guardian, so the server group never becomes
  /// orphaned during the pause. No polling, inherited descriptors, or running server code.
  static func keepProcessGroup(_ group: Int32) throws -> BatteryProcess {
    var attributes: posix_spawnattr_t?
    guard posix_spawnattr_init(&attributes) == 0 else { throw BatteryPauseError.helper }
    defer { posix_spawnattr_destroy(&attributes) }
    guard posix_spawnattr_setpgroup(&attributes, group) == 0,
          posix_spawnattr_setflags(&attributes, Int16(POSIX_SPAWN_SETPGROUP)) == 0 else {
      throw BatteryPauseError.helper
    }
    let executable = strdup("/bin/sleep")!
    let duration = strdup("2147483647")!
    defer { free(executable); free(duration) }
    var argv: [UnsafeMutablePointer<CChar>?] = [executable, duration, nil]
    var pid: Int32 = 0
    let result = posix_spawn(&pid, executable, nil, &attributes, &argv, nil)
    guard result == 0, let child = BatteryProcess(pid) else { throw BatteryPauseError.helper }
    return child
  }

  static func suspend(_ process: BatteryProcess, journal: inout BatteryPauseJournal, url: URL) async throws {
    guard let info = process.info else { return }
    // Already stopped work is not ours to resume later.
    guard info.pbi_status != SSTOP else { return }
    journal.processes.append(process)
    try journal.save(url) // write ahead of SIGSTOP for recovery after helper termination
    try process.signal(SIGSTOP)
    for _ in 0..<100 {
      guard let current = process.info else { return }
      if current.pbi_status == SSTOP { return }
      // A just-spawned shell can still issue SIGCONT during its job-control setup.
      try process.signal(SIGSTOP)
      try await Task.sleep(for: .milliseconds(10))
    }
    throw BatteryPauseError.stopTimeout(pid: process.pid, status: process.info?.pbi_status)
  }

  static func suspendWork(sessions: Set<String>, roots: [BatteryProcess],
                          journal: inout BatteryPauseJournal, url: URL) async throws {
    var owned = Dictionary((journal.processes + roots + [journal.server]).map { ($0.pid, $0) },
                           uniquingKeysWith: { first, _ in first })
    // Freezing parents before rescanning closes the fork race. Include descendants that clear
    // their environment, and marked orphans that have already been reparented to launchd.
    for _ in 0..<20 {
      let snapshot = BatteryProcess.snapshot()
      let candidates = snapshot.filter { process in
        guard process.pid != getpid(), owned[process.pid]?.alive != true,
              !process.isControlProcess, let info = process.info else { return false }
        return owned[Int32(info.pbi_ppid)]?.alive == true
          || process.provenance?.matches(ids: sessions) == true
      }
      if candidates.isEmpty { return }
      for process in candidates {
        owned[process.pid] = process
        try await suspend(process, journal: &journal, url: url)
      }
    }
    throw BatteryPauseError.unstableProcessTree
  }
}
#endif
