#if os(macOS)
import Foundation
import Synchronization
import os

/// `externallyManaged` is a server we did not start and must not stop — the
/// operator's own `bun run start` in a terminal, or a launchd job.
public enum LocalServerState: Sendable, Equatable {
  case notInstalled, installing, stopped, starting
  case running(pid: Int32)
  case externallyManaged
  case failed(LocalServerFailure)

  public var isRunning: Bool {
    if case .running = self { return true }
    return false
  }
  public var pid: Int32? {
    if case .running(let pid) = self { return pid }
    return nil
  }
}

/// Injected so backoff is asserted, not waited out.
public protocol SupervisorClock: Sendable {
  var now: Date { get async }
  func sleep(for seconds: TimeInterval) async throws
}

public struct SystemSupervisorClock: SupervisorClock {
  public init() {}
  public var now: Date { get async { Date() } }
  public func sleep(for seconds: TimeInterval) async throws {
    try await Task.sleep(for: .seconds(seconds))
  }
}

/// Everything needed to spawn one child. A value type so tests can point the
/// supervisor at a /bin/sh script instead of bun.
public struct LocalServerLaunch: Sendable {
  public let executable: URL
  public let arguments: [String]
  public let workingDirectory: URL
  public let environment: [String: String]
  public init(
    executable: URL, arguments: [String], workingDirectory: URL, environment: [String: String]
  ) {
    self.executable = executable
    self.arguments = arguments
    self.workingDirectory = workingDirectory
    self.environment = environment
  }
}

