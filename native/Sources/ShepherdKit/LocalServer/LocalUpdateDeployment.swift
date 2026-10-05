#if os(macOS)
import Darwin
import Foundation

/// A private sibling copy, including the previous UI and dependencies. The live
/// deployment is never built in place. macOS exchanges the two directory names
/// atomically; the old deployment remains available until readiness succeeds.
public struct LocalUpdateDeployment: Sendable {
  public let environment: LocalServerEnvironment
  private let live: URL
  private let staged: URL
  private let original: [String: Entry]
  public private(set) var promoted = false

  private struct Entry: Equatable, Sendable {
    let modified: Date?
    let size: Int?
    let link: String?
  }

  public init(environment: LocalServerEnvironment) throws {
    live = environment.appDirectory
    staged = live.deletingLastPathComponent().appendingPathComponent(".shepherd-update-\(UUID().uuidString)")
    // A worktree's .git file points back at a different checkout's metadata.
    // Installed standalone clones can be copied safely; linked worktrees cannot.
    let git = live.appendingPathComponent(".git")
    if FileManager.default.fileExists(atPath: git.path) {
      let values = try git.resourceValues(forKeys: [.isDirectoryKey, .isSymbolicLinkKey])
      guard values.isDirectory == true, values.isSymbolicLink != true else {
        throw LocalServerFailure.updateFailed(exitCode: 1)
      }
    }
    let liveValues = try live.resourceValues(forKeys: [.isDirectoryKey, .isSymbolicLinkKey])
    guard liveValues.isDirectory == true, liveValues.isSymbolicLink != true else {
      throw LocalServerFailure.updateFailed(exitCode: 1)
    }
    original = try Self.inventory(live)
    // Copying an external symlink would still let the staged installer write
    // through it into live files. Ordinary relative node_modules links stay
    // inside the copy; external or absolute links must be corrected first.
    let root = live.resolvingSymlinksInPath().path + "/"
    for (path, entry) in original {
      guard let link = entry.link else { continue }
      let target = URL(fileURLWithPath: live.path + path).resolvingSymlinksInPath().path
      guard !link.hasPrefix("/"), target.hasPrefix(root) else {
        throw LocalServerFailure.updateFailed(exitCode: 1)
      }
    }
    do {
      try FileManager.default.copyItem(at: live, to: staged)
      try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: staged.path)
      guard try Self.inventory(live) == original else { throw LocalServerFailure.updateFailed(exitCode: 1) }
    } catch {
      try? FileManager.default.removeItem(at: staged)
      throw error
    }
    self.environment = environment.withAppDirectory(staged)
  }

  public mutating func promote() throws {
    try Task.checkCancellation()
    // Refuse publication if the operator edited ANY part of the live checkout
    // while building. In particular, never discard tracked or untracked work.
    guard try Self.inventory(live) == original else { throw LocalServerFailure.updateFailed(exitCode: 1) }
    try exchange()
    promoted = true
  }

  public mutating func rollback() throws {
    guard promoted else { return }
    try exchange()
    promoted = false
  }

  /// Call only after rollback or successful readiness. A failed rollback must
  /// keep this directory: it is the last working deployment.
  public func finish() { try? FileManager.default.removeItem(at: staged) }

  private func exchange() throws {
    guard renameatx_np(AT_FDCWD, live.path, AT_FDCWD, staged.path, UInt32(RENAME_SWAP)) == 0 else {
      throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO)
    }
  }

  private static func inventory(_ directory: URL) throws -> [String: Entry] {
    let keys: Set<URLResourceKey> = [.contentModificationDateKey, .fileSizeKey, .isSymbolicLinkKey]
    var failure: (any Error)?
    guard let entries = FileManager.default.enumerator(at: directory, includingPropertiesForKeys: Array(keys),
      errorHandler: { _, error in failure = error; return false }) else {
      throw LocalServerFailure.updateFailed(exitCode: 1)
    }
    var result: [String: Entry] = [:]
    for case let file as URL in entries {
      let values = try file.resourceValues(forKeys: keys)
      result[String(file.path.dropFirst(directory.path.count))] = Entry(
        modified: values.contentModificationDate, size: values.fileSize,
        link: values.isSymbolicLink == true ? try FileManager.default.destinationOfSymbolicLink(atPath: file.path) : nil)
    }
    if let failure { throw failure }
    return result
  }
}
#endif
