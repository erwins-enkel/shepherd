#if os(macOS)
import Foundation
import Synchronization
import os

/// `externallyManaged` is a server we did not start and must not stop — the
/// operator's own `bun run start` in a terminal, or a launchd job.
public enum LocalServerState: Sendable, Equatable {
  case notInstalled, installing, upgradingBun, updating, stopped, starting
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

  /// At most `maxRestarts` within `window` seconds, then stop trying.
  public struct RestartPolicy: Sendable {
    public var maxRestarts = 3
    public var window: TimeInterval = 300
    public var backoff: [TimeInterval] = [1, 2, 4]
    public init() {}
  }

  private let environment: LocalServerEnvironment
  private let log: LogRing
  private let health: @Sendable (LocalServerIdentity) async -> LocalServerIdentity?
  private let runDirectory: URL
  private var ownership: LocalServerOwnership?
  private var captureBootPassword = true
  private let quitting = Mutex<Bool>(false)
  private let monitoringTasks = Mutex<[Task<Void, Never>]>([])
  nonisolated private let configurationName: String
  nonisolated var recordURL: URL { runDirectory.appendingPathComponent(configurationName + ".json") }
  private var logURL: URL { runDirectory.appendingPathComponent(configurationName + ".log") }
  private var passwordURL: URL { runDirectory.appendingPathComponent(configurationName + ".password") }
  private let liveStart = Mutex<KernelProcessIdentity?>(nil)
  private let identityProbe = Mutex<@Sendable (Int32) -> KernelProcessIdentity?>({ KernelProcessIdentity.read($0) })
  private let runner: LocalRunnerStart
  private var launchIdentity: LocalServerIdentity?
  private let clock: any SupervisorClock
  private let makeLaunch: @Sendable () -> LocalServerLaunch?
  private let bunVersion: @Sendable (URL) async -> String?
  private let policy: RestartPolicy

  public private(set) var state: LocalServerState = .stopped
  /// The one-time sign-in offer lives in memory after consuming and deleting
  /// the private credential channel. Generated credentials never enter the log.
  public private(set) var capturedPassword: String?

  private var process: Process?
  private var pump: Task<Void, Never>?
  private var logMaintenance: Task<Void, Never>?
  /// Foundation exit notification for spawned children; pid polling for
  /// adopted servers. File EOF never means the server exited.
  private var exitWatcher: Task<Void, Never>?
  /// Pending backoff-then-relaunch, cancelled by explicit stop or detachment.
  private var supervision: Task<Void, Never>?
  private var recoverySuspended = false
  private var crashTimes: [Date] = []

  /// Bumped on every `spawn()`, and the identity of one child for everything
  /// that outlives a suspension point: the pump's exit report, the exit code
  /// the termination handler publishes, and the health poll.
  ///
  /// An actor serializes calls; it does not stop one from being interleaved
  /// with another *at an `await`*. So every path that suspends re-checks
  /// `generation == spawnGeneration && !stopping` on the way back — not just
  /// on the way in. `childStreamEnded` in particular used to check once and
  /// then wait up to 500 ms for the exit code: a `restart()` landing in that
  /// window spawned the next child, and the stale report resumed to clear
  /// *its* pid and process and start a third one, leaving the second alive and
  /// unowned.
  private var spawnGeneration = 0

  /// The generation whose death has already been through the crash accounting.
  /// A latch, so no second report of the same exit can append a second entry to
  /// `crashTimes` and walk the supervisor into a crash loop it never had.
  private var reportedExit: Int?

  /// Deliberate stop and synchronous detachment suppress crash accounting.
  /// The quit fence is permanent for this supervisor, while Stop is transient.
  ///
  /// It is transient, not a latch: every `startChild()` clears it, because a
  /// stop→start turn (`restart()`) sets it on the way through. That is exactly
  /// why it cannot also carry "the app is quitting" — see `terminationEpoch`.
  private let stopFlag = Mutex<Bool>(false)
  private var stopping: Bool {
    get { stopFlag.withLock { $0 } || quitting.withLock { $0 } }
    set { stopFlag.withLock { $0 = newValue } }
  }

  /// Invalidates lifecycle turns already queued when quit/teardown lands.
  /// `quitting` additionally fences every future spawn on this supervisor.
  private let terminationEpoch = Mutex<Int>(0)

  /// The live child's pid, readable without hopping onto the actor so
  /// synchronous explicit teardown can read it without an actor hop. A
  /// `Mutex<Process?>` would not compile — `Process` is not `Sendable`.
  private let livePID = Mutex<Int32?>(nil)

  /// One child's exit, carrying the generation it belongs to. The code alone
  /// would be ambiguous: this one slot is written by every child's
  /// `terminationHandler` and read by whichever generation happens to be
  /// asking, so an untagged value let a dead child's code answer for the child
  /// that replaced it — reported as its exit code, and, worse, read as proof
  /// that a live but hung child had already died.
  private struct ChildExit: Sendable {
    let generation: Int
    let code: Int32
  }

