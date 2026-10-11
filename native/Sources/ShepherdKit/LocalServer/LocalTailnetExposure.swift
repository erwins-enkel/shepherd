#if os(macOS)
import Foundation

/// Why the tailnet switch cannot be used. One catalog key per case in the app layer.
public enum TailnetUnavailableReason: Equatable, Sendable {
  /// No `tailscale` on the search path and no Tailscale.app bundle.
  case cliMissing
  /// The CLI is there, but tailscaled is not logged in and running, or did not answer.
  case notConnected
  /// No MagicDNS name with an HTTPS certificate: `serve --https` would stop at an
  /// admin-console enablement prompt instead of serving.
  case httpsDisabled
}

public enum TailnetAvailability: Equatable, Sendable {
  case unavailable(TailnetUnavailableReason)
  /// This Mac's MagicDNS name, lowercased and without the trailing dot.
  case available(host: String)
}

/// What `tailscale serve` currently does for the local server's port.
public struct TailnetExposureStatus: Equatable, Sendable {
  public let availability: TailnetAvailability
  /// The app's mapping — `https://<host>:<port>/` → `http://127.0.0.1:<port>` — is configured.
  public let exposed: Bool
  /// The HTTPS port is already served by a mapping this app did not make.
  public let portTaken: Bool
  /// Other serve fronts (`host:port` keys) proxying to this loopback port. Made outside
  /// the app: reported, never removed.
  public let otherFronts: [String]
  public let port: Int

  public init(availability: TailnetAvailability, exposed: Bool = false, portTaken: Bool = false,
              otherFronts: [String] = [], port: Int) {
    self.availability = availability
    self.exposed = exposed
    self.portTaken = portTaken
    self.otherFronts = otherFronts
    self.port = port
  }

  /// The address another Shepherd uses to reach this one. Known only while Tailscale is up.
  public var url: URL? {
    guard case .available(let host) = availability else { return nil }
    return URL(string: "https://\(host):\(port)")
  }
}

public enum TailnetExposureFailure: Error, Equatable, Sendable {
  case unavailable(TailnetUnavailableReason)
  case portTaken
  /// The CLI failed; 124 is our timeout, 127 a launch failure.
  case commandFailed(exitCode: Int32)
  /// The CLI exited 0 but the serve config does not show the change — `serve` prints
  /// an enablement URL and quits when the tailnet lacks a feature it needs.
  case notApplied
}

public struct TailscaleCommandResult: Equatable, Sendable {
  public let exitCode: Int32
  public let stdout: Data
  public let stderr: String

  public init(exitCode: Int32, stdout: Data = Data(), stderr: String = "") {
    self.exitCode = exitCode
    self.stdout = stdout
    self.stderr = stderr
  }
}

/// Opt-in tailnet reach for the supervised server: `tailscale serve` terminates HTTPS
/// on this Mac's MagicDNS name and proxies to the loopback listener, which stays the
/// only socket the server binds (`SHEPHERD_HOST=127.0.0.1`). `--bg` mappings persist in
/// tailscaled across reboots and app quits, so the serve config itself is the state:
/// the app stores nothing and never touches a mapping it did not make.
public struct LocalTailnetExposure: Sendable {
  public typealias Runner =
    @Sendable (_ executable: URL, _ arguments: [String], _ timeout: Duration) async -> TailscaleCommandResult

  public let port: Int
  private let locate: @Sendable () -> URL?
  private let run: Runner

  public init(environment: LocalServerEnvironment, locate: (@Sendable () -> URL?)? = nil, run: Runner? = nil) {
    self.port = environment.port
    self.locate = locate ?? { environment.locateTailscale() }
    let commandEnvironment = Self.commandEnvironment(environment.childEnvironment())
    self.run = run ?? { executable, arguments, timeout in
      await Self.runProcess(executable, arguments, environment: commandEnvironment, timeout: timeout)
    }
  }

  static let statusArguments = ["status", "--json", "--peers=false"]
  static let serveStatusArguments = ["serve", "status", "--json"]
  static func enableArguments(port: Int) -> [String] {
    ["serve", "--bg", "--yes", "--https=\(port)", "http://127.0.0.1:\(port)"]
  }
  static func disableArguments(port: Int) -> [String] { ["serve", "--yes", "--https=\(port)", "off"] }

