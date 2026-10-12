#if os(macOS)
import Foundation
import Darwin
import Synchronization

/// Uses herdr's established liveness command before and after `herdr server`.
/// Socket existence never proves liveness. This operation never removes a socket
/// or sends a stop/restart command to a daemon that may own live agents.
public actor LocalRunnerStart {
  private let environment: LocalServerEnvironment
  private let log: LogRing
  private let timeout: TimeInterval
  private let pollInterval: TimeInterval
  private let probe: @Sendable (URL, [String: String]) async -> Bool
  private let start: (@Sendable (URL, [String: String]) async throws -> Void)?
  private var operation: Task<Result<Void, LocalServerFailure>, Never>?
  private var daemon: Process?

  public init(
    environment: LocalServerEnvironment, log: LogRing,
    timeout: TimeInterval = 10, pollInterval: TimeInterval = 0.25,
    probe: @escaping @Sendable (URL, [String: String]) async -> Bool = { binary, values in
      await LocalRunnerStart.probeCommand(binary: binary, environment: values)
    },
    start: (@Sendable (URL, [String: String]) async throws -> Void)? = nil
  ) {
    self.environment = environment
    self.log = log
    self.timeout = timeout
    self.pollInterval = pollInterval
    self.probe = probe
    self.start = start
  }

  /// Coalesce overlapping callers so they cannot race two starts on the socket.
  public func run() async -> Result<Void, LocalServerFailure> {
    if let operation { return await operation.value }
    let task = Task { await perform() }
    operation = task
    let result = await withTaskCancellationHandler { await task.value } onCancel: { task.cancel() }
    operation = nil
    return result
  }

  private func perform() async -> Result<Void, LocalServerFailure> {
    guard let binary = environment.locateRunner() else {
      await log.append("Runner executable is missing. Install Shepherd to provision herdr.")
      return .failure(.runnerMissing)
    }
    let values = environment.childEnvironment()
    if await probe(binary, values) { return .success(()) }
    guard !Task.isCancelled else { return .failure(.runnerTimeout) }
    await log.append("Starting the configured herdr runner…")
    do {
      if let start { try await start(binary, values) }
      else if daemon?.isRunning != true { try launch(binary: binary, values: values) }
    } catch {
      await log.append("Could not start the runner: \(error.localizedDescription)")
      return .failure(.runnerTimeout)
    }
    let deadline = Date().addingTimeInterval(timeout)
    repeat {
      guard !Task.isCancelled else { return .failure(.runnerTimeout) }
      if await probe(binary, values) {
        await log.append("The herdr runner is answering.")
        return .success(())
      }
      do { try await Task.sleep(for: .seconds(pollInterval)) }
      catch { return .failure(.runnerTimeout) }
    } while Date() < deadline
    await log.append("The runner did not answer. Check its configured socket and the startup log; existing daemons were left untouched.")
    return .failure(.runnerTimeout)
  }

  private func launch(binary: URL, values: [String: String]) throws {
    let directory = environment.homeDirectory.appendingPathComponent(".shepherd/run")
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true,
      attributes: [.posixPermissions: 0o700])
    let logURL = directory.appendingPathComponent("herdr-runner.log")
    // Copy-truncate preserves other writers' descriptors if a concurrent
    // caller also found the daemon offline. Append output survives app quit.
    LocalServerLogTail.maintain(logURL)
    let fd = open(logURL.path, O_WRONLY | O_APPEND | O_CREAT | O_NOFOLLOW, 0o600)
    guard fd >= 0 else { throw CocoaError(.fileWriteUnknown) }
    let output = FileHandle(fileDescriptor: fd, closeOnDealloc: true)
    defer { try? output.close() }
    guard fchmod(fd, 0o600) == 0 else { throw CocoaError(.fileWriteUnknown) }
    let process = Process()
    // Match the server launch: Foundation creates a separate process group
    // on Darwin; ignore orphaned-group HUP across exec and inherit no terminal.
    process.executableURL = URL(fileURLWithPath: "/bin/sh")
    process.arguments = ["-c", "trap '' HUP; exec \"$@\"", "shepherd-runner", binary.path, "server"]
    process.environment = values
    process.currentDirectoryURL = environment.homeDirectory
    process.standardInput = FileHandle.nullDevice
    process.standardOutput = output
    process.standardError = output
    try process.run()
    daemon = process
  }

  /// Bound the CLI probe itself as well as the polling window. Only this
  /// short-lived `agent list` child is signalled on timeout/cancellation.
  public static func probeCommand(binary: URL, environment: [String: String]) async -> Bool {
    let process = Process()
    let exit = Mutex<Int32?>(nil)
    let pid = Mutex<Int32?>(nil)
    process.executableURL = binary
    process.arguments = ["agent", "list"]
    process.environment = environment
    process.standardInput = FileHandle.nullDevice
    process.standardOutput = FileHandle.nullDevice
    process.standardError = FileHandle.nullDevice
    process.terminationHandler = { child in exit.withLock { $0 = child.terminationStatus } }
    return await withTaskCancellationHandler {
      guard !Task.isCancelled else { return false }
      do { try process.run() } catch { return false }
      pid.withLock { $0 = process.processIdentifier }
      let deadline = Date().addingTimeInterval(1.5)
      while Date() < deadline && !Task.isCancelled {
        if let code = exit.withLock({ $0 }) { pid.withLock { $0 = nil }; return code == 0 }
        try? await Task.sleep(for: .milliseconds(20))
      }
      if let ownedPID = pid.withLock({ $0 }) { killProbe(ownedPID) }
      return false
    } onCancel: {
      if let ownedPID = pid.withLock({ $0 }) { killProbe(ownedPID) }
    }
  }

  private nonisolated static func killProbe(_ pid: Int32) {
    if getpgid(pid) == pid && getpgid(pid) != getpgid(0) { killpg(pid, SIGKILL) }
    else { kill(pid, SIGKILL) }
  }
}
#endif
