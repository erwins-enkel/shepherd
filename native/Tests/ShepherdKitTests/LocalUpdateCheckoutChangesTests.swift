#if os(macOS)
import Foundation
import Testing
@testable import ShepherdKit

@Suite(.serialized) struct LocalUpdateCheckoutChangesTests {
  private func git(_ arguments: [String], in environment: LocalServerEnvironment) throws {
    let process = Process()
    process.executableURL = URL(fileURLWithPath: "/usr/bin/git")
    process.arguments = arguments
    process.currentDirectoryURL = environment.appDirectory
    process.environment = environment.childEnvironment()
    process.standardOutput = FileHandle.nullDevice
    process.standardError = FileHandle.nullDevice
    try process.run()
    process.waitUntilExit() // Finite fixture setup, not a production runner.
    #expect(process.terminationStatus == 0)
  }

  private func checkout() throws -> LocalServerEnvironment {
    let environment = LocalServerEnvironment(home: try makeTempHome(),
      pathEntries: ["/usr/bin", "/bin"], processEnvironment: [:])
    try FileManager.default.createDirectory(at: environment.appDirectory, withIntermediateDirectories: true)
    try git(["init", "-q", "-b", "main"], in: environment)
    try git(["config", "user.name", "Test"], in: environment)
    try git(["config", "user.email", "test@example.invalid"], in: environment)
    for path in ["bun.lock", "modified", "renamed", "*.txt", ":(glob)*.txt", "-dash", "space name", "line\nbreak", "Grüße"] {
      try "original".write(to: environment.appDirectory.appendingPathComponent(path), atomically: true, encoding: .utf8)
    }
    try git(["add", "--all"], in: environment)
    try git(["-c", "commit.gpgsign=false", "commit", "-qm", "fixture"], in: environment)
    return environment
  }

  @Test func ignoresUntrackedFilesAndDetectsTrackedDeletionAndIndexChanges() async throws {
    let environment = try checkout()
    defer { try? FileManager.default.removeItem(at: environment.homeDirectory) }
    let helper = LocalCheckoutChanges(environment: environment)
    try "untracked".write(to: environment.appDirectory.appendingPathComponent("notes"), atomically: true, encoding: .utf8)
    #expect(try await helper.trackedChanges().isEmpty)
    try await helper.prepare()
    try FileManager.default.removeItem(at: environment.appDirectory.appendingPathComponent("bun.lock"))
    try "edited".write(to: environment.appDirectory.appendingPathComponent("modified"), atomically: true, encoding: .utf8)
    try git(["add", "modified"], in: environment)
    let changes = try await helper.trackedChanges()
    #expect(changes == [.init(status: " D", path: "bun.lock"), .init(status: "M ", path: "modified")])
    do {
      try await helper.prepare()
      Issue.record("Dirty checkout was accepted without confirmation")
    } catch {
      #expect(error as? LocalServerFailure == .dirtyCheckout(changes: changes))
    }
    #expect(!FileManager.default.fileExists(atPath: environment.appDirectory.appendingPathComponent("bun.lock").path))
  }

