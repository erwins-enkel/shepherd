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
  private var journal: Journal
  private let journalURL: URL
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
    journalURL = Self.journalURL(environment)
    guard !journalURL.resolvingSymlinksInPath().path.hasPrefix(live.resolvingSymlinksInPath().path + "/"),
          !FileManager.default.fileExists(atPath: journalURL.path) else {
      throw LocalServerFailure.updateFailed(exitCode: 1)
    }
    journal = Journal(live: live.path, staged: staged.path, phase: .copying,
      originalIdentity: try Self.directoryIdentity(live), stagedIdentity: nil)
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
    self.environment = environment.withAppDirectory(staged)
    try Self.write(journal, to: journalURL)
    do {
      try FileManager.default.copyItem(at: live, to: staged)
      try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: staged.path)
      guard try Self.inventory(live) == original else { throw LocalServerFailure.updateFailed(exitCode: 1) }
      journal.stagedIdentity = try Self.directoryIdentity(staged)
      journal.phase = .building
      try Self.write(journal, to: journalURL)
    } catch {
      finish()
      throw error
    }
  }

  public mutating func promote() throws {
    try Task.checkCancellation()
    // Refuse publication if the operator edited ANY part of the live checkout
    // while building. In particular, never discard tracked or untracked work.
    guard try Self.inventory(live) == original else { throw LocalServerFailure.updateFailed(exitCode: 1) }
    // Persist intent BEFORE the rename. Identities distinguish a crash before
    // the swap from one after it, and make recovery itself safe to retry.
    journal.phase = .promoted
    try Self.write(journal, to: journalURL)
    try exchange()
    promoted = true
  }

  public mutating func rollback() throws {
    guard promoted else { return }
    try exchange()
    promoted = false
    journal.phase = .building
    try Self.write(journal, to: journalURL)
  }

  /// Persist readiness before the previous deployment can be discarded.
  public mutating func confirm() throws {
    journal.phase = .confirmed
    try Self.write(journal, to: journalURL)
    promoted = false
  }

  /// A failed rollback must retain the last working deployment and journal.
  public func finish() {
    guard !promoted else { return }
    do {
      if FileManager.default.fileExists(atPath: staged.path) {
        try FileManager.default.removeItem(at: staged)
      }
      if FileManager.default.fileExists(atPath: journalURL.path) {
        try FileManager.default.removeItem(at: journalURL)
      }
    } catch { /* Keep the journal so launch recovery can retry cleanup. */ }
  }

  enum Phase: String, Codable { case copying, building, promoted, confirmed }
  struct Journal: Codable {
    let live: String
    let staged: String
    var phase: Phase
    let originalIdentity: String
    var stagedIdentity: String?
  }

  static func journalURL(_ environment: LocalServerEnvironment) -> URL {
    environment.homeDirectory.appendingPathComponent(".shepherd/run/backend-update.json")
  }

  private static func write(_ journal: Journal, to url: URL) throws {
    try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
    try JSONEncoder().encode(journal).write(to: url, options: .atomic)
  }

  private static func directoryIdentity(_ url: URL) throws -> String {
    let values = try url.resourceValues(forKeys: [.isDirectoryKey, .isSymbolicLinkKey])
    guard values.isDirectory == true, values.isSymbolicLink != true else {
      throw LocalServerFailure.updateFailed(exitCode: 1)
    }
    let attributes = try FileManager.default.attributesOfItem(atPath: url.path)
    guard let device = attributes[.systemNumber] as? NSNumber,
          let inode = attributes[.systemFileNumber] as? NSNumber else {
      throw LocalServerFailure.updateFailed(exitCode: 1)
    }
    return "\(device):\(inode)"
  }

  /// Run synchronously before constructing/starting the supervisor. Never scan
  /// or delete arbitrary siblings: this journal owns exactly one staging path.
  /// Invalid or ambiguous recovery fails closed and preserves the backup.
  @discardableResult
  public static func recover(environment: LocalServerEnvironment) throws -> String? {
    let url = journalURL(environment)
    guard FileManager.default.fileExists(atPath: url.path) else { return nil }
    let journal = try JSONDecoder().decode(Journal.self, from: Data(contentsOf: url))
    let live = environment.appDirectory.standardizedFileURL
    let staged = URL(fileURLWithPath: journal.staged).standardizedFileURL
    guard journal.live == live.path,
          staged.deletingLastPathComponent() == live.deletingLastPathComponent(),
          staged.lastPathComponent.hasPrefix(".shepherd-update-"),
          staged.lastPathComponent != ".shepherd-update-",
          staged != live else { throw LocalServerFailure.updateFailed(exitCode: 1) }
    var restored = false
    let exists = FileManager.default.fileExists(atPath: staged.path)
    if exists {
      let stagedID = try directoryIdentity(staged)
      if journal.phase == .promoted {
        let liveID = try directoryIdentity(live)
        if liveID == journal.stagedIdentity && stagedID == journal.originalIdentity {
          guard renameatx_np(AT_FDCWD, live.path, AT_FDCWD, staged.path, UInt32(RENAME_SWAP)) == 0 else {
            throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO)
          }
          restored = true
        } else {
          guard liveID == journal.originalIdentity, stagedID == journal.stagedIdentity else {
            throw LocalServerFailure.updateFailed(exitCode: 1)
          }
        }
      } else if let identity = journal.stagedIdentity {
        let expected = journal.phase == .confirmed ? journal.originalIdentity : identity
        guard stagedID == expected else { throw LocalServerFailure.updateFailed(exitCode: 1) }
      }
      try FileManager.default.removeItem(at: staged)
    } else if journal.phase == .promoted {
      guard try directoryIdentity(live) == journal.originalIdentity else {
        throw LocalServerFailure.updateFailed(exitCode: 1)
      }
    }
    try FileManager.default.removeItem(at: url)
    return restored ? "Restored the previous backend deployment after an interrupted update."
      : "Removed staging files from an interrupted backend update."
  }

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
