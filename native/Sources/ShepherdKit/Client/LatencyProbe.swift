import Foundation
import HTTPTypes
import OpenAPIRuntime
import Synchronization

/// `Server-Timing` as the Shepherd server sends it (`src/server-timing.ts`):
/// `app;dur=<handler ms>, lag;dur=<worst event-loop stall in the last minute>`.
/// Unknown metrics and malformed entries are ignored; an older server sends no
/// header at all, which every consumer here treats as "server time unknown".
public struct ServerTiming: Equatable, Sendable {
  public var appMs: Double?
  public var lagMs: Double?

  public init(appMs: Double? = nil, lagMs: Double? = nil) {
    self.appMs = appMs
    self.lagMs = lagMs
  }

  public static func parse(_ header: String?) -> ServerTiming? {
    guard let header, !header.isEmpty else { return nil }
    var timing = ServerTiming()
    for entry in header.split(separator: ",") {
      let parts = entry.split(separator: ";").map { $0.trimmingCharacters(in: .whitespaces) }
      guard let name = parts.first else { continue }
      let duration = parts.dropFirst().lazy
        .compactMap { param -> Double? in
          let pair = param.split(separator: "=", maxSplits: 1)
          guard pair.count == 2, pair[0].trimmingCharacters(in: .whitespaces) == "dur" else { return nil }
          return Double(pair[1].trimmingCharacters(in: .whitespaces))
        }.first
      guard let duration, duration.isFinite, duration >= 0 else { continue }
      switch name {
      case "app": timing.appMs = duration
      case "lag": timing.lagMs = duration
      default: continue
      }
    }
    return timing.appMs == nil && timing.lagMs == nil ? nil : timing
  }
}

/// One HTTP round trip as the client saw it: time to response headers, plus
/// whatever the server said about its own share.
public struct LatencySample: Equatable, Sendable {
  public var operationID: String
  public var at: Date
  public var totalMs: Double
  public var server: ServerTiming?

  public init(operationID: String, at: Date, totalMs: Double, server: ServerTiming?) {
    self.operationID = operationID
    self.at = at
    self.totalMs = totalMs
    self.server = server
  }

  /// Total minus handler time: the wire plus any queueing in front of the handler.
  public var networkMs: Double? { server?.appMs.map { max(0, totalMs - $0) } }
}

/// The last `capacity` samples of one client. Thread-safe; written by the
/// middleware on whatever executor the transport resumes on.
public final class LatencyRecorder: Sendable {
  private let samples = Mutex<[LatencySample]>([])
  private let capacity: Int

  public init(capacity: Int = 40) {
    precondition(capacity > 0)
    self.capacity = capacity
  }

  public func record(_ sample: LatencySample) {
    samples.withLock { list in
      list.append(sample)
      if list.count > capacity { list.removeFirst(list.count - capacity) }
    }
  }

  public func snapshot() -> [LatencySample] { samples.withLock { $0 } }
}

/// Times each attempt (innermost, so a retried GET yields one sample per try)
/// and never changes the request or the response.
struct LatencyMiddleware: ClientMiddleware, Sendable {
  let recorder: LatencyRecorder
  var clock: @Sendable () -> ContinuousClock.Instant = { ContinuousClock.now }
  var now: @Sendable () -> Date = { Date() }

  func intercept(
    _ request: HTTPRequest,
    body: HTTPBody?,
    baseURL: URL,
    operationID: String,
    next: @Sendable (HTTPRequest, HTTPBody?, URL) async throws -> (HTTPResponse, HTTPBody?)
  ) async throws -> (HTTPResponse, HTTPBody?) {
    let start = clock()
    let (response, responseBody) = try await next(request, body, baseURL)
    let elapsed = clock() - start
    let ms = Double(elapsed.components.seconds) * 1000
      + Double(elapsed.components.attoseconds) / 1e15
    if let name = HTTPField.Name("Server-Timing") {
      recorder.record(LatencySample(operationID: operationID, at: now(), totalMs: ms,
        server: ServerTiming.parse(response.headerFields[name])))
    }
    return (response, responseBody)
  }
}

/// How long opening a live terminal took, phase by phase. Filled by the
/// terminal model; all values in milliseconds since the attach started.
public struct TerminalOpenTiming: Equatable, Sendable {
  /// Socket upgrade answered and confirmed by a pong.
  public var connectedMs: Double?
  /// The first byte of the scrollback replay arrived.
  public var firstOutputMs: Double?
  /// Bytes received in the replay window (first seconds after the first byte).
  public var replayBytes: Int
  /// Main-thread time spent feeding those bytes into the emulator.
  public var renderMs: Double

