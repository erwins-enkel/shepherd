#if os(macOS)
import Foundation
import Testing

@testable import ShepherdKit

func makeTempHome() throws -> URL {
  let url = URL(fileURLWithPath: NSTemporaryDirectory())
    .appendingPathComponent("s5-\(UUID().uuidString)", isDirectory: true)
  try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
  return url
}

func makeExecutable(_ url: URL) throws {
  try Data().write(to: url)
  try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: url.path)
}

@Suite(.timeLimit(.minutes(1))) struct LocalServerEnvironmentTests {
  @Test func customInstallAndDatabaseKeepExplicitHome() throws {
    let home = try makeTempHome()
    defer { try? FileManager.default.removeItem(at: home) }
    let config = home.appendingPathComponent(".shepherd/env")
    try FileManager.default.createDirectory(at: config.deletingLastPathComponent(), withIntermediateDirectories: true)
    try "SHEPHERD_DIR=\(home.path)/custom app\nSHEPHERD_DB=state/custom.db\nSHEPHERD_REF=preview\n".write(to: config, atomically: true, encoding: .utf8)
    let env = LocalServerEnvironment(home: home)
    #expect(env.appDirectory.path == home.appendingPathComponent("custom app").path)
    let spawn = env.spawnEnvironment(bun: URL(fileURLWithPath: "/bin/bun"))
    #expect(spawn["HOME"] == home.path)
    #expect(spawn["SHEPHERD_DB"] == home.appendingPathComponent("custom app/state/custom.db").path)
    #expect(spawn["SHEPHERD_REF"] == "preview")
    try "SHEPHERD_DIR=/changed\n".write(to: config, atomically: true, encoding: .utf8)
    #expect(env.spawnEnvironment(bun: URL(fileURLWithPath: "/bin/bun"))["SHEPHERD_REF"] == "preview")
  }

  @Test func anInvalidPortCannotCrashTheNativeHealthURL() throws {
    let home = try makeTempHome()
    defer { try? FileManager.default.removeItem(at: home) }
    for port in ["-1", "65536", "not-a-port"] {
      let environment = LocalServerEnvironment(home: home, processEnvironment: ["SHEPHERD_PORT": port])
      #expect(environment.port == 7330)
      // Keep the invalid launch value: the server's existing validation reports it.
      #expect(environment.childEnvironment()["SHEPHERD_PORT"] == port)
    }
  }

  @Test func pathsFollowTheInstallerDefaults() throws {
    let home = try makeTempHome()
    defer { try? FileManager.default.removeItem(at: home) }
    let env = LocalServerEnvironment(home: home)
    #expect(env.appDirectory.path == home.appendingPathComponent(".shepherd/app").path)
    #expect(env.envFilePath.path == home.appendingPathComponent(".shepherd/env").path)
  }

  @Test func onlyAPackageNamedShepherdIsACheckout() throws {
    let home = try makeTempHome()
    defer { try? FileManager.default.removeItem(at: home) }
    let env = LocalServerEnvironment(home: home)
    try FileManager.default.createDirectory(at: env.appDirectory, withIntermediateDirectories: true)
    #expect(env.isShepherdCheckout() == false)  // no package.json
    let manifest = env.appDirectory.appendingPathComponent("package.json")
    try #"{"name":"something-else"}"#.write(to: manifest, atomically: true, encoding: .utf8)
    #expect(env.isShepherdCheckout() == false)
    try #"{"name":"shepherd","version":"1.0.0"}"#.write(to: manifest, atomically: true, encoding: .utf8)
    #expect(env.isShepherdCheckout() == true)
  }

  /// A Finder-launched app inherits launchd's PATH, which has neither ~/.bun/bin
  /// nor a Homebrew prefix — so the fallbacks must work with PATH empty.
  @Test func bunIsFoundByFallbackPathAndExecutabilityIsRequired() throws {
    let home = try makeTempHome()
    defer { try? FileManager.default.removeItem(at: home) }
    let bunBin = home.appendingPathComponent(".bun/bin", isDirectory: true)
    try FileManager.default.createDirectory(at: bunBin, withIntermediateDirectories: true)
    let bun = bunBin.appendingPathComponent("bun")
    try Data().write(to: bun)  // mode 0644
    #expect(LocalServerEnvironment(home: home, pathEntries: []).locateBun() == nil)
    try makeExecutable(bun)
    #expect(LocalServerEnvironment(home: home, pathEntries: []).locateBun()?.path == bun.path)
  }

  @Test func pathEntriesWinOverTheFallbacks() throws {
    let home = try makeTempHome()
    defer { try? FileManager.default.removeItem(at: home) }
    let custom = home.appendingPathComponent("custom", isDirectory: true)
    try FileManager.default.createDirectory(at: custom, withIntermediateDirectories: true)
    let bun = custom.appendingPathComponent("bun")
    try makeExecutable(bun)
    #expect(LocalServerEnvironment(home: home, pathEntries: [custom.path]).locateBun()?.path == bun.path)
  }

  @Test func envFileParsesExportsQuotesAndComments() throws {
    let home = try makeTempHome()
    defer { try? FileManager.default.removeItem(at: home) }
    let env = LocalServerEnvironment(home: home)
    try FileManager.default.createDirectory(
      at: env.envFilePath.deletingLastPathComponent(), withIntermediateDirectories: true)
    try """
      # a comment
      SHEPHERD_PORT=7331
      export SHEPHERD_DB="/tmp/my db.sqlite"
      SHEPHERD_TOKEN='abc def'

      NOT_A_PAIR
      """.write(to: env.envFilePath, atomically: true, encoding: .utf8)

    let values = env.envFileValues()
    #expect(values["SHEPHERD_PORT"] == "7331")
    #expect(values["SHEPHERD_DB"] == "/tmp/my db.sqlite")
    #expect(values["SHEPHERD_TOKEN"] == "abc def")
    #expect(values["NOT_A_PAIR"] == nil)
    #expect(values.keys.contains { $0.hasPrefix("#") } == false)
  }

  @Test func aMissingEnvFileIsEmptyNotAnError() throws {
    let home = try makeTempHome()
    defer { try? FileManager.default.removeItem(at: home) }
    #expect(LocalServerEnvironment(home: home).envFileValues().isEmpty)
  }

  @Test func spawnEnvironmentPinsLoopbackAndPrependsBunToPath() throws {
    let home = try makeTempHome()
    defer { try? FileManager.default.removeItem(at: home) }
    let env = LocalServerEnvironment(home: home, pathEntries: ["/usr/bin"])
    try FileManager.default.createDirectory(
      at: env.envFilePath.deletingLastPathComponent(), withIntermediateDirectories: true)
    try "SHEPHERD_PORT=7331\n".write(to: env.envFilePath, atomically: true, encoding: .utf8)

    let resolved = LocalServerEnvironment(home: home, pathEntries: ["/usr/bin"])
    let spawn = resolved.spawnEnvironment(bun: URL(fileURLWithPath: "/opt/bun/bin/bun"))
    #expect(spawn["SHEPHERD_HOST"] == "127.0.0.1")
    #expect(spawn["SHEPHERD_PORT"] == "7331")  // operator override survives
    #expect(spawn["HOME"] == home.path)
    #expect(spawn["PATH"]?.hasPrefix("/opt/bun/bin:") == true)
  }
}
#endif
