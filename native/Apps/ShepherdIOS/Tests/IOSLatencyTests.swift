import XCTest
import ShepherdKit
@testable import ShepherdAppCore
@testable import ShepherdIOS

@MainActor
final class IOSLatencyTests: XCTestCase {
    func testEveryVerdictHasLocalizedEnglishCopy() throws {
        let path = try XCTUnwrap(CoreResources.bundle.path(forResource: "en", ofType: "lproj"))
        let bundle = try XCTUnwrap(Bundle(path: path))
        let verdicts: [LatencyReport.Verdict] = [
            .measuring, .ok, .networkSlow, .serverSlow, .serverStalled,
            .terminalSlow, .appSlow, .slowUnknown,
        ]
        for verdict in verdicts {
            XCTAssertFalse(IOSLatencyCopy.shortLabel(verdict).isEmpty)
            XCTAssertFalse(IOSLatencyCopy.title(verdict).isEmpty)
            XCTAssertFalse(IOSLatencyCopy.explanation(verdict).isEmpty)
            let keys = IOSLatencyCopy.keys(for: verdict)
            for key in [keys.title, keys.explanation] {
                let name = "\(key)"
                let text = bundle.localizedString(forKey: name, value: nil, table: nil)
                XCTAssertFalse(text.isEmpty)
                XCTAssertNotEqual(text, name)
            }
        }
    }

    func testMillisecondsUseRoundedMsAndLocalizedSeconds() {
        let en = Locale(identifier: "en_US")
        let de = Locale(identifier: "de_DE")
        XCTAssertEqual(IOSLatencyCopy.milliseconds(nil, locale: en), "—")
        XCTAssertEqual(IOSLatencyCopy.milliseconds(0, locale: en), "0 ms")
        XCTAssertEqual(IOSLatencyCopy.milliseconds(123.6, locale: en), "124 ms")
        XCTAssertEqual(IOSLatencyCopy.milliseconds(1000, locale: en), "1.0 s")
        XCTAssertEqual(IOSLatencyCopy.milliseconds(1800, locale: en), "1.8 s")
        XCTAssertEqual(IOSLatencyCopy.milliseconds(1800, locale: de), "1,8 s")
    }

    func testMeasureProbesOnceAndRefreshesInjectedSamplesAndTerminal() async {
        let now = Date(timeIntervalSince1970: 1000)
        var calls = 0
        var samples: [LatencySample] = []
        let terminal = TerminalOpenTiming(connectedMs: 120, firstOutputMs: 140, replayBytes: 2048, renderMs: 20)
        let monitor = IOSLatencyMonitor(readSamples: { samples }, readTerminal: { terminal }, probe: {
            calls += 1
            samples = [LatencySample(operationID: "session", at: now, totalMs: 100,
                server: ServerTiming(appMs: 10, lagMs: 5000))]
        }, now: { now })
        XCTAssertEqual(monitor.report.verdict, .measuring)
        await monitor.measure()
        XCTAssertEqual(calls, 1)
        XCTAssertEqual(monitor.report.verdict, .serverStalled)
        XCTAssertEqual(monitor.report.sampleCount, 1)
        XCTAssertEqual(monitor.report.terminal, terminal)
        XCTAssertFalse(monitor.probing)
    }

    func testMonitorWithoutSamplesStaysMeasuring() async {
        let monitor = IOSLatencyMonitor(readSamples: { [] }, readTerminal: { nil }, probe: {})
        monitor.refresh()
        XCTAssertEqual(monitor.report.verdict, .measuring)
        await monitor.measure()
        XCTAssertEqual(monitor.report.verdict, .measuring)
        XCTAssertNil(monitor.report.totalMedianMs)
        XCTAssertFalse(monitor.probing)
    }

    func testConcurrentMeasurementsAreCoalesced() async {
        var calls = 0
        var pending: CheckedContinuation<Void, Never>?
        let monitor = IOSLatencyMonitor(readSamples: { [] }, readTerminal: { nil }, probe: {
            calls += 1
            await withCheckedContinuation { pending = $0 }
        })
        let first = Task { await monitor.measure() }
        for _ in 0..<100 where pending == nil { await Task.yield() }
        XCTAssertNotNil(pending)
        XCTAssertTrue(monitor.probing)
        await monitor.measure()
        XCTAssertEqual(calls, 1)
        pending?.resume()
        await first.value
        XCTAssertFalse(monitor.probing)
    }

    func testPassiveRefreshExpiresSamplesWithoutProbing() {
        var now = Date(timeIntervalSince1970: 1000)
        let sample = LatencySample(operationID: "session", at: now, totalMs: 90, server: nil)
        var calls = 0
        let monitor = IOSLatencyMonitor(readSamples: { [sample] }, readTerminal: { nil },
            probe: { calls += 1 }, now: { now })
        monitor.refresh()
        XCTAssertEqual(monitor.report.verdict, .ok)
        XCTAssertFalse(monitor.report.serverReportsTiming)
        now = now.addingTimeInterval(301)
        monitor.refresh()
        XCTAssertEqual(monitor.report.verdict, .measuring)
        XCTAssertEqual(calls, 0)
    }
}
