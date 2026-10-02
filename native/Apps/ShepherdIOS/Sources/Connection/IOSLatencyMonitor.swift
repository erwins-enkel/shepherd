import Foundation
import Observation
import ShepherdKit

@MainActor
@Observable
final class IOSLatencyMonitor {
    private(set) var report = LatencyReport(samples: [])
    private(set) var probing = false
    @ObservationIgnored private let readSamples: () -> [LatencySample]
    @ObservationIgnored private let readTerminal: () -> TerminalOpenTiming?
    @ObservationIgnored private let probe: () async -> Void
    @ObservationIgnored private let now: () -> Date

    init(readSamples: @escaping () -> [LatencySample],
         readTerminal: @escaping () -> TerminalOpenTiming?,
         probe: @escaping () async -> Void, now: @escaping () -> Date = Date.init) {
        self.readSamples = readSamples
        self.readTerminal = readTerminal
        self.probe = probe
        self.now = now
    }

    func refresh() {
        report = LatencyReport(samples: readSamples(), terminal: readTerminal(), now: now())
    }

    func measure() async {
        guard !probing else { return }
        probing = true
        await probe()
        refresh()
        probing = false
    }

    func run() async {
        await measure()
        while !Task.isCancelled {
            try? await Task.sleep(for: .seconds(3))
            refresh()
        }
    }

    static func make(client: ShepherdClient, terminal: IOSTerminalPresentation,
                     sessionID: String) -> IOSLatencyMonitor {
        IOSLatencyMonitor(readSamples: { client.latency.snapshot() },
            readTerminal: { terminal.session.openTiming }, probe: {
                for _ in 0..<3 { _ = try? await client.session(id: sessionID) }
            })
    }
}