  /// Set from `Process.terminationHandler`, which Foundation only invokes once
  /// `terminationStatus` is actually valid. The pipe's EOF is a *separate*
  /// notification with no ordering guarantee against it — reading
  /// `terminationStatus` directly from the EOF path raced Foundation's own
  /// bookkeeping and threw `NSInvalidArgumentException` ("task still
  /// running"). Everything here waits on this instead of ever touching
  /// `terminationStatus` itself.
  private let lastExitCode = Mutex<ChildExit?>(nil)

  /// Serializes the lifecycle operations — `start`, `stop`, `restart`, and the
  /// crash loop's `relaunch` — against each other. Actor isolation alone does
  /// not: each of them suspends (the grace-period wait, the health poll), and
  /// every suspension hands the actor to the next caller *mid-operation*. Two
  /// overlapping `restart()`s interleaved exactly that way — the second one's
  /// `stop()` resumed still holding the first child's pid, cleared the pid of
  /// the replacement the first `restart()` had already spawned, cancelled its
  /// pump and declared the supervisor `.stopped`, while its own `start()`
  /// spawned a third child. One live server, two processes.
  private var lifecycleBusy = false
  private var lifecycleWaiters: [CheckedContinuation<Void, Never>] = []

  private func beginLifecycle() async {
    while lifecycleBusy {
      await withCheckedContinuation { lifecycleWaiters.append($0) }
    }
    lifecycleBusy = true
  }

  private func endLifecycle() {
    lifecycleBusy = false
    let waiters = lifecycleWaiters
    lifecycleWaiters.removeAll()
    // All of them; each re-checks the flag above, so exactly one proceeds and
    // the rest park again. Resuming only the first would strand the others
    // whenever that one's own `while` sees the flag already retaken.
    for waiter in waiters { waiter.resume() }
  }

  public init(
    environment: LocalServerEnvironment,
    log: LogRing = LogRing(),
    health: (@Sendable () async -> Bool)? = nil,
    identityHealth: (@Sendable (LocalServerIdentity) async -> Bool)? = nil,
    clock: any SupervisorClock = SystemSupervisorClock(),
    policy: RestartPolicy = RestartPolicy(),
    bunVersion: @escaping @Sendable (URL) async -> String? = { await LocalServerEnvironment.probeBunVersion($0) },
    runDirectory: URL? = nil,
    launch: @escaping @Sendable () -> LocalServerLaunch?
  ) {
    self.environment = environment
    self.log = log
    self.configurationName = LocalServerOwnership.configurationName(environment)
    self.runDirectory = runDirectory ?? environment.homeDirectory.appendingPathComponent(".shepherd/run")
    self.health = { expected in
      if let identityHealth { return await identityHealth(expected) ? expected : nil }
      if let health { return await health() ? expected : nil }
      guard let metadata = await LocalHealthCheck(port: environment.port).read()?.localInstall else { return nil }
      let actual = LocalServerIdentity(metadata)
      return expected.matches(actual) ? actual : nil
    }
    self.runner = LocalRunnerStart(environment: environment, log: log)
    self.clock = clock
    self.policy = policy
    self.makeLaunch = launch
    self.bunVersion = bunVersion
  }

  /// Synchronous quit fence. Cancels observation and pending relaunches, never
  /// signals the server or removes its record. A later app instance adopts it.
  public nonisolated func terminateForQuit() {
    quitting.withLock { $0 = true }
    terminationEpoch.withLock { $0 += 1 }
    stopFlag.withLock { $0 = true }
    monitoringTasks.withLock { tasks in
      for task in tasks { task.cancel() }
      tasks.removeAll()
    }
  }

  private func track(_ task: Task<Void, Never>) {
    monitoringTasks.withLock { tasks in
      if quitting.withLock({ $0 }) { task.cancel() }
      else { tasks.append(task) }
    }
  }

