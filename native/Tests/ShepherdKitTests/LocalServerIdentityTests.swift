#if os(macOS)
import Foundation
import Testing
@testable import ShepherdKit

@Suite struct LocalServerIdentityTests {
  @Test func ownedHealthRequiresThisLaunchAndBothCanonicalPaths() async throws {
    let home = try makeTempHome()
    defer { try? FileManager.default.removeItem(at: home) }
    let actual = home.appendingPathComponent("install")
    let alias = home.appendingPathComponent("alias")
    try FileManager.default.createDirectory(at: actual, withIntermediateDirectories: true)
    try FileManager.default.createSymbolicLink(at: alias, withDestinationURL: actual)
    let db = actual.appendingPathComponent("state.db")
    try Data().write(to: db)
    let expected = LocalServerIdentity(appDirectory: actual.path, databasePath: db.path, instanceID: "this-launch")
    for (version, directory, database, marker, matches) in [
      ("1", alias.path, alias.appendingPathComponent("state.db").path, "this-launch", true),
      ("1", actual.path, db.path, "other-launch", false),
      ("1", "/wrong", db.path, "this-launch", false),
      ("1", actual.path, "/wrong.db", "this-launch", false),
      ("", actual.path, db.path, "this-launch", false),
    ] {
      let body = try JSONSerialization.data(withJSONObject: ["ok": true, "version": version, "localInstall": [
        "appDirectory": directory, "databasePath": database, "instanceID": marker,
      ]])
      let check = LocalHealthCheck { request in
        (body, HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!)
      }
      #expect(await check(expectedIdentity: expected) == matches)
    }
    let old = LocalHealthCheck { request in
      (Data(#"{"ok":true,"version":"1"}"#.utf8), HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!)
    }
    #expect(await old() == true)
    #expect(await old(expectedIdentity: expected) == false)
  }
  @Test func anUnrelatedListenerNeverCertifiesTheOwnedChild() async throws {
    let (launch, cleanup) = try fakeScript("echo owned=$SHEPHERD_LOCAL_INSTANCE_ID; sleep 30")
    defer { cleanup() }
    let env = LocalServerEnvironment(home: launch.workingDirectory)
    let check = LocalHealthCheck { request in
      let body = #"{"ok":true,"version":"1","localInstall":{"appDirectory":"/other","databasePath":"/other.db","instanceID":"external"}}"#
      return (Data(body.utf8), HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!)
    }
    let supervisor = LocalServerSupervisor(environment: env, identityHealth: { expected in
      await check(expectedIdentity: expected)
    }, clock: TestClock(), launch: { launch })
    await supervisor.start()
    #expect(await supervisor.state == .failed(.healthTimeout))
    #expect(await supervisor.logLines().contains { $0.hasPrefix("owned=") && $0.count > 6 })
  }

}
#endif