  /// The app-bundle binary decides between GUI and CLI from shell variables a child of
  /// this app does not have; this forces the CLI for every install variant.
  static func commandEnvironment(_ base: [String: String]) -> [String: String] {
    var values = base
    values["TAILSCALE_BE_CLI"] = "1"
    return values
  }

  public func status() async -> TailnetExposureStatus {
    guard let cli = locate() else { return TailnetExposureStatus(availability: .unavailable(.cliMissing), port: port) }
    return await status(cli: cli)
  }

  /// Adds the app's mapping. The exit code alone is not trusted: success means the
  /// re-read serve config shows the mapping.
  public func enable(log: LogRing? = nil) async -> Result<TailnetExposureStatus, TailnetExposureFailure> {
    guard let cli = locate() else { return .failure(.unavailable(.cliMissing)) }
    let before = await status(cli: cli)
    if case .unavailable(let reason) = before.availability { return .failure(.unavailable(reason)) }
    if before.exposed { return .success(before) }
    guard !before.portTaken else { return .failure(.portTaken) }
    let arguments = Self.enableArguments(port: port)
    let result = await run(cli, arguments, .seconds(20))
    await Self.record(arguments, result, log: log)
    guard result.exitCode == 0 else { return .failure(.commandFailed(exitCode: result.exitCode)) }
    let after = await status(cli: cli)
    return after.exposed ? .success(after) : .failure(.notApplied)
  }

  /// Removes the app's mapping, and only that one: without it nothing runs, so a
  /// mapping the operator made on the same port is never switched off from here.
  public func disable(log: LogRing? = nil) async -> Result<TailnetExposureStatus, TailnetExposureFailure> {
    guard let cli = locate() else { return .failure(.unavailable(.cliMissing)) }
    let before = await status(cli: cli)
    if case .unavailable(let reason) = before.availability { return .failure(.unavailable(reason)) }
    guard before.exposed else { return .success(before) }
    let arguments = Self.disableArguments(port: port)
    let result = await run(cli, arguments, .seconds(20))
    await Self.record(arguments, result, log: log)
    guard result.exitCode == 0 else { return .failure(.commandFailed(exitCode: result.exitCode)) }
    let after = await status(cli: cli)
    return after.exposed ? .failure(.notApplied) : .success(after)
  }

  private func status(cli: URL) async -> TailnetExposureStatus {
    let result = await run(cli, Self.statusArguments, .seconds(5))
    let availability = result.exitCode == 0
      ? Self.availability(statusJSON: result.stdout) : .unavailable(.notConnected)
    guard case .available(let host) = availability else {
      return TailnetExposureStatus(availability: availability, port: port)
    }
    let serve = await run(cli, Self.serveStatusArguments, .seconds(5))
    // An unreadable serve config must not read as "off": the switch would then offer
    // to add a mapping that may already exist.
    guard serve.exitCode == 0 else {
      return TailnetExposureStatus(availability: .unavailable(.notConnected), port: port)
    }
    let state = Self.serveState(serveJSON: serve.stdout, host: host, port: port)
    return TailnetExposureStatus(availability: availability, exposed: state.exposed,
                                 portTaken: state.portTaken, otherFronts: state.otherFronts, port: port)
  }

  // MARK: Parsing (`tailscale status --json`, `tailscale serve status --json`)

  static func availability(statusJSON data: Data) -> TailnetAvailability {
    guard let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
          root["BackendState"] as? String == "Running" else { return .unavailable(.notConnected) }
    let node = root["Self"] as? [String: Any]
    let host = bareHost(node?["DNSName"] as? String ?? "")
    let certDomains = (root["CertDomains"] as? [Any] ?? []).compactMap { $0 as? String }.map(Self.bareHost)
    guard !host.isEmpty, certDomains.contains(host) else { return .unavailable(.httpsDisabled) }
    return .available(host: host)
  }

  static func bareHost(_ name: String) -> String {
    var host = name.trimmingCharacters(in: .whitespaces).lowercased()
    while host.hasSuffix(".") { host.removeLast() }
    return host
  }

  struct ServeState: Equatable {
    var exposed = false
    var portTaken = false
    var otherFronts: [String] = []
  }