  private func saveOwnership() throws {
    guard let ownership else { return }
    try JSONEncoder().encode(ownership).write(to: recordURL, options: .atomic)
    try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: recordURL.path)
  }

  private func removeOwnership() {
    // A stale supervisor must never delete the replacement's ownership.
    if let stored = try? JSONDecoder().decode(LocalServerOwnership.self, from: Data(contentsOf: recordURL)),
       stored.pid == ownership?.pid, stored.spawnedAt == ownership?.spawnedAt {
      try? FileManager.default.removeItem(at: recordURL)
    }
    ownership = nil
  }

  private func startTail(generation: Int) {
    pump?.cancel()
    let url = logURL
    LocalServerLogTail.maintain(url)
    pump = Task { [weak self] in
      await LocalServerLogTail.run(url) { line in
        await self?.ingestTail(line, generation: generation)
      }
    }
    if let pump { track(pump) }
    logMaintenance?.cancel()
    let maintenance = Task { [weak self] in
      while !Task.isCancelled {
        LocalServerLogTail.maintain(url)
        await self?.consumePassword()
        do { try await Task.sleep(for: .milliseconds(100)) } catch { return }
      }
    }
    logMaintenance = maintenance
    track(maintenance)
  }

  private func consumePassword() {
    guard let bytes = try? Data(contentsOf: passwordURL), !bytes.isEmpty else { return }
    if captureBootPassword && !stopping { capturedPassword = String(decoding: bytes, as: UTF8.self) }
    try? FileManager.default.removeItem(at: passwordURL)
  }

  func setIdentityProbeForTesting(_ probe: @escaping @Sendable (Int32) -> KernelProcessIdentity?) {
    identityProbe.withLock { $0 = probe }
  }

  private nonisolated func currentIdentity(_ pid: Int32) -> KernelProcessIdentity? {
    identityProbe.withLock { $0 }(pid)
  }

  private nonisolated func stillOwns(_ pid: Int32) -> Bool {
    guard let expected = liveStart.withLock({ $0 }) else { return false }
    return currentIdentity(pid) == expected
  }

  private func ingestTail(_ line: String, generation: Int) async {
    guard generation == spawnGeneration, !stopping else { return }
    await ingest(line)
  }

  /// The health response plus the private record establish continuity with an
  /// app-managed install. A foreign listener remains externally managed.
  public func adopt(healthyIdentity: LocalServerIdentity?) async -> Bool {
    await beginLifecycle()
    defer { endLifecycle() }
    guard !quitting.withLock({ $0 }) else { return false }
    if state.isRunning || state == .starting { return state.isRunning }
    guard let data = try? Data(contentsOf: recordURL) else { return false }
    guard let record = try? JSONDecoder().decode(LocalServerOwnership.self, from: data),
          record.pid > 1 else { return false }
    guard record.port == environment.port,
          LocalServerIdentity.canonical(record.appDirectory) == LocalServerIdentity.canonical(environment.appDirectory.path),
          LocalServerIdentity.canonical(record.expectedIdentity.appDirectory) == LocalServerIdentity.canonical(environment.appDirectory.path),
          LocalServerIdentity.canonical(record.expectedIdentity.databasePath) == LocalServerIdentity.canonical(environment.databasePath.path) else { return false }
    // Only a dead process or a proven birth-identity mismatch makes a record
    // stale. Older records without a kernel identity cannot authorize signals.
    guard let current = currentIdentity(record.pid) else {
      if kill(record.pid, 0) != 0 { try? FileManager.default.removeItem(at: recordURL) }
      return false
    }
    guard let start = record.processStart else { return false }
    guard current == start else {
      try? FileManager.default.removeItem(at: recordURL)
      return false
    }
    guard record.processGroup == ownedGroup(of: record.pid),
          let actual = healthyIdentity,
          LocalServerIdentity.canonical(actual.appDirectory) == LocalServerIdentity.canonical(environment.appDirectory.path),
          LocalServerIdentity.canonical(actual.databasePath) == LocalServerIdentity.canonical(environment.databasePath.path),
          (record.identity ?? record.expectedIdentity).matches(actual) else { return false }
    ownership = record
    ownership?.identity = actual
    do { try saveOwnership() } catch { return false }
    launchIdentity = actual
    spawnGeneration += 1
    let generation = spawnGeneration
    liveStart.withLock { $0 = start }
    livePID.withLock { $0 = record.pid }
    stopping = false
    capturedPassword = nil
    captureBootPassword = false
    consumePassword()
    scanTail = ""
    state = .running(pid: record.pid)
    startTail(generation: generation)
    exitWatcher = Task { [weak self] in
      while !Task.isCancelled {
        if self?.stillOwns(record.pid) != true {
          await self?.childExited(generation: generation, code: -1)
          return
        }
        do { try await Task.sleep(for: .milliseconds(100)) } catch { return }
      }
    }
    if let exitWatcher { track(exitWatcher) }
    return true
  }

  /// The production launch spec: `bun run src/index.ts` in the resolved install directory.
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

  /// Starts only an offline runner; an answering daemon is left untouched.
  public func startRunner() async -> Result<Void, LocalServerFailure> { await runner.run() }

  public func logLines() async -> [String] { await log.lines }
  public func clearCapturedPassword() { capturedPassword = nil }

  /// Spawns the child and waits until it answers `/api/health`. A no-op only
  /// while already `.running`, or while a spawn is already in flight
  /// (`.starting` with a live `process`) — not "idempotent" in general.
  /// Called during the crash loop's own backoff window (`.starting`, no
  /// `process` yet) this ends the backoff early and spawns right away,
  /// exactly as `restart()` would; it is `relaunch()`'s own `scheduled ==
  /// spawnGeneration` check, not this call, that keeps the stale backoff
  /// from also spawning once it elapses.
  public func start() async {
    // Read before the gate, not after it: a quit that lands while this call is
    // still queued must reach `startChild()` too.
    let epoch = terminationEpoch.withLock { $0 }
    await beginLifecycle()
    defer { endLifecycle() }
    await startChild(epoch: epoch)
  }

  /// SIGTERM, then SIGKILL after the grace period. Cancels the pumps first, so
  /// the exit that follows is not read as a crash.
  public func stop() async { await stop(gracePeriod: 5) }

  /// `gracePeriod` is internal-only (default 5 s via `stop()`) so tests can
  /// exercise the wait without a multi-second run.
  func stop(gracePeriod: TimeInterval) async {
    await beginLifecycle()
    defer { endLifecycle() }
    await stopChild(gracePeriod: gracePeriod)
  }

  public func restart() async { await restart(gracePeriod: 5) }

  /// One lifecycle turn, not a `stop()` followed by an unrelated `start()`:
  /// holding the gate across both is what stops a second `restart()` from
  /// resuming in the middle of this one.
  func restart(gracePeriod: TimeInterval) async {
    let epoch = terminationEpoch.withLock { $0 }
    await beginLifecycle()
    defer { endLifecycle() }
    guard !quitting.withLock({ $0 }), terminationEpoch.withLock({ $0 }) == epoch else { return }
    await stopChild(gracePeriod: gracePeriod)
    // An operator's own restart forgives the crashes before it, so a server
    // that dies now and then stays supervised instead of accumulating into a
    // crash loop.
    crashTimes.removeAll()
    await startChild(epoch: epoch)
  }

  /// Serialize with a recovery already entering its launch, then inhibit all
  /// subsequent recovery until deployment promotion or rollback has completed.
  public func suspendRecovery() async -> Bool {
    await beginLifecycle()
    defer { endLifecycle() }
    recoverySuspended = true
    supervision?.cancel()
    supervision = nil
    return state.isRunning || state == .starting
  }

  public func resumeRecovery(restartIfNeeded: Bool) async {
    let epoch = terminationEpoch.withLock { $0 }
    await beginLifecycle()
    defer { endLifecycle() }
    recoverySuspended = false
    if restartIfNeeded { await startChild(epoch: epoch) }
  }

  /// A quit invalidates lifecycle work that was already queued. Once a
  /// child has spawned, quitting preserves it and fences further observation.
  private func startChild(epoch: Int) async {
    guard !quitting.withLock({ $0 }), terminationEpoch.withLock({ $0 }) == epoch else { return }
    // `.starting` with a live child is a start already in flight and this is a
    // no-op; `.starting` with none is the crash loop's backoff window, which
    // `relaunch()` is here to end.
    guard !state.isRunning, !(state == .starting && process != nil) else { return }
    guard let launch = makeLaunch() else {
      state = .failed(.bunMissing)
      return
    }
    if launch.executable.lastPathComponent == "bun",
       let version = await bunVersion(launch.executable),
       LocalServerEnvironment.bunTooOld(version) {
      guard !quitting.withLock({ $0 }), terminationEpoch.withLock({ $0 }) == epoch else { return }
      state = .failed(.bunOutdated(version: version))
      return
    }
    guard terminationEpoch.withLock({ $0 }) == epoch, !Task.isCancelled else { return }
    stopping = false
    state = .starting
    let generation: Int
    do { generation = try spawn(launch) } catch {
      Self.logger.error("spawn failed: \(String(describing: error), privacy: .public)")
      state = .failed(.bunMissing)
      return
    }
    // Quit can land between run() and publishing the pid. Keep the child and
    // its record, but do not begin health polling or crash supervision.
    guard !quitting.withLock({ $0 }), terminationEpoch.withLock({ $0 }) == epoch else { return }
    let healthTask = Task { await self.waitForHealth(generation: generation) }
    track(healthTask)
    await healthTask.value
  }

  /// Deliberately does not call the nonisolated `terminateNow()`: that one
  /// busy-waits with `usleep`, which blocks this *actor's* thread for the whole
  /// grace period and stalls every other call on it — including a plain `state`
  /// read — until the child dies or the grace period elapses. This waits with
  /// `Task.sleep` instead, a real suspension point that lets other
  /// actor-isolated work run in between.
  private func stopChild(gracePeriod: TimeInterval) async {
    // Unconditional, and before the cancel below: a `supervision` task already
    // past its own `Task.isCancelled` check is about to call `relaunch()`,
    // which is the second, belt-and-suspenders line of defence against it.
    stopping = true
    // The health task itself can request this teardown on timeout. Drop the
    // registry here, then cancel the observer slots below; cancelling the
    // current task would turn the graceful sleep into a busy wait.
    monitoringTasks.withLock { $0.removeAll() }
    supervision?.cancel()
    supervision = nil
    if let pid = livePID.withLock({ $0 }) {
      // Read *before* the first signal: once the leader is reaped `getpgid`
      // can no longer answer, and the group is what has to die.
      let members = ownedMembers(of: pid)
      deliver(SIGTERM, to: pid)
      let deadline = Date().addingTimeInterval(gracePeriod)
      while Date() < deadline, stillOwns(pid) {
        try? await Task.sleep(for: .milliseconds(20))
      }
      if stillOwns(pid) {
        deliver(SIGKILL, to: pid)
        await reap(pid)
      }
      // The leader dying is not the group dying. SIGTERM went to the whole
      // group, so a member that ignored it is still there — and the loop above
      // ends the moment the leader goes, which used to mean `kill(pid, 0) != 0`
      // and no SIGKILL for anyone. Escalate against the group regardless of
      // what the leader did.
      killSurvivingMembers(members)
      // Only if it is still the pid this call set out to stop. Nothing else
      // may spawn a child while the lifecycle gate is held, so in practice it
      // always is; the guard keeps that a local fact rather than a global one.
      livePID.withLock { if $0 == pid { $0 = nil } }
    }
    pump?.cancel()
    pump = nil
    logMaintenance?.cancel()
    logMaintenance = nil
    exitWatcher?.cancel()
    exitWatcher = nil
    process = nil
    removeOwnership()
    if case .failed = state {} else { state = .stopped }
  }

  /// Explicit synchronous teardown for callers that cannot await (test
  /// cleanup). The app quit path uses `terminateForQuit()` instead.
  public nonisolated func terminateNow(gracePeriod: TimeInterval = 2) {
    terminationEpoch.withLock { $0 += 1 }
    stopFlag.withLock { $0 = true }  // deliberate: the exit is not a crash
    guard let pid = livePID.withLock({ $0 }) else { return }
    // Before the first signal, for the same reason as in `stopChild()`.
    let members = ownedMembers(of: pid)
    deliver(SIGTERM, to: pid)
    let deadline = Date().addingTimeInterval(gracePeriod)
    var leaderIsGone = false
    while Date() < deadline {
      if !stillOwns(pid) {
        leaderIsGone = true
        break
      }
      usleep(20_000)
    }
    if !leaderIsGone {
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
    }
    // Unconditional, exactly as in `stopChild()`: the leader going quietly says
    // nothing about the agents, git and bun workers that shared its group and
    // ignored the SIGTERM. Returning early here is how they used to outlive the
    // server an operator explicitly stopped.
    killSurvivingMembers(members)
    livePID.withLock { if $0 == pid { $0 = nil } }
    let url = recordURL
    if let record = try? JSONDecoder().decode(LocalServerOwnership.self, from: Data(contentsOf: url)),
       record.pid == pid, record.processStart == liveStart.withLock({ $0 }) {
      try? FileManager.default.removeItem(at: url)
    }
  }

  /// Async counterpart of the reap loop in `terminateNow()`, for `stopChild()`'s
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
  /// git, bun workers) die with it instead of surviving an explicit Stop.
  /// Falls back to the bare pid, never the app's own process group.
  private nonisolated func deliver(_ signalNumber: Int32, to pid: Int32) {
    guard stillOwns(pid) else { return }
    if let group = ownedGroup(of: pid) {
      guard stillOwns(pid) else { return }
      killpg(group, signalNumber)
    } else {
      guard stillOwns(pid) else { return }
      kill(pid, signalNumber)
    }
  }

  private nonisolated func ownedMembers(of pid: Int32) -> [(Int32, KernelProcessIdentity)] {
    guard stillOwns(pid), let group = ownedGroup(of: pid) else { return [] }
    return KernelProcessIdentity.groupMembers(group)
  }

  /// After the leader exits its group ID is no longer ownership evidence.
  /// Escalate only against members captured before TERM, validating each birth.
  private nonisolated func killSurvivingMembers(_ members: [(Int32, KernelProcessIdentity)]) {
    for (pid, identity) in members where currentIdentity(pid) == identity {
      kill(pid, SIGKILL)
    }
  }

  /// The child's own process group, when it leads one that is not this app's —
  /// the condition `deliver(_:to:)` signals a group on. `nil` means there is no
  /// group of ours to escalate against, so only the pid may be signalled.
  ///
  /// Callers must read this *before* signalling: `getpgid` answers for a live
  /// or zombie pid, not for a reaped one, so asking again after the leader has
  /// gone gets -1 and the group escapes.
  private nonisolated func ownedGroup(of pid: Int32) -> Int32? {
    let group = getpgid(pid)
    guard group == pid, group != getpgid(0) else { return nil }
    return group
  }

  /// Test-only quit race seam between run() and pid publication.
  var testSeamAfterChildRun: (@Sendable () -> Void)?

  /// Actor-isolated setter for `testSeamAfterChildRun`: mutating actor state
  /// from outside the actor needs an isolated method even under
  /// `@testable import`.
  func setTestSeamAfterChildRun(_ hook: @escaping @Sendable () -> Void) {
    testSeamAfterChildRun = hook
  }

  /// Returns the new child's generation, so its caller can carry that identity
  /// through every suspension point that follows.
  private func spawn(_ launch: LocalServerLaunch) throws -> Int {
    // The shell wrapper would otherwise turn a missing executable into a
    // short-lived successful spawn instead of the existing bunMissing failure.
    guard FileManager.default.isExecutableFile(atPath: launch.executable.path) else {
      throw CocoaError(.executableNotLoadable)
    }
    try FileManager.default.createDirectory(at: runDirectory, withIntermediateDirectories: true,
      attributes: [.posixPermissions: 0o700])
    // Rotate and open with private permissions before launching. The child
    // inherits these files, never an app-owned pipe or terminal.
    let previous = URL(fileURLWithPath: logURL.path + ".1")
    LocalServerLogTail.maintain(logURL)
    if FileManager.default.fileExists(atPath: logURL.path) {
      let size = (try? FileManager.default.attributesOfItem(atPath: logURL.path)[.size] as? NSNumber)?.uint64Value ?? 0
      if size > 0 {
        try? FileManager.default.removeItem(at: previous)
        try FileManager.default.moveItem(at: logURL, to: previous)
      } else {
        // maintain() already saved the capped previous copy before truncating.
        try FileManager.default.removeItem(at: logURL)
      }
    }
    let fd = open(logURL.path, O_WRONLY | O_APPEND | O_CREAT | O_EXCL | O_NOFOLLOW, 0o600)
    guard fd >= 0 else { throw CocoaError(.fileWriteUnknown) }
    let output = FileHandle(fileDescriptor: fd, closeOnDealloc: true)
    let input = try FileHandle(forReadingFrom: URL(fileURLWithPath: "/dev/null"))
    defer { try? output.close(); try? input.close() }
    let child = Process()
    // Ignore HUP across exec, including the Darwin orphaned-group notification
    // when a descendant is stopped as the app exits. No terminal is inherited.
    child.executableURL = URL(fileURLWithPath: "/bin/sh")
    child.arguments = ["-c", "trap '' HUP; exec \"$@\"", "shepherd-server", launch.executable.path] + launch.arguments
    child.currentDirectoryURL = launch.workingDirectory
    let identity = LocalServerIdentity(appDirectory: environment.appDirectory.path,
                                       databasePath: environment.databasePath.path,
                                       instanceID: UUID().uuidString)
    launchIdentity = identity
    var childEnvironment = launch.environment
    childEnvironment["SHEPHERD_LOCAL_SUPERVISION"] = "1"
    childEnvironment["SHEPHERD_LOCAL_INSTANCE_ID"] = identity.instanceID
    // A one-shot private channel keeps the generated credential off stdout
    // even when boot finishes after the app exits. Never set SHEPHERD_PASSWORD:
    // that would overwrite an operator's persisted password on every restart.
    try? FileManager.default.removeItem(at: passwordURL)
    let passwordFD = open(passwordURL.path, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0o600)
    guard passwordFD >= 0 else { throw CocoaError(.fileWriteUnknown) }
    close(passwordFD)
    childEnvironment["SHEPHERD_LOCAL_PASSWORD_FILE"] = passwordURL.path
    child.environment = childEnvironment
    child.standardInput = input
    child.standardOutput = output
    child.standardError = output
    // Bumped before `run()` so the termination handler can tag its exit code
    // with the generation it belongs to. A spawn that throws still burns a
    // generation, which is harmless: it only invalidates reports about a child
    // that was never started.
    spawnGeneration += 1
    let generation = spawnGeneration
    scanTail = ""
    captureBootPassword = true
    capturedPassword = nil
    // The one-shot death signal this child's watcher parks on. Foundation
    // invokes `terminationHandler` off any thread and only once
    // `terminationStatus` is valid, so a `Sendable` stream continuation is what
    // carries it back onto the actor.
    let (exits, exitSignal) = AsyncStream<Int32>.makeStream()
    child.terminationHandler = { [weak self] proc in
      let code = proc.terminationStatus
      self?.lastExitCode.withLock { $0 = ChildExit(generation: generation, code: code) }
      exitSignal.yield(code)
      exitSignal.finish()
    }
    do { try child.run() } catch {
      exitSignal.finish()
      throw error
    }
    testSeamAfterChildRun?()

    process = child
    let pid = child.processIdentifier
    livePID.withLock { $0 = pid }
    // Not `.running(pid:)`: that is a promise the server answers requests, and
    // nothing has asked it yet. `waitForHealth()` promotes it once `/api/health`
    // says yes.
    state = .starting
    Self.logger.info("local server started, pid \(pid, privacy: .public)")

    guard let start = KernelProcessIdentity.read(pid, requireRunning: false) else {
      // No birth identity means no authority to signal even during setup.
      livePID.withLock { $0 = nil }
      process = nil
      throw CocoaError(.executableLoad)
    }
    liveStart.withLock { $0 = start }
    guard let group = ownedGroup(of: pid) else {
      deliver(SIGKILL, to: pid)
      livePID.withLock { $0 = nil }
      process = nil
      throw CocoaError(.executableLoad)
    }
    ownership = LocalServerOwnership(pid: pid, processGroup: group, port: environment.port,
      spawnedAt: Date(), processStart: start, executable: launch.executable.path,
      appDirectory: environment.appDirectory.path, expectedIdentity: identity, identity: nil)
    do { try saveOwnership() } catch {
      deliver(SIGKILL, to: pid)
      livePID.withLock { $0 = nil }
      process = nil
      throw error
    }
    startTail(generation: generation)
    exitWatcher?.cancel()
    exitWatcher = Task { [weak self] in
      for await code in exits {
        await self?.childExited(generation: generation, code: code)
        return
      }
    }
    if let exitWatcher { track(exitWatcher) }
    return generation
  }

  /// `BootLineScanner` needs the whole `Operator password (shown ONCE): `
  /// prefix inside one string, and the pump does not always deliver it that
  /// way: it force-flushes a partial line at `maxPartialLineBytes`, and a
  /// bounded buffering policy puts a `dropMarker` between the fragment that
  /// ended at a hole and the one that resumes after it. Either can split the
  /// prefix from the secret. The prefix is 32 bytes, so this much of the
  /// previous fragment is plenty to join the two back together.
  private static let scanCarryOver = 128
  private var scanTail = ""

  /// One line of child output. Nothing here reaches os.Logger: the child may
  /// print anything, including the password we are about to redact.
  ///
  /// The scan runs against `scanTail + line`, never `line` alone. A match that
  /// only appears once the two are joined still scrubs correctly: `LogRing`
  /// rewrites what is already buffered, so the fragment appended first is
  /// redacted retroactively, and this line is appended after `redact`.
  private func ingest(_ line: String) async {
    let joined = scanTail + line
    if let password = BootLineScanner.generatedPassword(in: joined) {
      if captureBootPassword { capturedPassword = password }
      await log.redact(password)
      LocalServerLogTail.redact(password, in: logURL)
      // Consumed. A banner left in the carry-over makes the *next* line read as
      // a continuation of the same secret — the scanner stops at the first
      // character outside `[A-Za-z0-9_-]`, so the password would come back with
      // that line's first word glued to its end.
      scanTail = ""
    } else if !ProcessOutputPump.isDropMarker(line) {
      // A drop marker is the pump's own words, not the child's. Carrying it
      // forward would push a banner fragment out of reach of the very next line
      // — which is exactly where the secret lands when a drop is what split it.
      scanTail = String(joined.suffix(Self.scanCarryOver))
    }
    await log.append(line)
  }

  /// The child this supervisor owns has exited, as reported by
  /// `Process.terminationHandler` — the only notification that means it. Runs
  /// at most once per generation (`reportedExit`), so nothing can put the same
  /// death through the crash accounting twice.
  private func childExited(generation: Int, code: Int32) async {
    guard generation == spawnGeneration, !stopping else { return }
    guard reportedExit != generation else { return }
    reportedExit = generation
    pump?.cancel()
    await pump?.value
    guard generation == spawnGeneration, !stopping else { return }
    livePID.withLock { $0 = nil }
    process = nil
    state = .failed(.exited(code: code))
    Self.logger.error("local server exited with \(code, privacy: .public)")
    await handleCrash(exitCode: code, generation: generation)
  }

  /// Polls health for up to 30 s. Readiness is the health answer, not the ready
  /// line: the line is a nicety the server may stop printing, `/api/health` is
  /// the contract.
  private func waitForHealth(generation: Int) async {
    for _ in 0..<60 {
      if Task.isCancelled || stopping { return }
      guard let identity = launchIdentity else { return }
      if let actual = await health(identity) {
        // The health answer is about the child that was live when it was
        // asked; a stop or the next spawn can land in that await.
        guard generation == spawnGeneration, !stopping else { return }
        ownership?.identity = actual
        do { try saveOwnership() } catch {
          await stopChild(gracePeriod: 5)
          state = .failed(.bootstrapWrite)
          return
        }
        if let pid = livePID.withLock({ $0 }) { state = .running(pid: pid) }
        return
      }
      guard generation == spawnGeneration, !stopping else { return }
      if process == nil { return }  // died meanwhile; childStreamEnded handles it
      try? await clock.sleep(for: 0.5)
      // `clock` is injected and arbitrary — a test double's `sleep` may return
      // without spending any real time at all.
      guard generation == spawnGeneration, !stopping else { return }
    }
    // The budget is spent, and "never answered" is not "dead": a hung child is
    // still there and must be torn down, a crashed one belongs to
    // `childStreamEnded`'s restart accounting. Ask the OS which it is rather
    // than inferring it from how much wall time happened to pass — under a
    // clock that spends none, all 60 polls above can run before a dead child's
    // pipe EOF has even been delivered.
    if await childHasExited(generation: generation) { return }
    guard generation == spawnGeneration, !stopping else { return }
    await stopChild(gracePeriod: 5)
    state = .failed(.healthTimeout)
  }

  /// Whether this child is already gone. `kill(pid, 0)` cannot answer it on its
  /// own — a dead child Foundation has not reaped yet is a zombie, and a zombie
  /// still answers `kill` — so this waits a bounded amount of *real* time for
  /// the termination handler, the one signal that is never ambiguous.
  private func childHasExited(generation: Int) async -> Bool {
    for _ in 0..<25 {
      // Already accounted for, or no longer ours to judge.
      guard generation == spawnGeneration, !stopping else { return true }
      if process == nil { return true }
      if let exit = lastExitCode.withLock({ $0 }), exit.generation == generation { return true }
      if let pid = livePID.withLock({ $0 }), kill(pid, 0) != 0 { return true }
      try? await Task.sleep(for: .milliseconds(20))
    }
    return false
  }

  /// `maxRestarts` within `window`, with `backoff` between them, then give up
  /// and leave `.failed(.crashLoop:)` on screen.
  private func handleCrash(exitCode: Int32, generation: Int) async {
    let now = await clock.now
    guard generation == spawnGeneration, !stopping else { return }
    guard !recoverySuspended else {
      state = .failed(.exited(code: exitCode))
      return
    }
    crashTimes.append(now)
    crashTimes.removeAll { now.timeIntervalSince($0) > policy.window }

    guard crashTimes.count <= policy.maxRestarts else {
      state = .failed(.crashLoop(restarts: policy.maxRestarts))
      Self.logger.error("local server crash-looped after exit \(exitCode, privacy: .public)")
      return
    }
    let delay = policy.backoff[min(crashTimes.count - 1, policy.backoff.count - 1)]
    state = .starting
    // The world this backoff was scheduled in. Anything that spawns while it
    // runs — an operator's `start()` or `restart()` — moves `spawnGeneration`
    // on, and this relaunch then has nothing left to do.
    let scheduled = spawnGeneration
    supervision = Task { [weak self] in
      try? await self?.clock.sleep(for: delay)
      guard !Task.isCancelled else { return }
      await self?.relaunch(scheduled: scheduled)
    }
    if let supervision { track(supervision) }
  }

  /// Takes the lifecycle gate like every other spawn/teardown path: a backoff
  /// that expires while an operator's `stop()` or `restart()` is mid-flight
  /// must queue behind it, not spawn into the middle of it.
  ///
  /// And parking on that gate is a suspension like any other, so the checks
  /// above it are worth nothing on the way back. A `restart()` holding the gate
  /// stops the crashed child, spawns its own replacement and ends its turn;
  /// this one then resumed and — seeing only that no stop was in progress —
  /// spawned a *third* child, leaving the replacement alive and unowned while
  /// the supervisor's own state pointed elsewhere. `Task.isCancelled` catches
  /// the deliberate teardown (`stopChild()` cancels this task), `scheduled`
  /// catches everything that replaced the child without cancelling anything.
  private func relaunch(scheduled: Int) async {
    let epoch = terminationEpoch.withLock { $0 }
    await beginLifecycle()
    defer { endLifecycle() }
    guard !Task.isCancelled, !recoverySuspended, scheduled == spawnGeneration else { return }
    await startChild(epoch: epoch)
  }
}

#if DEBUG
extension LocalServerSupervisor {
  /// Test seam for the boot-line scanner's carry-over. `ingest(_:)` is private
  /// and only ever fed by the pump, and one of the two ways a banner gets split
  /// — a `dropMarker` line landing between the prefix and the secret — needs a
  /// 4096-chunk buffer overflow to provoke through a real child. The fragments
  /// go in here instead.
  func ingestForTesting(_ line: String) async { await ingest(line) }
}
#endif
#endif
