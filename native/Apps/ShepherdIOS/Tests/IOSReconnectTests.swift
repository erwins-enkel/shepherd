import XCTest
import SwiftUI
import UIKit
import Synchronization
import ShepherdKit
@testable import ShepherdAppCore
@testable import ShepherdIOS

@MainActor
final class IOSReconnectTests: XCTestCase {
    func testOfflineCheckingFailedRestartsCountdownAndSuccessStopsIt() async {
        let f = ReconnectFixture()
        defer { f.stop() }
        f.state.update(unreachable: true, lastContact: f.clock.now)
        XCTAssertEqual(f.state.phase, .offline)
        f.state.appear(active: true)
        await settle { f.clock.pending == 1 }
        f.clock.advance(30)
        await settle { f.calls == 1 }
        XCTAssertEqual(f.state.phase, .checking)
        f.state.retry()
        XCTAssertEqual(f.calls, 1)
        f.finish(false)
        await settle { f.state.phase == .failed && f.clock.pending == 1 }
        XCTAssertEqual(f.state.secondsRemaining, 30)
        f.clock.advance(29)
        await settle { f.state.secondsRemaining == 1 }
        await settle { f.clock.pending == 1 }
        f.clock.advance(1)
        await settle { f.calls == 2 }
        f.finish(true)
        await settle { f.state.phase == .connected && f.clock.pending == 1 }
        XCTAssertTrue(f.state.showsReconnected)
        f.clock.advance(3)
        await settle { !f.state.showsReconnected }
        f.clock.advance(90)
        XCTAssertEqual(f.calls, 2)
    }

    func testButtonChecksImmediatelyAndRestartsThirtySecondsAfterFailure() async {
        let f = ReconnectFixture()
        defer { f.stop() }
        f.state.update(unreachable: true)
        f.state.appear(active: true)
        await settle { f.clock.pending == 1 }
        f.clock.advance(24)
        await settle { f.state.secondsRemaining == 6 }
        f.state.retry()
        await settle { f.calls == 1 }
        XCTAssertEqual(f.state.secondsRemaining, 30)
        f.finish(false)
        await settle { f.state.phase == .failed && f.clock.pending == 1 }
        f.clock.advance(1)
        await settle { f.state.secondsRemaining == 29 }
        XCTAssertEqual(f.calls, 1)
    }

    func testInactivePausesAndForegroundRetriesOnceImmediately() async {
        let f = ReconnectFixture()
        defer { f.stop() }
        f.state.update(unreachable: true)
        f.state.appear(active: true)
        await settle { f.clock.pending == 1 }
        f.state.setRunning(false)
        await settle { f.clock.pending == 0 }
        f.clock.advance(90)
        XCTAssertEqual(f.calls, 0)
        XCTAssertEqual(f.state.secondsRemaining, 30)
        f.state.setRunning(true)
        f.state.setRunning(true)
        await settle { f.calls == 1 }
        f.finish(false)
        await settle { f.state.phase == .failed && f.clock.pending == 1 }
    }

    func testSuspendingAnInflightCheckRejectsItsLateSuccess() async {
        let f = ReconnectFixture()
        defer { f.stop() }
        f.state.update(unreachable: true)
        f.state.appear(active: true)
        f.state.retry()
        await settle { f.calls == 1 }
        f.state.setRunning(false)
        f.finish(true)
        await settle { f.pending == nil }
        XCTAssertEqual(f.state.phase, .offline)
        XCTAssertFalse(f.state.showsReconnected)
        f.state.setRunning(true)
        await settle { f.calls == 2 }
        f.finish(true)
        await settle { f.state.phase == .connected }
        f.state.setRunning(false)
        XCTAssertFalse(f.state.showsReconnected)
    }

    func testSpontaneousRecoveryStopsCountdownAndPreservesLastContact() async {
        let f = ReconnectFixture()
        defer { f.stop() }
        let contact = f.clock.now
        f.state.update(unreachable: true, lastContact: contact)
        f.state.appear(active: true)
        f.state.update(unreachable: false)
        XCTAssertEqual(f.state.phase, .connected)
        XCTAssertEqual(f.state.lastContact, contact)
        XCTAssertTrue(f.state.showsReconnected)
        f.state.setRunning(false)
        await settle { f.clock.pending == 0 }
        f.clock.advance(60)
        XCTAssertEqual(f.calls, 0)
    }

