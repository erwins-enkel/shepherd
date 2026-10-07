import XCTest
import SwiftUI
import UIKit
import AVFoundation
import ShepherdAppCore
import ShepherdKit
@testable import ShepherdIOS

@MainActor
final class IOSComposeTests: XCTestCase {
    private func fixture() throws -> (AppModel, SessionStore, ComposeModel) {
        let launch = try IOSLaunchEnvironment(configuration: .init(isIsolated: true))
        let app = launch.makeModel()
        let (store, model, _, _) = try IOSComposeFixture.make(app: app)
        return (app, store, model)
    }
    private func activeFixture(diagnostics: String = IOSMultiServerFixtureTransport.readyDiagnostics) async throws -> (AppModel, SessionStore) {
        let launch = try IOSLaunchEnvironment(configuration: .init(isIsolated: true))
        let app = launch.makeModel()
        app.liveRequestAudit = nil
        let profile = try app.addRemoteProfile(name: "Composer", address: "https://compose-\(UUID().uuidString).multi.fixture.invalid")
        URLProtocol.registerClass(IOSMultiServerFixtureTransport.self)
        IOSMultiServerFixtureTransport.setSettings(#"{"repoRoot":"/fixtures","repoRootDisplay":"/fixtures","firstRunPending":false,"defaultModel":"sonnet","defaultCodexModel":"gpt-6-astra","defaultEffort":"high","defaultAgentProvider":"claude","authMode":"subscription","operatorLanguage":"de","usageHoldEnabled":true,"usageHoldPct":80}"#, for: profile.baseURL)
        IOSMultiServerFixtureTransport.setDiagnostics(diagnostics, for: profile.baseURL)
        try launch.credentials.save(.init(token: "fixture-token", tokenId: "fixture"), for: profile.credentialKey)
        await app.activate(profile)
        let store = try XCTUnwrap(app.store)
        let deadline = ContinuousClock.now.advanced(by: .seconds(10))
        while !store.hasLoadedSessions, ContinuousClock.now < deadline { await Task.yield() }
        XCTAssertTrue(store.hasLoadedSessions)
        let recovery = try XCTUnwrap(app.extension(BackendRecoveryModel.self))
        await recovery.refresh()
        store.apply(.usageLimits(.init(session5h: .init(pct: 80, resetAt: 0), week: nil,
            perModelWeek: [], credits: nil, stale: false, calibratedAt: nil, subscriptionOnly: false)))
        let usageDeadline = ContinuousClock.now.advanced(by: .seconds(10))
        while SessionSignals.usageLimits(for: app)?.session5h?.pct != 80, ContinuousClock.now < usageDeadline { await Task.yield() }
        XCTAssertEqual(SessionSignals.usageLimits(for: app)?.session5h?.pct, 80)
        return (app, store)
    }
    private func freshContent(app: AppModel, store: SessionStore) -> IOSComposeContent {
        let voice = DictationController(engine: FakeDictationEngine(), getText: { "" }, setText: { _ in })
        return IOSComposeContent(app: app, store: store, activation: app.activationGeneration, voice: voice,
            initialPrompt: "Add tests", initialRepoPath: "/fixtures/shepherd")
    }
    func testLateSettingsReconcileOnlyUntouchedFreshComposers() async throws {
        for (manual, expectedProvider, expectedModel) in [(false, AgentProvider.codex, "gpt-6-astra"), (true, .claude, "sonnet")] {
            let launch = try IOSLaunchEnvironment(configuration: .init(isIsolated: true))
            let app = launch.makeModel()
            let profile = ServerProfile(name: "Late settings", baseURL: URL(string: "https://late-\(UUID().uuidString.lowercased()).multi.fixture.invalid")!, mode: .remote)
            IOSMultiServerFixtureTransport.setSettings(#"{"repoRoot":"/fixtures","repoRootDisplay":"/fixtures","firstRunPending":false,"defaultModel":"sonnet","defaultCodexModel":"gpt-6-astra","defaultEffort":"high","defaultAgentProvider":"codex","authMode":"subscription","operatorLanguage":"de"}"#, for: profile.baseURL)
            let configuration = URLSessionConfiguration.ephemeral
            configuration.protocolClasses = [IOSMultiServerFixtureTransport.self]
            let transport = URLSession(configuration: configuration)
            defer { transport.invalidateAndCancel() }
            let client = try ShepherdClient(profile: profile, credentials: launch.credentials, urlSession: transport)
            let store = SessionStore(client: client)
            defer { store.stop(); app.deactivate() }
            XCTAssertNil(store.settings)
            let content = freshContent(app: app, store: store)
            let model = content.model
            defer { model.teardown(); content.voice.teardown() }
            XCTAssertEqual(model.provider, .claude)
            if manual { model.selectProviderManually(.claude) }
            let appeared = expectation(description: "Composer settings observer mounted")
            let host = UIHostingController(rootView: content.environment(app).onAppear { appeared.fulfill() })
            let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 390, height: 844))
            window.rootViewController = host
            window.makeKeyAndVisible()
            host.view.frame = window.bounds
            defer { window.isHidden = true; window.rootViewController = nil }
            host.view.layoutIfNeeded()
            await fulfillment(of: [appeared], timeout: 10)
            try await store.bootstrap()
            let deadline = ContinuousClock.now.advanced(by: .seconds(10))
            while model.model != expectedModel, ContinuousClock.now < deadline {
                host.view.setNeedsLayout(); host.view.layoutIfNeeded()
                await Task.yield()
            }
            XCTAssertEqual(store.settings?.defaultAgentProvider, .codex)
            XCTAssertEqual(model.provider, expectedProvider)
            XCTAssertEqual(model.model, expectedModel)
            let submission = ComposeSubmission()
            defer { submission.teardown() }
            let session = await submission.submit(model: model, repoResolved: true, holdLikely: false,
                create: { request, spawnID in
                    XCTAssertEqual(request.agentProvider, expectedProvider)
                    XCTAssertEqual(request.model, expectedModel)
                    return try await client.createSession(request, spawnID: spawnID)
                }, isCurrent: { true })
            XCTAssertEqual(session?.id, "compose-created")
        }
    }
    func testFreshComposerSubmitsCapacitySelectedProviderWithoutOpeningEnginePicker() async throws {
        let (app, store) = try await activeFixture()
        defer { app.deactivate() }
        let content = freshContent(app: app, store: store)
        defer { content.model.teardown(); content.voice.teardown() }
        XCTAssertEqual(content.model.provider, .codex)
        XCTAssertEqual(content.model.model, "gpt-6-astra")
        XCTAssertFalse(content.readiness.dualCTA)
        let submission = ComposeSubmission()
        defer { submission.teardown() }
        let session = await submission.submit(model: content.model, repoResolved: true, holdLikely: true,
            create: { request, spawnID in
                XCTAssertEqual(request.agentProvider, .codex)
                XCTAssertEqual(request.model, "gpt-6-astra")
                XCTAssertEqual(request.effort?.rawValue, "high")
                return try await store.client.createSession(request, spawnID: spawnID)
            }, isCurrent: { true })
        XCTAssertEqual(session?.id, "compose-created")
        content.model.selectProviderManually(.claude)
        XCTAssertTrue(content.readiness.dualCTA)
        store.apply(.usageLimits(.init(session5h: .init(pct: 95, resetAt: 0), week: nil,
            perModelWeek: [], credits: nil, stale: false, calibratedAt: nil, subscriptionOnly: false)))
        content.model.runDefaults = ComposeRunConfig.defaults(from: store.settings)
        XCTAssertEqual(content.model.provider, .claude)
        content.model.pickCommand(.init(name: "review", description: "Review", scope: .init(known: .project), providers: [.codex]))
        content.model.runDefaults = ComposeRunConfig.defaults(from: store.settings)
        XCTAssertEqual(content.model.provider, .codex)
    }
    func testLateDiagnosticsOnlyAffectTheNextFreshComposer() async throws {
        let (app, store) = try await activeFixture(diagnostics: #"{"checks":[],"generatedAt":0,"overall":"ok"}"#)
        defer { app.deactivate() }
        let content = freshContent(app: app, store: store)
        defer { content.model.teardown(); content.voice.teardown() }
        XCTAssertEqual(content.model.provider, .claude)
        XCTAssertTrue(content.readiness.dualCTA)
        store.apply(.unknown(name: "diagnostics:status", payload: Data(IOSMultiServerFixtureTransport.readyDiagnostics.utf8)))
        let recovery = try XCTUnwrap(app.extension(BackendRecoveryModel.self))
        let deadline = ContinuousClock.now.advanced(by: .seconds(10))
        while recovery.diagnostics?.checks.count != 2, ContinuousClock.now < deadline { await Task.yield() }
        XCTAssertEqual(recovery.diagnostics?.checks.count, 2)
        content.model.runDefaults = ComposeRunConfig.defaults(from: store.settings)
        XCTAssertEqual(content.model.provider, .claude)
        let reopened = freshContent(app: app, store: store)
        defer { reopened.model.teardown(); reopened.voice.teardown() }
        XCTAssertEqual(reopened.model.provider, .codex)
        let supplied = IOSComposeContent(app: app, store: store, activation: app.activationGeneration,
            model: content.model, voice: content.voice)
        XCTAssertTrue(supplied.model === content.model)
        XCTAssertEqual(supplied.model.provider, .claude)
        app.deactivate()
        XCTAssertNil(recovery.diagnostics)
    }
    func testReadinessVoiceBlockingAndModeGuards() throws {
        let (_, _, model) = try fixture()
        XCTAssertFalse(model.readiness(repoResolved: true).canSubmit)
        model.prompt = "Add tests"
        XCTAssertTrue(model.readiness(repoResolved: true).canSubmit)
        model.setMode(.research); XCTAssertTrue(model.modeLocked)
        model.setMode(.plain); XCTAssertTrue(model.modeLocked)
        let engine = FakeDictationEngine()
        let controller = DictationController(engine: engine, getText: { model.prompt }, setText: { model.prompt = $0 })
        XCTAssertFalse(controller.active)
        model.teardown()
    }
    func testPublicEntryRejectsDisconnectedAndIsolatedReadOnlyApp() throws {
        let (app, _, model) = try fixture()
        XCTAssertFalse(IOSComposer.open(app)); XCTAssertNil(app.sheet)
        model.teardown()
    }
    func testPermissionDescriptionsAreLocalizedAndNoBackgroundAudio() throws {
        XCTAssertNotNil(Bundle.main.object(forInfoDictionaryKey: "NSMicrophoneUsageDescription"))
        XCTAssertNotNil(Bundle.main.object(forInfoDictionaryKey: "NSSpeechRecognitionUsageDescription"))
        XCTAssertNil(Bundle.main.object(forInfoDictionaryKey: "UIBackgroundModes"))
        XCTAssertFalse(L.t("native_compose_voice_finalize").contains("native_compose"))
    }
    func testSubmissionUsesFakeTransportAndSelectsCreatedSession() async throws {
        let (app, store, model) = try fixture()
        try await store.bootstrap()
        model.prompt = "Add tests"
        let submission = ComposeSubmission()
        let result = await submission.submit(model: model, repoResolved: true, holdLikely: false,
            create: { try await store.client.createSession($0, spawnID: $1) }, isCurrent: { true })
        let session = try XCTUnwrap(result)
        store.apply(.sessionNew(session)); app.selectedSessionID = session.id
        XCTAssertEqual(app.selectedSessionID, "compose-created")
        XCTAssertNotNil(store.session(id: "compose-created"))
        submission.teardown(); model.teardown()
    }
    func testSpeechFactoryUsesCapabilitiesAndExplicitConsent() {
        XCTAssertEqual(SpeechEngineChoice.choose(analyzer: true, recognizer: true, onDevice: true, speechGranted: true, appleServerConsent: false, whisper: true), .analyzer)
        XCTAssertEqual(SpeechEngineChoice.choose(analyzer: false, recognizer: true, onDevice: true, speechGranted: true, appleServerConsent: false, whisper: false), .onDevice)
        XCTAssertEqual(SpeechEngineChoice.choose(analyzer: false, recognizer: true, onDevice: false, speechGranted: true, appleServerConsent: false, whisper: true), .needsConsent)
        XCTAssertEqual(SpeechEngineChoice.choose(analyzer: false, recognizer: true, onDevice: false, speechGranted: true, appleServerConsent: true, whisper: false), .appleServer)
        XCTAssertEqual(SpeechEngineChoice.choose(analyzer: true, recognizer: true, onDevice: true, speechGranted: false, appleServerConsent: false, whisper: true), .whisperOnly)
        XCTAssertEqual(SpeechEngineChoice.choose(analyzer: true, recognizer: true, onDevice: true, speechGranted: false, appleServerConsent: false, whisper: false), .denied)
        XCTAssertEqual(SpeechEngineChoice.choose(analyzer: false, recognizer: false, onDevice: false, speechGranted: false, appleServerConsent: false, whisper: false), .unsupported)
    }
    func testTokenCommandSheetUsesTokenProviderInsteadOfSelectedProvider() async throws {
        let (_, _, model) = try fixture()
        defer { model.teardown() }
        model.provider = .claude; model.prompt = "$rev"
        let codexSheet = ComposeSourceSheet(model: model, commands: true, dismiss: {})
        XCTAssertEqual(codexSheet.commandProvider, .codex)
        await model.loadCommands(provider: codexSheet.commandProvider)
        XCTAssertEqual(model.commands(for: .codex).map(\.name), ["codex-review"])
        XCTAssertTrue(model.commands.isEmpty)
        model.provider = .codex; model.prompt = "/rev"
        let claudeSheet = ComposeSourceSheet(model: model, commands: true, dismiss: {})
        XCTAssertEqual(claudeSheet.commandProvider, .claude)
        await model.loadCommands(provider: claudeSheet.commandProvider)
        XCTAssertEqual(model.commands(for: .claude).map(\.name), ["review"])
    }
    func testTapCopiesBorrowedAudioBeforeActorHandoff() throws {
        let format = try XCTUnwrap(AVAudioFormat(standardFormatWithSampleRate: 16000, channels: 1))
        let source = try XCTUnwrap(AVAudioPCMBuffer(pcmFormat: format, frameCapacity: 2))
        source.frameLength = 2
        source.floatChannelData![0][0] = 0.5; source.floatChannelData![0][1] = -0.5
        let copy = try XCTUnwrap(CapturedAudio(source))
        source.floatChannelData![0][0] = 0
        XCTAssertEqual(copy.buffer.floatChannelData![0][0], 0.5)
        XCTAssertEqual(copy.buffer.frameLength, 2)
    }
    func testRenderApprovedComposerStates() async throws {
        let directory = URL(fileURLWithPath: "/private/tmp/claude-501/-Users-kai-osthoff-githubrepos-shepherd/36c6a6cb-46a0-4781-99da-a39e745b0a43/scratchpad/ios-compose/")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        for state in ["idle", "recording", "cancel", "locked", "result", "finalizing", "denied", "unsupported", "uploading"] {
            let (app, store, model) = try fixture()
            try await store.bootstrap()
            let engine = FakeDictationEngine()
            var clock = Date(timeIntervalSince1970: 100)
            let voice = DictationController(engine: engine, locale: "de-DE", now: { clock }, getText: { model.prompt }, setText: { model.prompt = $0 })
            if state == "denied" || state == "unsupported" {
                engine.startError = state == "denied" ? .denied : .unsupported; await voice.begin()
            } else if state == "uploading" {
                // A pending photo import renders the upload footer without a live transfer.
                model.prompt = "Bestehender Prompt-Text."
                _ = model.attachments.beginImport()
                XCTAssertEqual(model.attachments.status?.phase, .preparing)
                XCTAssertTrue(model.readiness(repoResolved: true).canQueue)
            } else if state != "idle" {
                model.prompt = "Bestehender Prompt-Text."
                engine.recording = .init(clips: [], appleText: "Füge einen Dark-Mode-Schalter in den Einstellungen hinzu und aktualisiere die Tests.")
                await voice.begin(locked: state == "locked")
                engine.emit(.volatile("Füge einen Dark-Mode-Schalter in den Einstellungen hinzu und aktualisiere die Tests…")); engine.emit(.level(0.8))
                for _ in 0..<30 { await Task.yield() }
                clock.addTimeInterval(state == "locked" ? 107 : 12); voice.tick()
                if state == "locked" { engine.emit(.final("Füge einen Dark-Mode-Schalter in den Einstellungen hinzu.")); for _ in 0..<30 { await Task.yield() } }
                if state == "cancel" { voice.drag(x: -90, y: 0) }
                if state == "result" { voice.finalize(); for _ in 0..<30 { await Task.yield() } }
                if state == "finalizing" { voice.finalize() }
            }
            let content = IOSComposeContent(app: app, store: store, activation: 0, model: model, voice: voice)
                .frame(width: 390, height: 844).environment(\.composeRendering, true).environment(\.locale, Locale(identifier: "de")).environment(\.displayScale, 1)
            let renderer = ImageRenderer(content: content); renderer.scale = 2
            let png = try XCTUnwrap(renderer.uiImage?.pngData())
            try png.write(to: directory.appendingPathComponent("composer-\(state).png"))
            voice.teardown(); model.teardown()
        }
        // A separate accessibility-sized rendering verifies the growing dock can fit.
        let (app, store, model) = try fixture(), engine = FakeDictationEngine()
        try await store.bootstrap()
        let voice = DictationController(engine: engine, getText: { model.prompt }, setText: { model.prompt = $0 })
        let renderer = ImageRenderer(content: IOSComposeContent(app: app, store: store, activation: 0, model: model, voice: voice)
            .environment(\.composeRendering, true).environment(\.dynamicTypeSize, .accessibility3).frame(width: 390, height: 844))
        try XCTUnwrap(renderer.uiImage?.pngData()).write(to: directory.appendingPathComponent("composer-accessibility.png"))
        model.teardown()
    }
}
