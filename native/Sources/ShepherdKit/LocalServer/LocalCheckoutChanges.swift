#if os(macOS)
import Foundation
import Synchronization

/// Tracked changes in the private deployment copy, never the live checkout.
public struct LocalCheckoutChanges: Sendable {
  public struct Change: Sendable, Equatable {
    public let status: String
    public let path: String
    public init(status: String, path: String) { self.status = status; self.path = path }
  }

  private let environment: LocalServerEnvironment
  public init(environment: LocalServerEnvironment) { self.environment = environment }

  public func trackedChanges() async throws -> [Change] {
    try Self.parse(await git(["status", "--porcelain=v1", "-z", "--untracked-files=no"]))
  }

  /// A retry always reads again, including when the checkout became clean since
  /// confirmation. Rename sources and destinations both belong to the path set.
  public func prepare(discardingLocalChanges confirmedPaths: [String]? = nil) async throws {
    let changes = try await trackedChanges()
    if let confirmedPaths {
      guard Set(changes.map(\.path)) == Set(confirmedPaths) else {
        throw LocalServerFailure.dirtyCheckout(changes: changes)
      }
    } else if !changes.isEmpty {
      throw LocalServerFailure.dirtyCheckout(changes: changes)
    }
    guard !changes.isEmpty else { return }
    let pathspec = environment.appDirectory.deletingLastPathComponent()
      .appendingPathComponent(".shepherd-discard-\(UUID().uuidString)")
    defer { try? FileManager.default.removeItem(at: pathspec) }
    let data = Data(changes.map { $0.path + "\0" }.joined().utf8)
    try data.write(to: pathspec, options: .atomic)
    try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: pathspec.path)
    _ = try await git(["--literal-pathspecs", "restore", "--source=HEAD", "--staged", "--worktree",
      "--pathspec-from-file=\(pathspec.path)", "--pathspec-file-nul"])
    let remaining = try await trackedChanges()
    guard remaining.isEmpty else { throw LocalServerFailure.dirtyCheckout(changes: remaining) }
  }

  static func parse(_ data: Data) throws -> [Change] {
    guard data.isEmpty || data.last == 0 else { throw LocalServerFailure.updateFailed(exitCode: 1) }
    let records = data.split(separator: 0, omittingEmptySubsequences: false).dropLast()
    var iterator = records.makeIterator()
    var changes: [Change] = []
    while let record = iterator.next() {
      guard record.count > 3, record[record.startIndex + 2] == UInt8(ascii: " "),
            let status = String(data: record.prefix(2), encoding: .utf8),
            status.allSatisfy({ " MADRCUT".contains($0) }), status != "  ",
            let path = String(data: record.dropFirst(3), encoding: .utf8) else {
        throw LocalServerFailure.updateFailed(exitCode: 1)
      }
      changes.append(Change(status: status, path: path))
      if status.contains("R") || status.contains("C") {
        guard let source = iterator.next(), !source.isEmpty,
              let path = String(data: source, encoding: .utf8) else {
          throw LocalServerFailure.updateFailed(exitCode: 1)
        }
        changes.append(Change(status: status, path: path))
      }
    }
    return changes
  }

  /// The updater's PATH, HOME and working directory, with argv rather than a
  /// shell. Drain raw bytes: line-oriented output would corrupt NUL pathspecs.
  private func git(_ arguments: [String]) async throws -> Data {
    try Task.checkCancellation()
    let process = Process()
    let pipe = Pipe()
    process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
    process.arguments = ["git"] + arguments
    process.currentDirectoryURL = environment.appDirectory
    var childEnvironment = environment.childEnvironment()
    childEnvironment["SHEPHERD_NO_SERVICE"] = "1"
    process.environment = childEnvironment
    process.standardOutput = pipe
    process.standardError = FileHandle.nullDevice
    // A Sendable class, not captured local mutexes: Swift 6.3 rejects sending
    // a closure over those into the output Task (same shape as LocalUpdateRun).
    let shared = SharedState()
    let reader = pipe.fileHandleForReading
    process.terminationHandler = { child in shared.exitCode.withLock { $0 = child.terminationStatus } }
    return try await withTaskCancellationHandler {
      try process.run()
      let pid = process.processIdentifier
      shared.livePID.withLock { $0 = pid }
      let output = Task {
        var data = Data()
        for await chunk in ProcessOutputPump.chunks(from: reader) { data.append(chunk) }
        shared.outputDone.withLock { $0 = true }
        return data
      }
      let deadline = Date().addingTimeInterval(30)
      var timedOut = false
      while shared.exitCode.withLock({ $0 }) == nil || !shared.outputDone.withLock({ $0 }) {
        if Task.isCancelled || Date() >= deadline {
          timedOut = Date() >= deadline
          killpg(pid, SIGKILL)
          output.cancel()
        }
        do { try await Task.sleep(for: .milliseconds(20)) } catch { usleep(20_000) }
      }
      let data = await output.value
      shared.livePID.withLock { $0 = nil }
      try Task.checkCancellation()
      if timedOut { throw LocalServerFailure.updateFailed(exitCode: 124) }
      guard shared.exitCode.withLock({ $0 }) == 0 else { throw LocalServerFailure.updateFailed(exitCode: 1) }
      return data
    } onCancel: {
      // The loop also catches cancellation before publishing the owned group.
      if let pid = shared.livePID.withLock({ $0 }) { killpg(pid, SIGKILL) }
    }
  }

  private final class SharedState: Sendable {
    let livePID = Mutex<Int32?>(nil)
    let exitCode = Mutex<Int32?>(nil)
    let outputDone = Mutex(false)
  }
}
#endif