  @Test func restoresOnlyConfirmedLiteralPathsIncludingRenamesAndStagedAdditions() async throws {
    let environment = try checkout()
    defer { try? FileManager.default.removeItem(at: environment.homeDirectory) }
    let helper = LocalCheckoutChanges(environment: environment)
    let paths = ["bun.lock", "modified", "*.txt", ":(glob)*.txt", "-dash", "space name", "line\nbreak", "Grüße"]
    for path in paths {
      try "edited".write(to: environment.appDirectory.appendingPathComponent(path), atomically: true, encoding: .utf8)
    }
    try FileManager.default.removeItem(at: environment.appDirectory.appendingPathComponent("bun.lock"))
    try git(["mv", "renamed", "new name"], in: environment)
    try "addition".write(to: environment.appDirectory.appendingPathComponent("added"), atomically: true, encoding: .utf8)
    try git(["add", "added"], in: environment)
    try "keep me".write(to: environment.appDirectory.appendingPathComponent("untracked.txt"), atomically: true, encoding: .utf8)
    let changes = try await helper.trackedChanges()
    #expect(Set(changes.map(\.path)) == Set(paths + ["renamed", "new name", "added"]))
    #expect(changes.contains(.init(status: "R ", path: "renamed")))
    #expect(changes.contains(.init(status: "R ", path: "new name")))
    // Confirmation is a set, independent of ordering.
    try await helper.prepare(discardingLocalChanges: changes.map(\.path).reversed())
    #expect(try await helper.trackedChanges().isEmpty)
    for path in paths + ["renamed"] {
      #expect(try String(contentsOf: environment.appDirectory.appendingPathComponent(path), encoding: .utf8) == "original")
    }
    #expect(!FileManager.default.fileExists(atPath: environment.appDirectory.appendingPathComponent("added").path))
    #expect(!FileManager.default.fileExists(atPath: environment.appDirectory.appendingPathComponent("new name").path))
    #expect(try String(contentsOf: environment.appDirectory.appendingPathComponent("untracked.txt"), encoding: .utf8) == "keep me")
  }

  @Test func pathSetMismatchDoesNotRestoreAnything() async throws {
    let environment = try checkout()
    defer { try? FileManager.default.removeItem(at: environment.homeDirectory) }
    let helper = LocalCheckoutChanges(environment: environment)
    try FileManager.default.removeItem(at: environment.appDirectory.appendingPathComponent("bun.lock"))
    let confirmed = try await helper.trackedChanges().map(\.path)
    try "new edit".write(to: environment.appDirectory.appendingPathComponent("modified"), atomically: true, encoding: .utf8)
    let current = try await helper.trackedChanges()
    do {
      try await helper.prepare(discardingLocalChanges: confirmed)
      Issue.record("Stale confirmation was accepted")
    } catch {
      #expect(error as? LocalServerFailure == .dirtyCheckout(changes: current))
    }
    #expect(try await helper.trackedChanges() == current)
    #expect(!FileManager.default.fileExists(atPath: environment.appDirectory.appendingPathComponent("bun.lock").path))
  }

  @Test func parserPreservesNulDelimitedPathsAndRejectsIncompleteOrInvalidUtf8() throws {
    #expect(try LocalCheckoutChanges.parse(Data(" D quoted\" name\n\0R  target\0source\0".utf8)) == [
      .init(status: " D", path: "quoted\" name\n"), .init(status: "R ", path: "target"), .init(status: "R ", path: "source")])
    for data in [Data(" D missing-nul".utf8), Data("R  target\0".utf8), Data([32, 68, 32, 255, 0]), Data("?? untracked\0".utf8)] {
      #expect(throws: LocalServerFailure.self) { try LocalCheckoutChanges.parse(data) }
    }
  }

  @Test func aSmallerOrEmptyPathSetAlsoRequiresAnotherAttempt() async throws {
    let environment = try checkout()
    defer { try? FileManager.default.removeItem(at: environment.homeDirectory) }
    let helper = LocalCheckoutChanges(environment: environment)
    for path in ["bun.lock", "modified"] {
      try "edited".write(to: environment.appDirectory.appendingPathComponent(path), atomically: true, encoding: .utf8)
    }
    let confirmed = try await helper.trackedChanges().map(\.path)
    for path in ["modified", "bun.lock"] {
      try "original".write(to: environment.appDirectory.appendingPathComponent(path), atomically: true, encoding: .utf8)
      let current = try await helper.trackedChanges()
      do {
        try await helper.prepare(discardingLocalChanges: confirmed)
        Issue.record("Changed confirmation set was accepted")
      } catch {
        #expect(error as? LocalServerFailure == .dirtyCheckout(changes: current))
      }
      #expect(try await helper.trackedChanges() == current)
    }
  }
}
#endif