/// Owns at most one child Shepherd server: spawn, output capture, health, crash
/// restart, shutdown. No UI, no AppModel — the app layer mirrors `state`.
public actor LocalServerSupervisor {
  static let logger = Logger(subsystem: "run.shepherd.mac", category: "localserver")

  /// A child that prints megabytes without a newline must not grow the pump's
  /// buffer without bound; at this size the partial line is flushed as-is.
  private static let maxPartialLineBytes = 64 * 1024

  /// At most `maxRestarts` within `window` seconds, then stop trying.
  public struct RestartPolicy: Sendable {
    public var maxRestarts = 3
    public var window: TimeInterval = 300
    public var backoff: [TimeInterval] = [1, 2, 4]
    public init() {}
  }

  private let environment: LocalServerEnvironment
  private let log: LogRing
  private let health: @Sendable () async -> Bool
  private let clock: any SupervisorClock
  private let makeLaunch: @Sendable () -> LocalServerLaunch?
  private let policy: RestartPolicy

  public private(set) var state: LocalServerState = .stopped
  /// In memory only, for the one "sign in with the generated password" offer.
  /// Never persisted, never logged (D4).
  public private(set) var capturedPassword: String?

  private var process: Process?
  private var pump: Task<Void, Never>?
  private var supervision: Task<Void, Never>?
  private var crashTimes: [Date] = []

  /// Set while the child is torn down on purpose, so the exit that follows is
  /// not read as a crash and restarted. It lives in a `Mutex` rather than in
  /// actor state because `terminateNow()` — the nonisolated quit path — has to
  /// set it too: without that, killing the child at app quit looked exactly
  /// like a crash and the supervisor spawned a replacement on the way out.
  private let stopFlag = Mutex<Bool>(false)
  private var stopping: Bool {
    get { stopFlag.withLock { $0 } }
    set { stopFlag.withLock { $0 = newValue } }
  }

  /// The live child's pid, readable without hopping onto the actor so
  /// `terminateNow()` can run inside `applicationWillTerminate` (D2). A
  /// `Mutex<Process?>` would not compile — `Process` is not `Sendable`.
  private let livePID = Mutex<Int32?>(nil)

  public init(
    environment: LocalServerEnvironment,
    log: LogRing = LogRing(),
    health: @escaping @Sendable () async -> Bool,
    clock: any SupervisorClock = SystemSupervisorClock(),
    policy: RestartPolicy = RestartPolicy(),
    launch: @escaping @Sendable () -> LocalServerLaunch?
  ) {
    self.environment = environment
    self.log = log
    self.health = health
    self.clock = clock
    self.policy = policy
    self.makeLaunch = launch
  }

  /// The production launch spec: `bun run src/index.ts` in `~/.shepherd/app`.
  public static func defaultLaunch(
    _ environment: LocalServerEnvironment
  ) -> @Sendable () -> LocalServerLaunch? {
    {
      guard let bun = environment.locateBun() else { return nil }
      return LocalServerLaunch(
        executable: bun, arguments: ["run", "src/index.ts"],
        workingDirectory: environment.appDirectory,
        environment: environment.spawnEnvironment(bun: bun))
    }
  }

  public func logLines() async -> [String] { await log.lines }
  public func clearCapturedPassword() { capturedPassword = nil }

  /// Spawns the child and waits until it answers `/api/health`. Idempotent.
  public func start() async {
    guard !state.isRunning, state != .starting else { return }
    guard let launch = makeLaunch() else {
      state = .failed(.bunMissing)
      return
    }
    stopping = false
    state = .starting
    do { try spawn(launch) } catch {
      Self.logger.error("spawn failed: \(String(describing: error), privacy: .public)")
      state = .failed(.bunMissing)
      return
    }
    await waitForHealth()
  }

  /// SIGTERM, then SIGKILL after the grace period. Cancels the pumps first, so
  /// the exit that follows is not read as a crash.
  public func stop() async {
    stopping = true
    supervision?.cancel()
    supervision = nil
    terminateNow(gracePeriod: 5)
    pump?.cancel()
    pump = nil
    process = nil
    if case .failed = state {} else { state = .stopped }
  }

  public func restart() async {
    await stop()
    crashTimes.removeAll()
    await start()
  }

  /// Synchronous, actor-free child kill for `applicationWillTerminate`, which
  /// gets no `await`. Safe to call when nothing is running.
  public nonisolated func terminateNow(gracePeriod: TimeInterval = 2) {
    stopFlag.withLock { $0 = true }  // deliberate: the exit is not a crash
    guard let pid = livePID.withLock({ $0 }) else { return }
    deliver(SIGTERM, to: pid)
    let deadline = Date().addingTimeInterval(gracePeriod)
    while Date() < deadline {
      if kill(pid, 0) != 0 {
        livePID.withLock { $0 = nil }
        return
      }
      usleep(20_000)
    }
    deliver(SIGKILL, to: pid)
    var status: Int32 = 0
    _ = waitpid(pid, &status, WNOHANG)  // reap, so no zombie outlives us
    livePID.withLock { $0 = nil }
  }

  /// Signals the child's whole process group when it leads one — `Process` puts
  /// every child in a group of its own — so the server's own children (agents,
  /// git, bun workers) die with it instead of being reparented to launchd and
  /// outliving the app. Falls back to the bare pid, and never signals the group
  /// this app itself is in.
  private nonisolated func deliver(_ signalNumber: Int32, to pid: Int32) {
    let group = getpgid(pid)
    if group == pid, group != getpgid(0) {
      killpg(group, signalNumber)
    } else {
      kill(pid, signalNumber)
    }
  }

  private func spawn(_ launch: LocalServerLaunch) throws {
    let pipe = Pipe()
    let child = Process()
    child.executableURL = launch.executable
    child.arguments = launch.arguments
    child.currentDirectoryURL = launch.workingDirectory
    child.environment = launch.environment
    // One pipe for both streams: the operator reads a single interleaved log,
    // and two pipes would need two pumps and could deadlock on a full buffer.
    child.standardOutput = pipe
    child.standardError = pipe
    try child.run()

    process = child
    let pid = child.processIdentifier
    livePID.withLock { $0 = pid }
    state = .running(pid: pid)
    Self.logger.info("local server started, pid \(pid, privacy: .public)")

    let chunks = Self.chunks(from: pipe.fileHandleForReading)
    pump = Task { [weak self] in
      // A pipe read boundary is not a line boundary: bytes are accumulated here
      // and split on "\n", so `BootLineScanner` — which only understands whole
      // lines — never sees half of the password banner.
      var partial: [UInt8] = []
      func flush() async {
        guard !partial.isEmpty else { return }
        let line = Self.decodeLine(partial)
        partial.removeAll(keepingCapacity: true)
        await self?.ingest(line)
      }
      for await chunk in chunks {
        for byte in chunk {
          if byte == UInt8(ascii: "\n") {
            await flush()
          } else {
            partial.append(byte)
            if partial.count >= Self.maxPartialLineBytes { await flush() }
          }
        }
      }
      await flush()  // whatever the child printed without a final newline
      await self?.childStreamEnded()
    }
  }

  /// The child's merged stdout/stderr as ordered chunks.
  ///
  /// Deliberately not `FileHandle.bytes`: that sequence serializes every handle
  /// in the process onto one reader, so a pump still parked on a dead child's
  /// pipe starves the next child's output entirely — and it offers no way to let
  /// go of the handle. `readabilityHandler` fires on the handle's own queue, in
  /// order, and `onTermination` detaches it when the pump is cancelled, so the
  /// `Pipe` deallocates and closes both descriptors.
  private nonisolated static func chunks(from handle: FileHandle) -> AsyncStream<Data> {
    AsyncStream(Data.self, bufferingPolicy: .unbounded) { continuation in
      handle.readabilityHandler = { handle in
        let data = handle.availableData
        if data.isEmpty {  // EOF: the child closed its end
          handle.readabilityHandler = nil
          continuation.finish()
        } else {
          continuation.yield(data)
        }
      }
      continuation.onTermination = { _ in handle.readabilityHandler = nil }
    }
  }

  /// One buffered line, minus the `\r` of a `\r\n` pair. Invalid UTF-8 is
  /// repaired rather than dropped — child output is not ours to trust.
  private static func decodeLine(_ bytes: [UInt8]) -> String {
    var bytes = bytes
    if bytes.last == UInt8(ascii: "\r") { bytes.removeLast() }
    return String(decoding: bytes, as: UTF8.self)
  }

  /// One line of child output. Nothing here reaches os.Logger: the child may
  /// print anything, including the password we are about to redact.
  private func ingest(_ line: String) async {
    if let password = BootLineScanner.generatedPassword(in: line) {
      capturedPassword = password
      await log.redact(password)
    }
    await log.append(line)
  }

  private func childStreamEnded() async {
    guard !stopping else { return }
    let code = process?.terminationStatus ?? -1
    livePID.withLock { $0 = nil }
    process = nil
    Self.logger.error("local server exited with \(code, privacy: .public)")
    await handleCrash(exitCode: code)
  }

  /// Polls health for up to 30 s. Readiness is the health answer, not the ready
  /// line: the line is a nicety the server may stop printing, `/api/health` is
  /// the contract.
  private func waitForHealth() async {
    for _ in 0..<60 {
      if Task.isCancelled || stopping { return }
      if await health() {
        if let pid = livePID.withLock({ $0 }) { state = .running(pid: pid) }
        return
      }
      if process == nil { return }  // died meanwhile; childStreamEnded handles it
      try? await clock.sleep(for: 0.5)
    }
    state = .failed(.exited(code: -1))
  }

  /// `maxRestarts` within `window`, with `backoff` between them, then give up
  /// and leave `.failed(.crashLoop:)` on screen.
  private func handleCrash(exitCode: Int32) async {
    let now = await clock.now
    crashTimes.append(now)
    crashTimes.removeAll { now.timeIntervalSince($0) > policy.window }

    guard crashTimes.count <= policy.maxRestarts else {
      state = .failed(.crashLoop(restarts: policy.maxRestarts))
      Self.logger.error("local server crash-looped after exit \(exitCode, privacy: .public)")
      return
    }
    let delay = policy.backoff[min(crashTimes.count - 1, policy.backoff.count - 1)]
    state = .starting
    supervision = Task { [weak self] in
      try? await self?.clock.sleep(for: delay)
      guard !Task.isCancelled else { return }
      await self?.relaunch()
    }
  }

  private func relaunch() async {
    guard !stopping, let launch = makeLaunch() else { return }
    do {
      try spawn(launch)
      await waitForHealth()
    } catch { state = .failed(.bunMissing) }
  }
}
#endif