  /// Same web maps as the server's `findServedHosts` (`src/config.ts`): the top-level
  /// `Web` plus every `Services[svc].Web`. Only a top-level `<host>:<port>` entry whose
  /// single `/` handler proxies to this loopback port is the app's own mapping.
  static func serveState(serveJSON data: Data, host: String, port: Int) -> ServeState {
    guard let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return ServeState() }
    var state = ServeState()
    let managedKey = "\(host):\(port)"
    var webMaps: [(topLevel: Bool, map: [String: Any])] = []
    if let web = root["Web"] as? [String: Any] { webMaps.append((true, web)) }
    if let services = root["Services"] as? [String: Any] {
      for name in services.keys.sorted() {
        if let web = (services[name] as? [String: Any])?["Web"] as? [String: Any] { webMaps.append((false, web)) }
      }
    }
    for (topLevel, web) in webMaps {
      for key in web.keys.sorted() {
        guard let handlers = (web[key] as? [String: Any])?["Handlers"] as? [String: Any] else { continue }
        if topLevel, key.lowercased() == managedKey, handlers.count == 1,
           let handler = handlers["/"], targetsLoopback(handler, port: port) {
          state.exposed = true
        } else if handlers.values.contains(where: { targetsLoopback($0, port: port) }) {
          state.otherFronts.append(key)
        }
      }
    }
    // Any other use of the port (a different target, extra handlers, a TCP forward).
    state.portTaken = !state.exposed && (root["TCP"] as? [String: Any])?["\(port)"] != nil
    return state
  }

  static func targetsLoopback(_ handler: Any, port: Int) -> Bool {
    guard let proxy = (handler as? [String: Any])?["Proxy"] as? String, let url = URL(string: proxy),
          ["http", "https"].contains(url.scheme?.lowercased() ?? ""),
          ["127.0.0.1", "localhost"].contains(url.host(percentEncoded: false)?.lowercased() ?? "")
    else { return false }
    return url.port == port
  }

  // MARK: Process

  /// Short-lived CLI call: no stdin, both outputs collected concurrently (a status
  /// document can outgrow the pipe buffer), killed at the deadline (exit 124).
  static func runProcess(_ executable: URL, _ arguments: [String], environment: [String: String],
                         timeout: Duration) async -> TailscaleCommandResult {
    let process = Process()
    process.executableURL = executable
    process.arguments = arguments
    process.environment = environment
    process.standardInput = FileHandle.nullDevice
    let stdout = Pipe()
    let stderr = Pipe()
    process.standardOutput = stdout
    process.standardError = stderr
    let (exits, exitSignal) = AsyncStream<Int32>.makeStream()
    process.terminationHandler = { child in
      exitSignal.yield(child.terminationStatus)
      exitSignal.finish()
    }
    do { try process.run() } catch { return TailscaleCommandResult(exitCode: 127) }
    let pid = process.processIdentifier
    let output = Task { await Self.collect(stdout.fileHandleForReading) }
    let errors = Task { await Self.collect(stderr.fileHandleForReading) }
    let deadline = Task { () -> Bool in
      do { try await Task.sleep(for: timeout) } catch { return false }
      kill(pid, SIGKILL)
      return true
    }
    var exit = exits.makeAsyncIterator()
    let code = await exit.next() ?? 127
    deadline.cancel()
    let timedOut = await deadline.value && code != 0
    let stdoutData = await output.value
    let stderrText = String(decoding: await errors.value, as: UTF8.self)
    return TailscaleCommandResult(exitCode: timedOut ? 124 : code, stdout: stdoutData, stderr: stderrText)
  }

  private static func collect(_ handle: FileHandle, limit: Int = 1 << 20) async -> Data {
    var data = Data()
    // Keep draining past the limit so the child never blocks on a full pipe.
    for await chunk in ProcessOutputPump.chunks(from: handle) where data.count < limit {
      data.append(chunk.prefix(limit - data.count))
    }
    return data
  }

  /// The CLI's own words go to the panel log: an enablement URL printed by `serve`
  /// is the operator's next step.
  private static func record(_ arguments: [String], _ result: TailscaleCommandResult, log: LogRing?) async {
    guard let log else { return }
    await log.append("$ tailscale " + arguments.joined(separator: " "))
    let text = String(decoding: result.stdout, as: UTF8.self) + "\n" + result.stderr
    let lines = text.split(whereSeparator: \.isNewline).map(String.init)
      .filter { !$0.trimmingCharacters(in: .whitespaces).isEmpty }
    for line in lines.prefix(20) { await log.append(line) }
    if result.exitCode != 0 { await log.append("tailscale exited with status \(result.exitCode)") }
  }
}
#endif