    func testPredicateIncludesEveryOutageSignalAndLeavesGoneAndSupersededAlone() {
        XCTAssertTrue(IOSTerminalConnection.isUnreachable(hubUnavailable: true, phase: .live))
        XCTAssertTrue(IOSTerminalConnection.isUnreachable(connection: .offline(message: "asleep"), phase: .live))
        XCTAssertTrue(IOSTerminalConnection.isUnreachable(error: .transport("asleep"), phase: .live))
        XCTAssertTrue(IOSTerminalConnection.isUnreachable(phase: .ended(.unreachable)))
        XCTAssertTrue(IOSTerminalConnection.isUnreachable(phase: .live, stalled: true))
        for phase in [TerminalSessionModel.Phase.live, .connecting, .ended(.gone), .superseded] {
            XCTAssertFalse(IOSTerminalConnection.isUnreachable(connection: .live, phase: phase))
        }
    }

    func testOutageLocksKeysSteersWritingAndDictationWhilePreservingDraft() async {
        let pty = ReconnectPTY()
        let core = TerminalSessionModel(sessionID: "fixture", reply: { _ in XCTFail("Queued reply") }, makeAttachment: { _, _ in pty })
        let terminal = IOSTerminalPresentation(session: core, reply: { _ in XCTFail("Queued reply") })
        defer { terminal.teardown() }
        terminal.visibilityChanged(visible: true, active: true)
        terminal.rendererMounted(cols: 48, rows: 24)
        pty.emit(.attached)
        await settle { core.phase == .live }
        core.promptText = "Keep this unsent draft"
        terminal.openWriting(focus: false)
        let engine = FakeDictationEngine()
        let voice = DictationController(engine: engine, locale: "de-DE", getText: { core.promptText }, setText: { core.promptText = $0 })
        terminal.installVoice(voice)
        await voice.begin(locked: true)
        pty.emit(.closed(.unreachable))
        await settle { terminal.inputLocked }
        terminal.lockWriting()
        XCTAssertFalse(voice.active)
        XCTAssertFalse(terminal.showsWriting)
        XCTAssertFalse(terminal.canRecordReply)
        XCTAssertFalse(terminal.canSendInput)
        XCTAssertFalse(terminal.canSendSteer)
        terminal.openWriting(focus: true)
        terminal.sendKey(.ctrlC)
        let reply = await terminal.submitReply()
        let steer = await terminal.sendSteer("run tests")
        XCTAssertFalse(reply)
        XCTAssertFalse(steer)
        XCTAssertFalse(terminal.showsWriting)
        XCTAssertTrue(pty.sent.isEmpty)
        XCTAssertEqual(core.promptText, "Keep this unsent draft")
        core.takeOver()
        pty.emit(.attached)
        await settle { core.phase == .live }
        XCTAssertFalse(terminal.inputLocked)
        XCTAssertEqual(core.promptText, "Keep this unsent draft")
    }