  public init(connectedMs: Double? = nil, firstOutputMs: Double? = nil, replayBytes: Int = 0, renderMs: Double = 0) {
    self.connectedMs = connectedMs
    self.firstOutputMs = firstOutputMs
    self.replayBytes = replayBytes
    self.renderMs = renderMs
  }
}

/// The verdict the indicator shows: which of network, server or the app itself
/// is the slow part, from the recent samples and the last terminal open.
public struct LatencyReport: Equatable, Sendable {
  public enum Verdict: Equatable, Sendable {
    /// No recent sample yet.
    case measuring
    case ok
    /// Round trip outside the server's handler is slow.
    case networkSlow
    /// Handlers themselves are slow.
    case serverSlow
    /// The server's event loop froze recently: every request waits, however small.
    case serverStalled
    /// Opening the terminal stream is slow while plain requests are fine.
    case terminalSlow
    /// The app spent long rendering the replay on this device.
    case appSlow
    /// Slow, but the server sends no timing to tell why (older server).
    case slowUnknown
  }

  public enum Threshold {
    public static let networkMs = 300.0
    public static let serverMs = 800.0
    public static let lagMs = 1000.0
    public static let terminalMs = 2500.0
    public static let renderMs = 500.0
    public static let unknownTotalMs = 800.0
  }

  public var verdict: Verdict
  public var sampleCount: Int
  public var totalMedianMs: Double?
  public var totalP90Ms: Double?
  public var totalMaxMs: Double?
  public var networkMedianMs: Double?
  public var serverMedianMs: Double?
  public var serverP90Ms: Double?
  public var lagMaxMs: Double?
  /// Whether the server sent `Server-Timing` on the recent samples.
  public var serverReportsTiming: Bool
  public var terminal: TerminalOpenTiming?

  /// Samples older than `window` are ignored.
  public init(samples: [LatencySample], terminal: TerminalOpenTiming? = nil,
              now: Date = Date(), window: TimeInterval = 300) {
    let recent = samples.filter { now.timeIntervalSince($0.at) <= window }
    sampleCount = recent.count
    self.terminal = terminal
    let totals = recent.map(\.totalMs)
    totalMedianMs = Self.percentile(totals, 0.5)
    totalP90Ms = Self.percentile(totals, 0.9)
    totalMaxMs = totals.max()
    networkMedianMs = Self.percentile(recent.compactMap(\.networkMs), 0.5)
    let apps = recent.compactMap { $0.server?.appMs }
    serverMedianMs = Self.percentile(apps, 0.5)
    serverP90Ms = Self.percentile(apps, 0.9)
    // Only the freshest lag counts: each value already covers the server's last minute.
    lagMaxMs = recent.last(where: { $0.server?.lagMs != nil })?.server?.lagMs
    serverReportsTiming = !apps.isEmpty
    verdict = Self.verdict(sampleCount: recent.count, totalMedian: totalMedianMs, network: networkMedianMs,
      server: serverMedianMs, lag: lagMaxMs, timed: !apps.isEmpty, terminal: terminal)
  }

  private static func verdict(sampleCount: Int, totalMedian: Double?, network: Double?, server: Double?,
                              lag: Double?, timed: Bool, terminal: TerminalOpenTiming?) -> Verdict {
    guard sampleCount > 0 else { return .measuring }
    if let lag, lag >= Threshold.lagMs { return .serverStalled }
    if let server, server >= Threshold.serverMs { return .serverSlow }
    if let network, network >= Threshold.networkMs { return .networkSlow }
    if !timed, let totalMedian, totalMedian >= Threshold.unknownTotalMs { return .slowUnknown }
    if let terminal {
      if terminal.renderMs >= Threshold.renderMs { return .appSlow }
      let wire = network ?? totalMedian ?? 0
      if let first = terminal.firstOutputMs ?? terminal.connectedMs, first - wire >= Threshold.terminalMs {
        return .terminalSlow
      }
    }
    return .ok
  }

  /// Nearest-rank percentile; nil for no values.
  static func percentile(_ values: [Double], _ p: Double) -> Double? {
    guard !values.isEmpty else { return nil }
    let sorted = values.sorted()
    let rank = Int((p * Double(sorted.count)).rounded(.up)) - 1
    return sorted[min(max(rank, 0), sorted.count - 1)]
  }
}
