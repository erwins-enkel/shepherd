import XCTest
import SwiftUI
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