    func testRetryUsesOwningServerAndSessionReattachesAndAcknowledgesStall() async throws {
        let launch = try IOSLaunchEnvironment(configuration: .init(isIsolated: true))
        let app = launch.makeModel()
        app.liveRequestAudit = nil
        app.makeClient = { profile, credentials, _ in
            let configuration = URLSessionConfiguration.ephemeral
            configuration.protocolClasses = [ReconnectSessionTransport.self, IOSMultiServerFixtureTransport.self]
            return try ShepherdClient(profile: profile, credentials: credentials, requestAttempts: 1,
                readURLSession: URLSession(configuration: configuration))
        }
        let profile = try app.addRemoteProfile(name: "Sleeping Laptop", address: "https://reconnect-\(UUID().uuidString).multi.fixture.invalid")
        try launch.credentials.save(.init(token: "fixture-token", tokenId: "fixture"), for: profile.credentialKey)
        let record = PreviewData.session(id: "owning-session")
        IOSMultiServerFixtureTransport.set([record], for: profile.baseURL)
        ReconnectSessionTransport.response.withLock { $0 = try! JSONEncoder().encode(record) }
        await app.activate(profile)
        defer { app.deactivate() }
        await settle { app.store?.connection == .live }
        app.selectedSessionID = "a-different-selection"
        var retryRefreshes = 0
        app.refreshStore = { store in retryRefreshes += 1; try await store.refresh() }
        ReconnectSessionTransport.failing.withLock { $0 = false }
        defer { ReconnectSessionTransport.failing.withLock { $0 = false } }
        let pty = ReconnectPTY()
        pty.connectOnTakeover = true
        let core = TerminalSessionModel(sessionID: record.id, reply: { _ in }, makeAttachment: { _, _ in pty })
        let terminal = IOSTerminalPresentation(session: core, sessionID: record.id, reply: { _ in })
        defer { terminal.teardown() }
        terminal.visibilityChanged(visible: true, active: true)
        terminal.rendererMounted(cols: 48, rows: 24)
        pty.emit(.attached)
        await settle { core.phase == .live }
        var samples = [LatencySample(operationID: "session", at: .now, totalMs: 1200, server: .init(appMs: 10, lagMs: 5000))]
        let latency = IOSLatencyMonitor(readSamples: { samples }, readTerminal: { nil }, probe: {})
        latency.refresh()
        let connection = IOSTerminalConnection(app: app, hub: nil, terminal: terminal, latency: latency)
        terminal.connection = connection
        connection.update()
        connection.retry.appear(active: true)
        defer { connection.retry.setRunning(false) }
        XCTAssertTrue(terminal.inputLocked, "The header's stalled verdict alone locks input")
        pty.emit(.closed(.unreachable))
        await settle { core.phase == .ended(.unreachable) }
        core.promptText = "Keep this draft through real retry"
        connection.retry.retry()
        await settle { connection.retry.phase == .connected }
        XCTAssertEqual(connection.retry.phase, .connected, "Store \(String(describing: app.store?.connection)), error \(String(describing: app.store?.lastError))")
        XCTAssertEqual(pty.takeovers, 1)
        XCTAssertEqual(retryRefreshes, 1, "Reconnect uses AppModel.retry, including snapshot reconciliation")
        XCTAssertEqual(core.phase, .live)
        XCTAssertEqual(core.promptText, "Keep this draft through real retry")
        XCTAssertEqual(ReconnectSessionTransport.lastPath.withLock { $0 }, "/api/sessions/owning-session")
        XCTAssertEqual(latency.report.verdict, .serverStalled, "Historical lag may still describe the preceding minute")
        XCTAssertFalse(terminal.inputLocked, "A successful response acknowledges that stall episode promptly")
        samples = [LatencySample(operationID: "session", at: .now, totalMs: 80, server: .init(appMs: 10, lagMs: 0))]
        latency.refresh(); connection.update()
        samples = [LatencySample(operationID: "session", at: .now, totalMs: 1200, server: .init(appMs: 10, lagMs: 6000))]
        latency.refresh(); connection.update()
        XCTAssertTrue(terminal.inputLocked, "A new stall after recovery locks again")
        ReconnectSessionTransport.failing.withLock { $0 = true }
        connection.retry.retry()
        await settle { connection.retry.phase == .failed }
        samples = [LatencySample(operationID: "session", at: .now, totalMs: 80, server: .init(appMs: 10, lagMs: 0))]
        latency.refresh(); connection.update()
        XCTAssertTrue(terminal.inputLocked, "A failed session confirmation stays locked even after the old stall expires")
        ReconnectSessionTransport.failing.withLock { $0 = false }
        connection.retry.retry()
        await settle { connection.retry.phase == .connected }
        XCTAssertFalse(terminal.inputLocked)
        XCTAssertEqual(pty.takeovers, 1, "A live PTY is never taken over by a server retry")
        let refreshesBeforeReactivation = retryRefreshes
        await app.activate(profile)
        await settle { app.store?.connection == .live }
        connection.update()
        XCTAssertTrue(terminal.inputLocked, "An old terminal cannot write into a replacement activation")
        connection.retry.retry()
        await settle { connection.retry.phase == .failed }
        XCTAssertEqual(retryRefreshes, refreshesBeforeReactivation, "An obsolete terminal never retries the new activation")
    }

