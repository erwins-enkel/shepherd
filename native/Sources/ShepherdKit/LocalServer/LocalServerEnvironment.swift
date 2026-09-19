#if os(macOS)
import Foundation

/// Why the local server is not usable. One catalog key per case in the app layer;
/// nothing here is an operator-facing sentence.
public enum LocalServerFailure: Error, Equatable, Sendable {
  case bunMissing
  case notAShepherdCheckout(path: String)
  case installFailed(exitCode: Int32)
  case exited(code: Int32)
  case crashLoop(restarts: Int)
}

/// The two filesystem reads this type needs, as a `Sendable` seam.
///
/// `FileManager` is not `Sendable` under Swift 6 strict concurrency, so it cannot be
/// a stored property of a `Sendable` value type — and `LocalServerEnvironment` has to
/// be `Sendable`, because the supervisor actor stores one. `@unchecked Sendable` is
/// banned by this stream's constraints, so the injection point is this protocol
/// instead of `FileManager` itself. The default implementation is `FileManager.default`.
public protocol LocalServerFileManaging: Sendable {
  func contents(atPath path: String) -> Data?
  func isExecutableFile(atPath path: String) -> Bool
}

/// `FileManager.default`, behind the `Sendable` seam. Both calls are read-only and
/// safe on `FileManager.default` from any thread.
public struct LocalServerSystemFileManager: LocalServerFileManaging {
  public init() {}
  public func contents(atPath path: String) -> Data? {
    FileManager.default.contents(atPath: path)
  }
  public func isExecutableFile(atPath path: String) -> Bool {
    FileManager.default.isExecutableFile(atPath: path)
  }
}

/// Everything about *this Mac* the supervisor needs, with filesystem and PATH
/// injected so tests never touch the real `~/.shepherd`. macOS-only: `Process`
/// and `/bin/bash` do not exist on iOS and the kit compiles for `.iOS(.v18)` (D1).
public struct LocalServerEnvironment: Sendable {
  /// The installer's `SHEPHERD_DIR` default (`deploy/install.sh`).
  public let appDirectory: URL
  /// Sourced by `install.sh` with `set -a` and by the systemd units'
  /// `EnvironmentFile=-%h/.shepherd/env`.
  public let envFilePath: URL

  private let home: URL
  private let pathEntries: [String]
  private let fileManager: any LocalServerFileManaging

  public init(
    home: URL = URL(fileURLWithPath: NSHomeDirectory()),
    fileManager: any LocalServerFileManaging = LocalServerSystemFileManager(),
    pathEntries: [String]? = nil
  ) {
    self.home = home
    self.fileManager = fileManager
    self.pathEntries =
      pathEntries
      ?? (ProcessInfo.processInfo.environment["PATH"] ?? "").split(separator: ":").map(String.init)
    self.appDirectory = home.appendingPathComponent(".shepherd/app", isDirectory: true)
    self.envFilePath = home.appendingPathComponent(".shepherd/env", isDirectory: false)
  }

  /// Always appended: a Finder-launched app inherits launchd's PATH, which
  /// carries none of these.
  private var bunFallbacks: [String] {
    [home.appendingPathComponent(".bun/bin").path, "/opt/homebrew/bin", "/usr/local/bin"]
  }

  /// Cheaper and less brittle than shelling out to git, and it is what the app
  /// needs: `bun run src/index.ts` wants that manifest, not a `.git`.
  public func isShepherdCheckout() -> Bool {
    let manifest = appDirectory.appendingPathComponent("package.json")
    guard let data = fileManager.contents(atPath: manifest.path),
      let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
      let name = object["name"] as? String
    else { return false }
    return name == "shepherd"
  }

  public func locateBun() -> URL? {
    for directory in pathEntries + bunFallbacks {
      let candidate = URL(fileURLWithPath: directory).appendingPathComponent("bun")
      if fileManager.isExecutableFile(atPath: candidate.path) { return candidate }
    }
    return nil
  }

  /// `KEY=value` lines the way `set -a; . env` reads them: `export ` stripped,
  /// one layer of matching quotes removed, blanks/comments/`=`-less lines skipped.
  /// Deliberately not a shell — no `$VAR` expansion, no command substitution: the
  /// file is data here, never code.
  public func envFileValues() -> [String: String] {
    guard let text = try? String(contentsOf: envFilePath, encoding: .utf8) else { return [:] }
    var values: [String: String] = [:]
    for rawLine in text.split(separator: "\n", omittingEmptySubsequences: false) {
      var line = rawLine.trimmingCharacters(in: .whitespaces)
      if line.isEmpty || line.hasPrefix("#") { continue }
      if line.hasPrefix("export ") { line = String(line.dropFirst("export ".count)) }
      guard let separator = line.firstIndex(of: "=") else { continue }
      let key = line[line.startIndex..<separator].trimmingCharacters(in: .whitespaces)
      guard !key.isEmpty else { continue }
      var value = line[line.index(after: separator)...].trimmingCharacters(in: .whitespaces)
      if value.count >= 2, let first = value.first, let last = value.last,
        first == last, first == "\"" || first == "'"
      {
        value = String(value.dropFirst().dropLast())
      }
      values[key] = value
    }
    return values
  }

  /// This process's environment, then `~/.shepherd/env` (operator overrides win
  /// over ours), then the two we insist on: `HOME` so the child finds the same
  /// state dir, and `SHEPHERD_HOST` pinned to loopback so supervising a server
  /// can never expose it on a LAN.
  public func spawnEnvironment(bun: URL) -> [String: String] {
    var environment = ProcessInfo.processInfo.environment
    for (key, value) in envFileValues() { environment[key] = value }
    environment["HOME"] = home.path
    environment["SHEPHERD_HOST"] = "127.0.0.1"
    environment["PATH"] = ([bun.deletingLastPathComponent().path] + pathEntries + bunFallbacks)
      .joined(separator: ":")
    return environment
  }
}
#endif
