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

  /// Bumped on every `spawn()`. A pump captures the generation of the child it
  /// is reading; `childStreamEnded(generation:)` ignores a report whose
  /// generation is stale. `stop()` cancels the pump, but Swift Task
  /// cancellation does not abort an in-flight `for await` loop over the pipe's
  /// chunks, so a late EOF from the child being stopped can still reach the
  /// actor after `restart()` has already spawned the next one. Without this
  /// guard that stale report reads `terminationStatus` off the *new*, still
  /// running `Process` — an `NSInvalidArgumentException` crash — and can also
  /// trigger a spurious extra restart.
  private var spawnGeneration = 0

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

  /// Set from `Process.terminationHandler`, which Foundation only invokes once
  /// `terminationStatus` is actually valid. The pipe's EOF is a *separate*
  /// notification with no ordering guarantee against it — reading
  /// `terminationStatus` directly from the EOF path raced Foundation's own
  /// bookkeeping and threw `NSInvalidArgumentException` ("task still
  /// running"). `childStreamEnded` waits briefly on this instead of ever
  /// touching `terminationStatus` itself.
  private let lastExitCode = Mutex<Int32?>(nil)

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
  public func stop() async { await stop(gracePeriod: 5) }

  /// `gracePeriod` is internal-only (default 5 s via `stop()`) so tests can
  /// exercise the wait without a multi-second run. Deliberately does not call
  /// the nonisolated `terminateNow()`: that one busy-waits with `usleep`,
  /// which blocks this *actor's* thread for the whole grace period and stalls
  /// every other call on it — including a plain `state` read — until the
  /// child dies or the grace period elapses. This waits with `Task.sleep`
  /// instead, a real suspension point that lets other actor-isolated work run
  /// in between.
  func stop(gracePeriod: TimeInterval) async {
    // Unconditional, and before the cancel below: a `supervision` task already
    // past its own `Task.isCancelled` check is about to call `relaunch()`,
    // which is the second, belt-and-suspenders line of defence against it.
    stopping = true
    supervision?.cancel()
    supervision = nil
    if let pid = livePID.withLock({ $0 }) {
      deliver(SIGTERM, to: pid)
      let deadline = Date().addingTimeInterval(gracePeriod)
      while Date() < deadline, kill(pid, 0) == 0 {
        try? await Task.sleep(for: .milliseconds(20))
      }
      if kill(pid, 0) == 0 {
        deliver(SIGKILL, to: pid)
        await reap(pid)
      }
      livePID.withLock { $0 = nil }
    }
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
  /// gets no `await`. Safe to call when nothing is running — including
  /// speculatively, e.g. mid crash-loop backoff, when there is no live child
  /// to terminate: it must be a true no-op then, or it would mark `stopping`
  /// and permanently block the backoff's own relaunch (which, unlike
  /// `start()`, never clears that flag itself).
  public nonisolated func terminateNow(gracePeriod: TimeInterval = 2) {
    guard let pid = livePID.withLock({ $0 }) else { return }
    stopFlag.withLock { $0 = true }  // deliberate: the exit is not a crash
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
    // Foundation's own `Process` machinery usually wins this reap, so this
    // loop most often finds nothing left to do; it stays in case it doesn't,
    // so no zombie outlives us. A single `WNOHANG` call right after SIGKILL
    // reaps nothing — the kernel has not processed the death yet.
    var status: Int32 = 0
    for _ in 0..<10 {
      if waitpid(pid, &status, WNOHANG) == pid { break }
      usleep(20_000)
    }
    livePID.withLock { $0 = nil }
  }

  /// Async counterpart of the reap loop in `terminateNow()`, for `stop()`'s
  /// non-blocking path.
  private func reap(_ pid: Int32) async {
    var status: Int32 = 0
    for _ in 0..<10 {
      if waitpid(pid, &status, WNOHANG) == pid { return }
      try? await Task.sleep(for: .milliseconds(20))
    }
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
    lastExitCode.withLock { $0 = nil }  // clear the previous child's code, if any
    child.terminationHandler = { [weak self] proc in
      self?.lastExitCode.withLock { $0 = proc.terminationStatus }
    }
    try child.run()

    process = child
    let pid = child.processIdentifier
    livePID.withLock { $0 = pid }
    state = .running(pid: pid)
    spawnGeneration += 1
    let generation = spawnGeneration
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
      await self?.childStreamEnded(generation: generation)
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
  /// Bounded rather than `.unbounded`: a child that logs far faster than the
  /// actor can drain it (a runaway loop, say) must not grow this buffer
  /// without limit. 4096 chunks is generous for a log pump; past that, the
  /// oldest unread chunks are dropped so memory stays bounded instead of the
  /// operator's log.
  private static let chunkBufferCapacity = 4096

  private nonisolated static func chunks(from handle: FileHandle) -> AsyncStream<Data> {
    AsyncStream(Data.self, bufferingPolicy: .bufferingNewest(chunkBufferCapacity)) { continuation in
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

  private func childStreamEnded(generation: Int) async {
    // A stale report from a child this supervisor has already moved past —
    // see `spawnGeneration`'s doc comment.
    guard generation == spawnGeneration else { return }
    guard !stopping else { return }
    let code = await exitCode()
    livePID.withLock { $0 = nil }
    process = nil
    Self.logger.error("local server exited with \(code, privacy: .public)")
    await handleCrash(exitCode: code)
  }

  /// The child has already closed its pipe by the time this is called, so
  /// `terminationHandler` firing is imminent, not a wait on a live process —
  /// see `lastExitCode`'s doc comment for why this never reads
  /// `terminationStatus` directly.
  private func exitCode() async -> Int32 {
    for _ in 0..<25 {
      if let code = lastExitCode.withLock({ $0 }) { return code }
      try? await Task.sleep(for: .milliseconds(20))
    }
    return -1
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
      // `clock` can be a test double whose `sleep` returns without spending
      // any real time (a fixed backoff assertion needs exactly that). Without
      // ever spending real time, all 60 iterations here can run faster than
      // the pipe's EOF is delivered and `childStreamEnded` gets a turn on
      // this actor — outrunning a child that has, in reality, already exited.
      // A short real sleep guarantees the scheduler a chance to catch up.
      try? await Task.sleep(for: .milliseconds(2))
    }
    // The child never answered — but it may well still be running (hung, not
    // dead), so this must not be reported as `.exited`, which would claim the
    // process is gone when it is not. Tear it down so nothing keeps running
    // unsupervised behind a state that says otherwise.
    await stop()
    state = .failed(.healthTimeout)
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
