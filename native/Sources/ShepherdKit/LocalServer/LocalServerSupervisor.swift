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

  /// Set while the child is torn down on purpose, so the exit that follows is
  /// not read as a crash and restarted. It lives in a `Mutex` rather than in
  /// actor state because `terminateNow()` — the nonisolated quit path — has to
  /// set it too: without that, killing the child at app quit looked exactly
  /// like a crash and the supervisor spawned a replacement on the way out.
  ///
  /// It is transient, not a latch: every `startChild()` clears it, because a
  /// stop→start turn (`restart()`) sets it on the way through. That is exactly
  /// why it cannot also carry "the app is quitting" — see `terminationEpoch`.
  private let stopFlag = Mutex<Bool>(false)
  private var stopping: Bool {
    get { stopFlag.withLock { $0 } }
    set { stopFlag.withLock { $0 = newValue } }
  }

  /// Raised by every `terminateNow()`. A lifecycle turn reads it when it is
  /// called and `startChild()` refuses to spawn if it has moved since — the
  /// quit landed inside that turn.
  ///
  /// A bare flag cannot express this. `stopFlag` is cleared by every
  /// `startChild()`, so a quit that lands while `restart()` waits its old child
  /// out is wiped out by the very spawn it was supposed to stop; and a flag
  /// that is *not* cleared would wedge the crash loop's own relaunch for good,
  /// which `terminateNow()` is explicitly allowed to be called into
  /// speculatively. An epoch separates the two: a turn that had already decided
  /// to spawn before the quit stands down, a turn that begins after one is a
  /// fresh decision and proceeds.
  private let terminationEpoch = Mutex<Int>(0)

  /// The live child's pid, readable without hopping onto the actor so
  /// `terminateNow()` can run inside `applicationWillTerminate` (D2). A
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
    await stopChild(gracePeriod: gracePeriod)
    // An operator's own restart forgives the crashes before it, so a server
    // that dies now and then stays supervised instead of accumulating into a
    // crash loop.
    crashTimes.removeAll()
    await startChild(epoch: epoch)
  }

  /// `epoch` is the caller's `terminationEpoch`, read before it took the
  /// lifecycle gate. `terminateNow()` runs off the actor and lands wherever it
  /// lands — while this turn was still queued on the gate, or while
  /// `stopChild()` was waiting the old child out — and in both of those windows
  /// there is no live pid for it to kill, so its own teardown is a no-op. The
  /// epoch is how the quit reaches the spawn it has to stop; without it the
  /// in-flight restart cleared `stopFlag` and left a server running after the
  /// app had gone.
  private func startChild(epoch: Int) async {
    guard terminationEpoch.withLock({ $0 }) == epoch else { return }
    // `.starting` with a live child is a start already in flight and this is a
    // no-op; `.starting` with none is the crash loop's backoff window, which
    // `relaunch()` is here to end.
    guard !state.isRunning, !(state == .starting && process != nil) else { return }
    guard let launch = makeLaunch() else {
      state = .failed(.bunMissing)
      return
    }
    stopping = false
    state = .starting
    let generation: Int
    do { generation = try spawn(launch) } catch {
      Self.logger.error("spawn failed: \(String(describing: error), privacy: .public)")
      state = .failed(.bunMissing)
      return
    }
    await waitForHealth(generation: generation)
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
      // Only if it is still the pid this call set out to stop. Nothing else
      // may spawn a child while the lifecycle gate is held, so in practice it
      // always is; the guard keeps that a local fact rather than a global one.
      livePID.withLock { if $0 == pid { $0 = nil } }
    }
    pump?.cancel()
    pump = nil
    process = nil
    if case .failed = state {} else { state = .stopped }
  }

  /// Synchronous, actor-free child kill for `applicationWillTerminate`, which
  /// gets no `await`. Safe to call when nothing is running — including
  /// speculatively, e.g. mid crash-loop backoff: a relaunch that has not been
  /// decided yet is a fresh decision and still goes ahead, so this can never
  /// permanently wedge the crash loop's own recovery.
  ///
  /// What it must *not* be is silent. The pid guard below is the whole body of
  /// the old bug: inside a `restart()`'s stop→start window there is no live
  /// child to kill, so this returned having recorded nothing at all, and the
  /// restart — one step from spawning — put a server on the machine that
  /// outlived the app. Both flags are therefore set before the guard, not
  /// after it.
  public nonisolated func terminateNow(gracePeriod: TimeInterval = 2) {
    terminationEpoch.withLock { $0 += 1 }
    stopFlag.withLock { $0 = true }  // deliberate: the exit is not a crash
    guard let pid = livePID.withLock({ $0 }) else { return }
    deliver(SIGTERM, to: pid)
    let deadline = Date().addingTimeInterval(gracePeriod)
    while Date() < deadline {
      if kill(pid, 0) != 0 {
        livePID.withLock { if $0 == pid { $0 = nil } }
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
    livePID.withLock { if $0 == pid { $0 = nil } }
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

  /// A child that logs far faster than the actor can drain it (a runaway loop,
  /// say) must not grow the pump's buffer without limit. 4096 chunks is
  /// generous for a log pump; past that, the oldest unread chunks are dropped
  /// so memory stays bounded instead of the operator's log.
  private static let chunkBufferCapacity = 4096

  /// Returns the new child's generation, so its caller can carry that identity
  /// through every suspension point that follows.
  private func spawn(_ launch: LocalServerLaunch) throws -> Int {
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
    // Bumped before `run()` so the termination handler can tag its exit code
    // with the generation it belongs to. A spawn that throws still burns a
    // generation, which is harmless: it only invalidates reports about a child
    // that was never started.
    spawnGeneration += 1
    let generation = spawnGeneration
    child.terminationHandler = { [weak self] proc in
      self?.lastExitCode.withLock {
        $0 = ChildExit(generation: generation, code: proc.terminationStatus)
      }
    }
    try child.run()

    process = child
    let pid = child.processIdentifier
    livePID.withLock { $0 = pid }
    // Not `.running(pid:)`: that is a promise the server answers requests, and
    // nothing has asked it yet. `waitForHealth()` promotes it once `/api/health`
    // says yes.
    state = .starting
    Self.logger.info("local server started, pid \(pid, privacy: .public)")

    let handle = pipe.fileHandleForReading
    pump = Task { [weak self] in
      await ProcessOutputPump.pump(
        handle, bufferingPolicy: .bufferingNewest(Self.chunkBufferCapacity)
      ) { line in
        await self?.ingest(line)
      }
      await self?.childStreamEnded(generation: generation)
    }
    return generation
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
    guard generation == spawnGeneration, !stopping else { return }
    let code = await exitCode(generation: generation)
    // Again, on the way back: `exitCode()` waits on the termination handler,
    // and a `restart()` landing in that window has already spawned the next
    // child. Acting on this stale report would clear that child's pid and
    // process — orphaning it — and then start a third one.
    guard generation == spawnGeneration, !stopping else { return }
    livePID.withLock { $0 = nil }
    process = nil
    Self.logger.error("local server exited with \(code, privacy: .public)")
    await handleCrash(exitCode: code, generation: generation)
  }

  /// The child has already closed its pipe by the time this is called, so
  /// `terminationHandler` firing is imminent, not a wait on a live process —
  /// see `lastExitCode`'s doc comment for why this never reads
  /// `terminationStatus` directly.
  private func exitCode(generation: Int) async -> Int32 {
    for _ in 0..<25 {
      if let exit = lastExitCode.withLock({ $0 }), exit.generation == generation {
        return exit.code
      }
      // Nothing left to wait for once this supervisor has moved past the child
      // being asked about.
      guard generation == spawnGeneration, !stopping else { return -1 }
      try? await Task.sleep(for: .milliseconds(20))
    }
    return -1
  }

  /// Polls health for up to 30 s. Readiness is the health answer, not the ready
  /// line: the line is a nicety the server may stop printing, `/api/health` is
  /// the contract.
  private func waitForHealth(generation: Int) async {
    for _ in 0..<60 {
      if Task.isCancelled || stopping { return }
      if await health() {
        // The health answer is about the child that was live when it was
        // asked; a stop or the next spawn can land in that await.
        guard generation == spawnGeneration, !stopping else { return }
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
    guard !Task.isCancelled, scheduled == spawnGeneration else { return }
    await startChild(epoch: epoch)
  }
}
#endif