    func testRenderReconnectPaneStates() async throws {
        let directory = URL(fileURLWithPath: "/private/tmp/claude-501/-Users-kai-osthoff-githubrepos--shepherd-worktrees-shepherd-design-verbindung-fehlt-entsprechenden/b52163ee-ad92-403d-bf51-2affaf39cc27/scratchpad/renders")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        for name in ["offline", "checking", "failed", "reconnected", "offline-large-type", "offline-large-type-bottom", "offline-no-contact"] {
            let f = ReconnectFixture()
            defer { f.stop() }
            f.state.update(unreachable: true, lastContact: name == "offline-no-contact" ? nil : f.clock.now)
            f.state.appear(active: true)
            if name == "checking" || name == "failed" {
                f.state.retry()
                await settle { f.calls == 1 }
                if name == "failed" {
                    f.finish(false)
                    await settle { f.state.phase == .failed }
                }
            } else if name == "reconnected" { f.state.update(unreachable: false) }
            else if name != "offline-no-contact" {
                await settle { f.clock.pending == 1 }
                f.clock.advance(6)
                await settle { f.state.secondsRemaining == 24 }
            }
            let pty = ReconnectPTY()
            let core = TerminalSessionModel(sessionID: "fixture", reply: { _ in }, makeAttachment: { _, _ in pty })
            let terminal = IOSTerminalPresentation(session: core, reply: { _ in })
            defer { terminal.teardown() }
            let output = VStack(alignment: .leading, spacing: 14) {
                Text(verbatim: "$ shepherd session attach TASK-01").foregroundStyle(IOSTerminalStyle.muted)
                Text(verbatim: "⏺ Checking the iOS terminal…\n\n  Shared session actions\n  Apple preview + Whisper final\n\n⏺ Ready for your reply")
                Spacer()
            }.font(.system(size: 12, design: .monospaced)).padding(12).padding(.top, 40)
            let pane = IOSTerminalPane(model: terminal, allowsInput: true, surface: output, fontSize: .constant(12),
                rendersStaticFixture: true, reconnectFixture: f.state, fixtureServerName: "MacBook Pro")
            let content = VStack(spacing: 0) {
                HStack {
                    Text(verbatim: "←  TASK-01 · Terminal"); Spacer()
                    Text(verbatim: "MacBook Pro").foregroundStyle(IOSTerminalStyle.muted)
                }.font(.system(size: 12, design: .monospaced)).padding(16)
                Rectangle().fill(IOSTerminalStyle.line).frame(height: 1)
                pane
            }
            .frame(width: 390, height: 800)
            .background(IOSTerminalStyle.background).foregroundStyle(IOSTerminalStyle.ink)
            .preferredColorScheme(.dark)
            .environment(\.dynamicTypeSize, name.hasPrefix("offline-large-type") ? .accessibility3 : .large)
            let image = try await renderHostedFixture(content, scrollToBottom: name == "offline-large-type-bottom")
            try XCTUnwrap(image.pngData()).write(to: directory.appendingPathComponent("reconnect-\(name).png"))
        }
    }

    // ImageRenderer cannot draw UIKit ProgressView/ScrollView surfaces directly.
    // Render a hosted fixture first, then export it through ImageRenderer.
    private func renderHostedFixture<V: View>(_ content: V, scrollToBottom: Bool) async throws -> UIImage {
        let size = CGSize(width: 390, height: 800)
        let host = UIHostingController(rootView: content.ignoresSafeArea(.container))
        host.safeAreaRegions = []
        let window = UIWindow(frame: CGRect(origin: .zero, size: size))
        window.rootViewController = host
        window.isHidden = false
        host.view.frame = window.bounds
        defer { window.isHidden = true; window.rootViewController = nil }
        host.view.setNeedsLayout(); host.view.layoutIfNeeded()
        if scrollToBottom {
            func findScroll(_ view: UIView) -> UIScrollView? {
                if let scroll = view as? UIScrollView, scroll.contentSize.height > scroll.bounds.height { return scroll }
                return view.subviews.compactMap { findScroll($0) }.first
            }
            await settle { host.view.layoutIfNeeded(); return findScroll(host.view) != nil }
            let scroll = try XCTUnwrap(findScroll(host.view))
            scroll.setContentOffset(CGPoint(x: 0, y: scroll.contentSize.height - scroll.bounds.height), animated: false)
            host.view.layoutIfNeeded()
        }
        let format = UIGraphicsImageRendererFormat(); format.scale = 2
        var rendered = false
        let hosted = UIGraphicsImageRenderer(size: size, format: format).image { _ in
            rendered = host.view.drawHierarchy(in: host.view.bounds, afterScreenUpdates: true)
        }
        XCTAssertTrue(rendered)
        let renderer = ImageRenderer(content: Image(uiImage: hosted).resizable().frame(width: size.width, height: size.height))
        renderer.scale = 2
        return try XCTUnwrap(renderer.uiImage)
    }

