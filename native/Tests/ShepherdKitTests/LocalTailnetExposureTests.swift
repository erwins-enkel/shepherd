#if os(macOS)
import Foundation
import Synchronization
import Testing

@testable import ShepherdKit

private let runningStatus = #"""
  {"BackendState":"Running","Self":{"DNSName":"Mac.Tailnet.ts.net."},"CertDomains":["mac.tailnet.ts.net"]}
  """#
private let managedServe = #"""
  {"TCP":{"7330":{"HTTPS":true}},
   "Web":{"mac.tailnet.ts.net:7330":{"Handlers":{"/":{"Proxy":"http://127.0.0.1:7330"}}}}}
  """#

/// A scripted `tailscale`: status answers fixed JSON, serve status reflects whether a
/// mutation "applied", and every call is recorded.
private final class FakeTailscale: Sendable {
  let calls = Mutex<[[String]]>([])
  let mapped: Mutex<Bool>
  let status: String
  let serve: String?
  let mutationExit: Int32
  let mutationApplies: Bool

  init(status: String = runningStatus, mapped: Bool = false, serve: String? = nil,
       mutationExit: Int32 = 0, mutationApplies: Bool = true) {
    self.status = status
    self.mapped = Mutex(mapped)
    self.serve = serve
    self.mutationExit = mutationExit
    self.mutationApplies = mutationApplies
  }

  var runner: LocalTailnetExposure.Runner { { _, arguments, _ in self.handle(arguments) } }
  var recorded: [[String]] { calls.withLock { $0 } }
  var mutations: [[String]] {
    recorded.filter { $0 != LocalTailnetExposure.statusArguments && $0 != LocalTailnetExposure.serveStatusArguments }
  }

  private func handle(_ arguments: [String]) -> TailscaleCommandResult {
    calls.withLock { $0.append(arguments) }
    if arguments == LocalTailnetExposure.statusArguments {
      return TailscaleCommandResult(exitCode: 0, stdout: Data(status.utf8))
    }
    if arguments == LocalTailnetExposure.serveStatusArguments {
      let json = serve ?? (mapped.withLock { $0 } ? managedServe : "{}")
      return TailscaleCommandResult(exitCode: 0, stdout: Data(json.utf8))
    }
    if mutationExit == 0, mutationApplies { mapped.withLock { $0 = arguments.last != "off" } }
    return TailscaleCommandResult(exitCode: mutationExit, stdout: Data("Available within your tailnet\n".utf8),
                                  stderr: "fake stderr")
  }
}

private struct FakeFiles: LocalServerFileManaging {
  let executables: Set<String>
  func contents(atPath path: String) -> Data? { nil }
  func isExecutableFile(atPath path: String) -> Bool { executables.contains(path) }
}

private func environment(_ values: [String: String] = [:]) -> LocalServerEnvironment {
  LocalServerEnvironment(
    home: URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("tailnet-\(UUID().uuidString)"),
    processEnvironment: values)
}

private func exposure(_ fake: FakeTailscale, cli: URL? = URL(fileURLWithPath: "/usr/local/bin/tailscale"),
                      environment env: LocalServerEnvironment = environment()) -> LocalTailnetExposure {
  LocalTailnetExposure(environment: env, locate: { cli }, run: fake.runner)
}

@Suite(.timeLimit(.minutes(1))) struct LocalTailnetExposureTests {
  @Test func aRunningNodeWithACertificateIsAvailableUnderItsBareName() {
    #expect(LocalTailnetExposure.availability(statusJSON: Data(runningStatus.utf8)) == .available(host: "mac.tailnet.ts.net"))
  }

  @Test func aNodeThatIsNotRunningIsNotConnected() {
    for json in [#"{"BackendState":"Stopped"}"#, #"{"BackendState":"NeedsLogin"}"#, "not json", ""] {
      #expect(LocalTailnetExposure.availability(statusJSON: Data(json.utf8)) == .unavailable(.notConnected))
    }
  }

  @Test func withoutAnHTTPSCertificateTheNameCannotBeServed() {
    for json in [
      #"{"BackendState":"Running","Self":{"DNSName":"mac.tailnet.ts.net."}}"#,
      #"{"BackendState":"Running","Self":{"DNSName":"mac.tailnet.ts.net."},"CertDomains":[]}"#,
      #"{"BackendState":"Running","Self":{"DNSName":""},"CertDomains":["other.tailnet.ts.net"]}"#,
      #"{"BackendState":"Running","Self":{"DNSName":"mac.tailnet.ts.net."},"CertDomains":["other.tailnet.ts.net"]}"#,
    ] {
      #expect(LocalTailnetExposure.availability(statusJSON: Data(json.utf8)) == .unavailable(.httpsDisabled))
    }
  }

  @Test func onlyTheAppsOwnMappingCountsAsExposed() {
    let host = "mac.tailnet.ts.net"
    let own = LocalTailnetExposure.serveState(serveJSON: Data(managedServe.utf8), host: host, port: 7330)
    #expect(own == .init(exposed: true, portTaken: false, otherFronts: []))
    let viaLocalhost = #"""
      {"TCP":{"7330":{"HTTPS":true}},"Web":{"MAC.tailnet.ts.net:7330":{"Handlers":{"/":{"Proxy":"http://localhost:7330/"}}}}}
      """#
    #expect(LocalTailnetExposure.serveState(serveJSON: Data(viaLocalhost.utf8), host: host, port: 7330).exposed)
    for json in ["{}", "", "[]", "not json"] {
      #expect(LocalTailnetExposure.serveState(serveJSON: Data(json.utf8), host: host, port: 7330) == .init())
    }
  }

  @Test func mappingsMadeElsewhereAreReportedNotClaimed() {
    let json = #"""
      {"TCP":{"443":{"HTTPS":true}},
       "Web":{"mac.tailnet.ts.net:443":{"Handlers":{"/":{"Proxy":"http://localhost:7330"}}},
              "mac.tailnet.ts.net:8443":{"Handlers":{"/":{"Proxy":"http://127.0.0.1:73301"}}}},
       "Services":{"svc:shepherd":{"Web":{"shepherd.tailnet.ts.net:443":{"Handlers":{"/":{"Proxy":"http://127.0.0.1:7330"}}}}}}}
      """#
    let state = LocalTailnetExposure.serveState(serveJSON: Data(json.utf8), host: "mac.tailnet.ts.net", port: 7330)
    #expect(state == .init(exposed: false, portTaken: false,
                           otherFronts: ["mac.tailnet.ts.net:443", "shepherd.tailnet.ts.net:443"]))
  }

  @Test func anotherUseOfTheHTTPSPortIsAConflict() {
    let elsewhere = #"""
      {"TCP":{"7330":{"HTTPS":true}},"Web":{"mac.tailnet.ts.net:7330":{"Handlers":{"/":{"Proxy":"http://127.0.0.1:9000"}}}}}
      """#
    let extraHandler = #"""
      {"TCP":{"7330":{"HTTPS":true}},"Web":{"mac.tailnet.ts.net:7330":{"Handlers":{
        "/":{"Proxy":"http://127.0.0.1:7330"},"/docs":{"Path":"/tmp/docs"}}}}}
      """#
    let tcpForward = #"{"TCP":{"7330":{"TCPForward":"127.0.0.1:22"}}}"#
    for json in [elsewhere, extraHandler, tcpForward] {
      let state = LocalTailnetExposure.serveState(serveJSON: Data(json.utf8), host: "mac.tailnet.ts.net", port: 7330)
      #expect(!state.exposed)
      #expect(state.portTaken)
    }
  }

  @Test func enablingServesTheLoopbackPortAndConfirmsIt() async {
    let fake = FakeTailscale()
    let log = LogRing()
    let result = await exposure(fake).enable(log: log)
    #expect(result == .success(TailnetExposureStatus(availability: .available(host: "mac.tailnet.ts.net"),
                                                     exposed: true, port: 7330)))
    #expect(fake.mutations == [["serve", "--bg", "--yes", "--https=7330", "http://127.0.0.1:7330"]])
    #expect(fake.recorded.last == LocalTailnetExposure.serveStatusArguments)
    let lines = await log.lines
    #expect(lines.first == "$ tailscale serve --bg --yes --https=7330 http://127.0.0.1:7330")
    #expect(lines.contains("Available within your tailnet"))
    #expect(lines.contains("fake stderr"))
    let url = (try? result.get())?.url
    #expect(url?.absoluteString == "https://mac.tailnet.ts.net:7330")
  }

  @Test func aSuccessfulExitWithoutTheMappingIsNotApplied() async {
    let fake = FakeTailscale(mutationApplies: false)
    #expect(await exposure(fake).enable() == .failure(.notApplied))
  }

  @Test func aFailingCommandReportsItsExitCode() async {
    let fake = FakeTailscale(mutationExit: 1)
    #expect(await exposure(fake).enable() == .failure(.commandFailed(exitCode: 1)))
  }

  @Test func aTakenPortIsNeverOverwritten() async {
    let taken = #"""
      {"TCP":{"7330":{"HTTPS":true}},"Web":{"mac.tailnet.ts.net:7330":{"Handlers":{"/":{"Proxy":"http://127.0.0.1:9000"}}}}}
      """#
    let fake = FakeTailscale(serve: taken)
    #expect(await exposure(fake).enable() == .failure(.portTaken))
    #expect(fake.mutations.isEmpty)
  }

  @Test func anUnavailableTailnetIsExplainedWithoutMutating() async {
    let https = FakeTailscale(status: #"{"BackendState":"Running","Self":{"DNSName":"mac.tailnet.ts.net."}}"#)
    #expect(await exposure(https).enable() == .failure(.unavailable(.httpsDisabled)))
    #expect(https.recorded == [LocalTailnetExposure.statusArguments])
    let stopped = FakeTailscale(status: #"{"BackendState":"Stopped"}"#)
    #expect(await exposure(stopped).disable() == .failure(.unavailable(.notConnected)))
    #expect(stopped.mutations.isEmpty)
  }

  @Test func withoutTheCLINothingRuns() async {
    let fake = FakeTailscale()
    let missing = exposure(fake, cli: nil)
    #expect(await missing.status() == TailnetExposureStatus(availability: .unavailable(.cliMissing), port: 7330))
    #expect(await missing.enable() == .failure(.unavailable(.cliMissing)))
    #expect(await missing.disable() == .failure(.unavailable(.cliMissing)))
    #expect(fake.recorded.isEmpty)
  }

  @Test func disablingRemovesOnlyTheAppsMapping() async {
    let idle = FakeTailscale()
    #expect(await exposure(idle).disable() == .success(TailnetExposureStatus(
      availability: .available(host: "mac.tailnet.ts.net"), port: 7330)))
    #expect(idle.mutations.isEmpty)

    let served = FakeTailscale(mapped: true)
    let result = await exposure(served).disable()
    #expect((try? result.get())?.exposed == false)
    #expect(served.mutations == [["serve", "--yes", "--https=7330", "off"]])
  }

  @Test func theMappingFollowsTheConfiguredPort() async {
    let fake = FakeTailscale(status: runningStatus)
    let custom = exposure(fake, environment: environment(["SHEPHERD_PORT": "8123"]))
    #expect(custom.port == 8123)
    _ = await custom.enable()
    #expect(fake.mutations.first == ["serve", "--bg", "--yes", "--https=8123", "http://127.0.0.1:8123"])
  }

  @Test func everyInvocationForcesCLIMode() {
    let values = LocalTailnetExposure.commandEnvironment(["PATH": "/usr/bin", "TAILSCALE_BE_CLI": "0"])
    #expect(values["TAILSCALE_BE_CLI"] == "1")
    #expect(values["PATH"] == "/usr/bin")
  }

  @Test func theProcessRunnerSeparatesOutputsAndForwardsTheEnvironment() async {
    let shell = URL(fileURLWithPath: "/bin/sh")
    let result = await LocalTailnetExposure.runProcess(
      shell, ["-c", #"printf '%s' "$TAILSCALE_BE_CLI"; echo oops >&2; exit 3"#],
      environment: LocalTailnetExposure.commandEnvironment([:]), timeout: .seconds(10))
    #expect(result == TailscaleCommandResult(exitCode: 3, stdout: Data("1".utf8), stderr: "oops\n"))
  }

  @Test func theProcessRunnerDrainsOutputLargerThanThePipeBuffer() async {
    let result = await LocalTailnetExposure.runProcess(
      URL(fileURLWithPath: "/bin/sh"), ["-c", "head -c 200000 /dev/zero | tr '\\0' a"],
      environment: ["PATH": "/usr/bin:/bin"], timeout: .seconds(10))
    #expect(result.exitCode == 0)
    #expect(result.stdout.count == 200_000)
  }

  @Test func theProcessRunnerKillsAHungCommand() async {
    let result = await LocalTailnetExposure.runProcess(
      URL(fileURLWithPath: "/bin/sh"), ["-c", "exec sleep 30"], environment: ["PATH": "/usr/bin:/bin"],
      timeout: .milliseconds(300))
    #expect(result.exitCode == 124)
  }

  @Test func aMissingExecutableIsALaunchFailure() async {
    let result = await LocalTailnetExposure.runProcess(
      URL(fileURLWithPath: "/nonexistent/tailscale"), [], environment: [:], timeout: .seconds(1))
    #expect(result.exitCode == 127)
  }

  @Test func theCLIOnASearchPathWinsOverTheAppBundle() {
    let bundle = LocalServerEnvironment.tailscaleAppBinary
    func locate(_ executables: Set<String>, path: [String] = ["/custom/bin"]) -> String? {
      LocalServerEnvironment(home: URL(fileURLWithPath: "/nonexistent-home"),
                             fileManager: FakeFiles(executables: executables), pathEntries: path,
                             processEnvironment: [:]).locateTailscale()?.path
    }
    #expect(locate(["/custom/bin/tailscale", bundle]) == "/custom/bin/tailscale")
    #expect(locate(["/opt/homebrew/bin/tailscale", bundle], path: []) == "/opt/homebrew/bin/tailscale")
    #expect(locate([bundle], path: []) == bundle)
    #expect(locate([], path: []) == nil)
  }
}
#endif
