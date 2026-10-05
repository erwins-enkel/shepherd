#if os(macOS)
import Foundation
import Synchronization

/// A bounded preview of the fetched main branch, independent of HTTP authentication.
public struct LocalUpdateStatus: Sendable, Equatable {
  public struct Commit: Sendable, Equatable {
    public let sha: String
    public let subject: String
    public init(sha: String, subject: String) { self.sha = sha; self.subject = subject }
  }
  public let behind: Int
  public let current: String
  public let latest: String
  public let commits: [Commit]
  public let checkedAt: Date

  public init(behind: Int, current: String, latest: String, commits: [Commit] = [], checkedAt: Date = Date()) {
    self.behind = behind
    self.current = current
    self.latest = latest
    self.commits = commits
    self.checkedAt = checkedAt
  }
}

public enum LocalUpdateCheckFailure: Error, Sendable, Equatable {
  case commandFailed(exitCode: Int32)
  case invalidOutput
}

/// Fetches only main. The checkout and executable search paths match the local server.
public struct LocalUpdateCheck: Sendable {
  private let environment: LocalServerEnvironment
  private let timeout: TimeInterval
  private let scriptOverride: URL?
  var testSeamAfterRun: (@Sendable () -> Void)?

  public init(environment: LocalServerEnvironment, timeout: TimeInterval = 60, scriptOverride: URL? = nil) {
    self.environment = environment
    self.timeout = timeout
    self.scriptOverride = scriptOverride
  }

  public func run() async -> Result<LocalUpdateStatus, LocalUpdateCheckFailure> {
    guard !Task.isCancelled else { return .failure(.commandFailed(exitCode: 130)) }
    let process = Process()
    let pipe = Pipe()
    process.executableURL = URL(fileURLWithPath: "/bin/bash")
    process.arguments = scriptOverride.map { [$0.path] } ?? ["-c", """
      set -e
      git fetch --quiet origin main
      git rev-list --count HEAD..origin/main
      git rev-parse --short HEAD
      git rev-parse --short origin/main
      git --no-pager log -10 --format=%h%x09%s HEAD..origin/main
      """]
    process.currentDirectoryURL = environment.appDirectory
    var childEnvironment = environment.childEnvironment()
    // A background check must never park on an interactive credential prompt.
    childEnvironment["GIT_TERMINAL_PROMPT"] = "0"
    process.environment = childEnvironment
    process.standardOutput = pipe
    process.standardError = FileHandle.nullDevice
    let shared = SharedState()
    process.terminationHandler = { child in shared.exitCode.withLock { $0 = child.terminationStatus } }
    let lines = LogRing(capacity: 13)
    let timeout = self.timeout
    // Same polled exit as BunUpgradeRun; no AsyncStream wait or timer task
    // nested in the cancellation handler (Swift 6.3).
    let started = await withTaskCancellationHandler {
      do { try process.run() } catch { return false }
      let pid = process.processIdentifier
      // On macOS Foundation launches Process in its own group. Store its ID
      // before the test seam (and before reaping); descendants can outlive pid.
      shared.livePID.withLock { $0 = pid }
      testSeamAfterRun?()
      if Task.isCancelled { Self.terminateGroup(pid) }
      let output = Task {
        await ProcessOutputPump.pump(pipe.fileHandleForReading) { line in await lines.append(line) }
        shared.outputDone.withLock { $0 = true }
      }
      let deadline = Date().addingTimeInterval(timeout)
      // Exit and EOF are independent. Keep the deadline and cancellation live
      // until BOTH have completed, even when the shell was already reaped.
      while shared.exitCode.withLock({ $0 }) == nil || !shared.outputDone.withLock({ $0 }) {
        if Date() >= deadline, !shared.timedOut.withLock({ $0 }) {
          shared.timedOut.withLock { $0 = true }
          Self.terminateGroup(pid)
          output.cancel()
        }
        if Task.isCancelled {
          Self.terminateGroup(pid)
          output.cancel()
        }
        do { try await Task.sleep(for: .milliseconds(50)) } catch { usleep(20_000) }
      }
      await output.value
      shared.livePID.withLock { $0 = nil }
      return true
    } onCancel: {
      guard let pid = shared.livePID.withLock({ $0 }) else { return }
      Self.terminateGroup(pid)
    }
    guard started else { return .failure(.commandFailed(exitCode: 127)) }
    if Task.isCancelled { return .failure(.commandFailed(exitCode: 130)) }
    if shared.timedOut.withLock({ $0 }) { return .failure(.commandFailed(exitCode: 124)) }
    let code = shared.exitCode.withLock { $0 } ?? 127
    guard code == 0 else { return .failure(.commandFailed(exitCode: code)) }
    guard let status = Self.parse(await lines.lines, checkedAt: Date()) else { return .failure(.invalidOutput) }
    return .success(status)
  }

  static func parse(_ lines: [String], checkedAt: Date) -> LocalUpdateStatus? {
    func isSHA(_ value: String) -> Bool {
      (4...64).contains(value.count) && value.allSatisfy { $0.isASCII && $0.isHexDigit }
    }
    guard lines.count >= 3, let behind = Int(lines[0]), behind >= 0,
          isSHA(lines[1]), isSHA(lines[2]) else { return nil }
    var commits: [LocalUpdateStatus.Commit] = []
    for line in lines.dropFirst(3).prefix(10) {
      let fields = line.split(separator: "\t", maxSplits: 1, omittingEmptySubsequences: false)
      guard fields.count == 2, isSHA(String(fields[0])) else { return nil }
      commits.append(.init(sha: String(fields[0]), subject: String(fields[1].prefix(300))))
    }
    guard commits.count <= behind else { return nil }
    return .init(behind: behind, current: lines[1], latest: lines[2], commits: commits, checkedAt: checkedAt)
  }

  private static func terminateGroup(_ pid: Int32) {
    guard pid > 0, pid != getpgrp() else { return }
    // Never look up the reaped leader. The owned group can still have writers.
    killpg(pid, SIGKILL)
  }

  private final class SharedState: Sendable {
    let livePID = Mutex<Int32?>(nil)
    let exitCode = Mutex<Int32?>(nil)
    let timedOut = Mutex(false)
    let outputDone = Mutex(false)
  }
}
#endif