    private func settle(_ condition: () -> Bool, file: StaticString = #filePath, line: UInt = #line) async {
        let deadline = ContinuousClock.now + .seconds(10)
        while !condition(), ContinuousClock.now < deadline { await Task.yield() }
        XCTAssertTrue(condition(), file: file, line: line)
    }
}

@MainActor
private final class ReconnectFixture {
    let clock = ReconnectClock()
    var calls = 0
    var pending: CheckedContinuation<Bool, Never>?
    lazy var state = IOSReconnectState(now: { self.clock.now }, sleep: { try await self.clock.sleep($0) }, reconnect: {
        self.calls += 1
        return await withCheckedContinuation { self.pending = $0 }
    })
    func finish(_ success: Bool) { let continuation = pending; pending = nil; continuation?.resume(returning: success) }
    func stop() { state.setRunning(false); finish(false); clock.cancelAll() }
}

@MainActor
private final class ReconnectClock {
    var now = Date(timeIntervalSince1970: 1_790_000_000)
    private var sleepers: [UUID: (Date, CheckedContinuation<Void, any Error>)] = [:]
    var pending: Int { sleepers.count }
    func sleep(_ duration: Duration) async throws {
        let id = UUID()
        let seconds = Double(duration.components.seconds) + Double(duration.components.attoseconds) / 1e18
        try await withTaskCancellationHandler {
            try Task.checkCancellation()
            try await withCheckedThrowingContinuation { sleepers[id] = (now.addingTimeInterval(seconds), $0) }
        } onCancel: {
            Task { @MainActor [weak self] in self?.sleepers.removeValue(forKey: id)?.1.resume(throwing: CancellationError()) }
        }
    }
    func advance(_ seconds: TimeInterval) {
        now = now.addingTimeInterval(seconds)
        for id in sleepers.keys.filter({ sleepers[$0]!.0 <= now }) { sleepers.removeValue(forKey: id)?.1.resume() }
    }
    func cancelAll() {
        let pending = sleepers.values
        sleepers.removeAll()
        for (_, continuation) in pending { continuation.resume(throwing: CancellationError()) }
    }
}

@MainActor
private final class ReconnectPTY: PTYAttaching {
    let output: AsyncStream<Data> = AsyncStream { _ in }
    let lifecycle: AsyncStream<PTYConnection.LifecycleEvent>
    private let events: AsyncStream<PTYConnection.LifecycleEvent>.Continuation
    var sent: [Data] = []
    var takeovers = 0
    var connectOnTakeover = false
    init() { (lifecycle, events) = AsyncStream.makeStream() }
    func start() {}
    func stop() {}
    func resize(cols: Int, rows: Int) {}
    func takeOver() { takeovers += 1; if connectOnTakeover { emit(.attached) } }
    func send(_ data: Data) { sent.append(data) }
    func emit(_ event: PTYConnection.LifecycleEvent) { events.yield(event) }
}

/// Only the per-session read; other retry/bootstrap routes use the existing fixture.
private final class ReconnectSessionTransport: URLProtocol, @unchecked Sendable {
    static let response = Mutex(Data())
    static let failing = Mutex(false)
    static let lastPath = Mutex("")
    override class func canInit(with request: URLRequest) -> Bool {
        request.url?.host?.hasSuffix(".multi.fixture.invalid") == true && request.url?.path.hasPrefix("/api/sessions/") == true
    }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        guard let url = request.url else { return }
        Self.lastPath.withLock { $0 = url.path }
        if Self.failing.withLock({ $0 }) {
            client?.urlProtocol(self, didFailWithError: URLError(.timedOut))
            return
        }
        let response = HTTPURLResponse(url: url, statusCode: 200, httpVersion: nil, headerFields: ["Content-Type": "application/json"])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Self.response.withLock { $0 })
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}
