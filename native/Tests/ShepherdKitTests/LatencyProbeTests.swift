import Foundation
import Testing

@testable import ShepherdKit

@Suite("Latency probe", .timeLimit(.minutes(1)))
struct LatencyProbeTests {
  private let now = Date(timeIntervalSince1970: 1_000_000)

  private func sample(_ total: Double, app: Double? = nil, lag: Double? = nil, age: TimeInterval = 1) -> LatencySample {
    let timing = app == nil && lag == nil ? nil : ServerTiming(appMs: app, lagMs: lag)
    return LatencySample(operationID: "getSession", at: now.addingTimeInterval(-age), totalMs: total, server: timing)
  }

  @Test("Server-Timing parses app and lag and ignores the rest")
  func parsesServerTiming() {
    #expect(ServerTiming.parse("app;dur=12.5, lag;dur=4200") == ServerTiming(appMs: 12.5, lagMs: 4200))
    #expect(ServerTiming.parse("app;dur=3") == ServerTiming(appMs: 3, lagMs: nil))
    #expect(ServerTiming.parse("db;dur=9, app;desc=\"x\";dur=1.0") == ServerTiming(appMs: 1, lagMs: nil))
    #expect(ServerTiming.parse("app;dur=nope, lag;dur=-1") == nil)
    #expect(ServerTiming.parse("") == nil)
    #expect(ServerTiming.parse(nil) == nil)
  }

  @Test("the recorder keeps only the newest samples")
  func recorderCapacity() {
    let recorder = LatencyRecorder(capacity: 3)
    for index in 0..<5 { recorder.record(sample(Double(index))) }
    #expect(recorder.snapshot().map(\.totalMs) == [2, 3, 4])
  }

  @Test("verdicts separate network, server, stall, terminal and app")
  func verdicts() {
    func verdict(_ samples: [LatencySample], terminal: TerminalOpenTiming? = nil) -> LatencyReport.Verdict {
      LatencyReport(samples: samples, terminal: terminal, now: now).verdict
    }
    #expect(verdict([]) == .measuring)
    #expect(verdict([sample(40, app: 5, lag: 10)]) == .ok)
    #expect(verdict([sample(520, app: 10, lag: 0), sample(480, app: 8, lag: 0)]) == .networkSlow)
    #expect(verdict([sample(1900, app: 1850, lag: 0)]) == .serverSlow)
    #expect(verdict([sample(60, app: 4, lag: 5200)]) == .serverStalled)
    #expect(verdict([sample(1200), sample(1300)]) == .slowUnknown)
    #expect(verdict([sample(40)]) == .ok)
    #expect(verdict([sample(40, app: 5)], terminal: .init(connectedMs: 300, firstOutputMs: 3500)) == .terminalSlow)
    #expect(verdict([sample(40, app: 5)], terminal: .init(firstOutputMs: 300, replayBytes: 900_000, renderMs: 750))
      == .appSlow)
  }

  @Test("stale samples are ignored and statistics use nearest rank")
  func statistics() {
    let report = LatencyReport(samples: [
      sample(9000, app: 8000, age: 3600),
      sample(100, app: 10, lag: 300), sample(200, app: 20, lag: 900), sample(300, app: 30, lag: 50),
    ], now: now)
    #expect(report.sampleCount == 3)
    #expect(report.totalMedianMs == 200)
    #expect(report.totalP90Ms == 300)
    #expect(report.networkMedianMs == 180)
    #expect(report.serverMedianMs == 20)
    // The freshest lag wins: each value already spans the server's last minute.
    #expect(report.lagMaxMs == 50)
    #expect(report.serverReportsTiming)
  }

  @Test("the client records one sample per request with the server's timing")
  func clientRecordsSamples() async throws {
    let server = FakeShepherdServer()
    defer { server.tearDown() }
    let body = try Fixtures.json(Fixtures.health())
    server.on("GET", "/api/health") { _ in
      FakeResponse(headers: ["Content-Type": "application/json", "Server-Timing": "app;dur=2.5, lag;dur=7"], body: body)
    }
    let profile = ServerProfile(name: "fake", baseURL: server.baseURL, mode: .local, credentialKey: "k")
    let client = try ShepherdClient(profile: profile, credentials: InMemoryCredentialStore(),
      urlSession: server.urlSession())

    _ = try await client.health()
    let samples = client.latency.snapshot()
    #expect(samples.count == 1)
    #expect(samples.first?.operationID == "getHealth")
    #expect(samples.first?.server == ServerTiming(appMs: 2.5, lagMs: 7))
    #expect((samples.first?.totalMs ?? -1) >= 0)
  }
}
