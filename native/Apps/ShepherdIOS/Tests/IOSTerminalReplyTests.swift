import XCTest
import SwiftUI
import UIKit
import ShepherdKit
@testable import ShepherdAppCore
@testable import ShepherdIOS

@MainActor
final class IOSTerminalReplyTests: XCTestCase {
    func testActionWriteBlockDisablesAttachmentsKeysAndRepliesOnLivePTY() async {
        let f = ReplyFixture()
        f.uploads = AttachmentModel(upload: { _, _ in XCTFail("Unexpected upload"); throw ShepherdError.notFound })
        defer { f.teardown() }
        await f.live()
        f.core.promptText = "Keep my draft"
        XCTAssertTrue(f.model.canAttach)
        XCTAssertTrue(f.model.canSubmitReply)
        f.writable = false
        XCTAssertFalse(f.model.canAttach)
        XCTAssertFalse(f.model.canSendInput)
        XCTAssertFalse(f.model.canRecordReply)
        XCTAssertFalse(f.model.canSubmitReply)
        f.model.sendKey(.ctrlC)
        let sent = await f.model.submitReply()
        XCTAssertFalse(sent)
        XCTAssertTrue(f.sent.isEmpty)
        XCTAssertEqual(f.core.promptText, "Keep my draft")
    }

    func testEndedSessionOffersResumeOnlyForSharedEligibleWritableSessions() async {
        let f = ReplyFixture()
        defer { f.teardown() }
        await f.end(.gone)
        XCTAssertTrue(f.model.canResume)
        f.writable = false
        XCTAssertFalse(f.model.canResume)
        await f.model.resume()
        XCTAssertEqual(f.resumes, 0)
        f.writable = true
        for status in [SessionStatusKnown.archived, .running, .blocked] {
            f.record.status = .init(known: status)
            XCTAssertFalse(f.model.canResume)
        }
        f.record.status = .init(known: .done)
        f.record.claudeSessionId = ""
        XCTAssertFalse(f.model.canResume)
        f.record.agentProvider = .codex
        XCTAssertTrue(f.model.canResume)
        f.record.terminal = true
        XCTAssertFalse(f.model.canResume)
    }

    func testResumeUsesSessionActionProgressFailureAndSuccessfulReattach() async {
        let f = ReplyFixture()
        defer { f.teardown() }
        await f.end(.gone)
        f.holdResume = true
        let failed = Task { await f.model.resume() }
        await settle { f.pending != nil }
        XCTAssertTrue(f.state.busy)
        await f.model.resume()
        XCTAssertEqual(f.resumes, 1)
        f.resumeError = ShepherdError.notFound
        f.release()
        await failed.value
        XCTAssertEqual(f.model.actionState?.error, L.t("cardmenu_resume_failed", f.record.name))
        XCTAssertEqual(f.core.phase, .ended(.gone))
        XCTAssertEqual(f.pty.takeovers, 0)
        f.resumeError = nil
        await f.model.resume()
        XCTAssertEqual(f.resumes, 2)
        XCTAssertEqual(f.pty.takeovers, 1)
        XCTAssertEqual(f.core.phase, .connecting)
        f.pty.emit(.attached)
        await settle { f.core.phase == .live }
        XCTAssertNil(f.state.error)
    }

    func testReconnectNeverResumesAndReadOnlyHasNoReplyBar() async {
        let f = ReplyFixture()
        defer { f.teardown() }
        await f.end(.unreachable)
        XCTAssertFalse(f.model.canResume)
        await f.model.resume()
        XCTAssertEqual(f.resumes, 0)
        let isolated = IOSTerminalPresentation(session: f.core, allowsInput: false,
            actions: { f.state }, reply: { _ in XCTFail("Read-only reply") })
        XCTAssertFalse(isolated.showsReplyBar)
        XCTAssertFalse(isolated.canRecordReply)
        isolated.prepareDictation()
        XCTAssertNil(isolated.voice)
        await isolated.resume()
        XCTAssertEqual(f.resumes, 0)
    }

    func testResumeCompletingOffscreenDefersAttachUntilVisibleRenderer() async {
        let f = ReplyFixture()
        defer { f.teardown() }
        await f.end(.gone)
        f.holdResume = true
        let resume = Task { await f.model.resume() }
        await settle { f.pending != nil }
        f.model.rendererUnmounted()
        f.model.visibilityChanged(visible: false, active: false)
        f.release()
        await resume.value
        XCTAssertEqual(f.pty.takeovers, 0)
        XCTAssertFalse(f.model.isAttached)
        f.model.visibilityChanged(visible: true, active: true)
        XCTAssertEqual(f.pty.starts, 1)
        f.model.rendererMounted(cols: 48, rows: 24)
        XCTAssertEqual(f.attachments.count, 2)
        XCTAssertEqual(f.pty.starts, 1)
        f.pty.emit(.attached)
        await settle { f.core.phase == .live }
    }

    func testSharedRailResumeReattachesOnlyOnTransitionToRunning() async {
        let f = ReplyFixture()
        defer { f.teardown() }
        await f.end(.gone)
        f.model.serverSessionChanged(.init(known: .done))
        f.model.serverSessionChanged(.init(known: .done))
        XCTAssertEqual(f.pty.takeovers, 0)
        f.model.serverSessionChanged(.init(known: .running))
        XCTAssertEqual(f.pty.takeovers, 1)
        f.model.serverSessionChanged(.init(known: .running))
        XCTAssertEqual(f.pty.takeovers, 1)
        XCTAssertEqual(f.resumes, 0)
    }

    func testVoiceIdleTypingRecordingLockedFinalizingAndExplicitSend() async {
        let f = ReplyFixture()
        defer { f.teardown() }
        await f.live()
        XCTAssertTrue(f.model.canRecordReply)
        XCTAssertFalse(f.model.canSubmitReply)
        f.core.promptText = "Existing draft."
        XCTAssertTrue(f.model.canSubmitReply)
        await f.voice.begin()
        XCTAssertEqual(f.voice.state, .recording)
        XCTAssertFalse(f.model.canSubmitReply)
        f.engine.emit(.preview("Add regression tests"))
        await settle { f.voice.preview == "Add regression tests" }
        XCTAssertEqual(f.core.promptText, "Existing draft.")
        f.voice.drag(x: 0, y: -70)
        XCTAssertEqual(f.voice.state, .locked)
        f.engine.emit(.checkpoint("Add regression tests"))
        await settle { f.core.promptText.contains("regression") }
        XCTAssertTrue(f.sent.isEmpty)
        f.clock += 2
        f.engine.recording = .init(clips: [], appleText: "Add regression tests.")
        f.voice.finalize()
        XCTAssertEqual(f.voice.state, .finalizing)
        XCTAssertFalse(f.model.canSubmitReply)
        await settle { !f.voice.active }
        XCTAssertEqual(f.core.promptText, "Existing draft. Add regression tests.")
        XCTAssertTrue(f.sent.isEmpty)
        XCTAssertTrue(f.model.canSubmitReply)
        let success = await f.model.submitReply()
        XCTAssertTrue(success)
        XCTAssertEqual(f.sent, ["Existing draft. Add regression tests."])
        XCTAssertTrue(f.core.promptText.isEmpty)
    }

    func testSharedControllerSlideCancelUndoAndPermissionErrorPreserveDraft() async {
        let f = ReplyFixture()
        defer { f.teardown() }
        await f.live()
        f.core.promptText = "Keep this"
        await f.voice.begin()
        f.voice.drag(x: -100, y: 0)
        XCTAssertEqual(f.voice.state, .cancelling)
        f.voice.release()
        XCTAssertEqual(f.core.promptText, "Keep this")
        await f.voice.begin(locked: true)
        f.clock += 2
        f.engine.recording = .init(clips: [], appleText: "added text")
        f.voice.finalize()
        await settle { f.voice.canUndo }
        XCTAssertEqual(f.core.promptText, "Keep this added text")
        f.voice.undo()
        XCTAssertEqual(f.core.promptText, "Keep this")
        f.engine.startError = .denied
        await f.voice.begin()
        XCTAssertEqual(f.voice.state, .denied)
        XCTAssertNotNil(f.voice.noticeCopy)
        XCTAssertTrue(f.model.canSubmitReply)
        XCTAssertTrue(f.sent.isEmpty)
    }

    func testSendingAndFailureDisableRecordingRetainEditableDraft() async {
        let f = ReplyFixture()
        defer { f.teardown() }
        await f.live()
        f.core.promptText = "Keep after failure"
        f.holdReply = true
        let send = Task { await f.model.submitReply() }
        await settle { f.pending != nil }
        XCTAssertTrue(f.model.replying)
        XCTAssertFalse(f.model.canRecordReply)
        XCTAssertFalse(f.model.canSubmitReply)
        f.replyError = ShepherdError.notFound
        f.release()
        let success = await send.value
        XCTAssertFalse(success)
        XCTAssertEqual(f.core.promptText, "Keep after failure")
        XCTAssertNotNil(f.model.replyError)
        XCTAssertTrue(f.model.canRecordReply)
        XCTAssertTrue(f.model.canSubmitReply)
    }

    func testWhisperFinalReplacesApplePreviewWithoutSending() async {
        let f = ReplyFixture()
        defer { f.teardown() }
        await f.live()
        let finalizer = WhisperFinalizer(status: { true }, transcribe: { _, language in
            XCTAssertEqual(language, "de"); return "Final Whisper transcript"
        })
        let voice = DictationController(engine: f.engine, finalizer: finalizer, locale: "de-DE",
            now: { Date(timeIntervalSince1970: f.clock) },
            getText: { f.core.promptText }, setText: { f.core.promptText = $0 })
        f.model.installVoice(voice)
        await voice.begin()
        f.engine.emit(.preview("Apple preview"))
        await settle { voice.preview == "Apple preview" }
        f.clock += 2
        f.engine.recording = .init(clips: [.init(wav: Data([1]), appleText: "Apple preview")], appleText: "Apple preview")
        voice.finalize()
        await settle { !voice.active }
        XCTAssertEqual(f.core.promptText, "Final Whisper transcript")
        XCTAssertTrue(f.sent.isEmpty)
    }

    func testSuspensionFinalizesAndTeardownRejectsLateDictation() async {
        let f = ReplyFixture()
        defer { f.teardown() }
        await f.live()
        await f.voice.begin(locked: true)
        f.clock += 2
        f.engine.recording = .init(clips: [], appleText: "Retained on suspension")
        f.model.visibilityChanged(visible: true, active: false)
        await settle { !f.voice.active }
        XCTAssertEqual(f.core.promptText, "Retained on suspension")
        XCTAssertTrue(f.sent.isEmpty)
        await f.voice.begin()
        f.model.teardown()
        f.engine.emit(.checkpoint("Late text"))
        XCTAssertEqual(f.core.promptText, "Retained on suspension")
    }

    func testSharedWhisperDiscoveryCoalescesCachesRetriesAndInvalidates() async throws {
        let gate = StatusGate()
        let status = IOSWhisperStatus(read: { try await gate.read() })
        let a = Task { try await status.value() }, b = Task { try await status.value() }
        await settle { gate.pending != nil }
        XCTAssertEqual(gate.reads, 1)
        gate.release(true)
        let first = try await a.value, second = try await b.value
        XCTAssertTrue(first && second)
        let cached = try await status.value()
        XCTAssertTrue(cached)
        XCTAssertEqual(gate.reads, 1)
        status.teardown()
        do { _ = try await status.value(); XCTFail("Torn-down activation") } catch {}
        let retry = IOSWhisperStatus(read: { try await gate.read() })
        let failure = Task { try await retry.value() }
        await settle { gate.pending != nil }
        gate.fail()
        do { _ = try await failure.value; XCTFail("Expected failure") } catch {}
        let next = Task { try await retry.value() }
        await settle { gate.pending != nil }
        gate.release(false)
        let unavailable = try await next.value
        XCTAssertFalse(unavailable)
        XCTAssertEqual(gate.reads, 3)
        retry.teardown()
    }

    func testActionBarResumeWithUnchangedIdleStatusReattachesAndDefersOffscreen() async {
        for offscreen in [false, true] {
            let f = ReplyFixture()
            defer { f.teardown() }
            await f.end(.gone)
            f.record.status = .init(known: .idle)
            f.model.serverSessionChanged(f.record.status)
            if offscreen {
                f.model.rendererUnmounted()
                f.model.visibilityChanged(visible: false, active: false)
            }
            await f.state.execute(.resume)
            XCTAssertEqual(f.record.status.known, .idle)
            XCTAssertNil(f.state.error)
            if offscreen {
                XCTAssertEqual(f.pty.takeovers, 0)
                f.model.visibilityChanged(visible: true, active: true)
                f.model.rendererMounted(cols: 48, rows: 24)
                XCTAssertEqual(f.attachments.count, 2)
            } else { XCTAssertEqual(f.pty.takeovers, 1) }
            f.model.resumeSucceeded()
            f.model.serverSessionChanged(.init(known: .running))
            XCTAssertEqual(f.attachments.count, offscreen ? 2 : 1)
            XCTAssertEqual(f.pty.takeovers, offscreen ? 0 : 1)
        }
    }

    func testRecordingLeaseFinalizesTerminalBeforeComposerAndRejectsFormerOwnerCancel() async {
        let lease = IOSRecordingLease()
        let terminalCapture = FakeDictationEngine(), composerCapture = FakeDictationEngine()
        let terminalEngine = IOSLeasedDictationEngine(engine: terminalCapture, lease: lease)
        let composerEngine = IOSLeasedDictationEngine(engine: composerCapture, lease: lease)
        let finalizer = ReplyFinalizer()
        var terminalText = "Draft", composerText = "", clock: TimeInterval = 100
        let terminal = DictationController(engine: terminalEngine, finalizer: finalizer,
            now: { Date(timeIntervalSince1970: clock) }, getText: { terminalText }, setText: { terminalText = $0 })
        let composer = DictationController(engine: composerEngine,
            now: { Date(timeIntervalSince1970: clock) }, getText: { composerText }, setText: { composerText = $0 })
        terminalEngine.voice = terminal; composerEngine.voice = composer
        defer { terminal.teardown(); composer.teardown(); finalizer.release() }
        await terminal.begin(locked: true)
        clock += 2
        terminalCapture.recording = .init(clips: [], appleText: "Previous capture")
        await composer.begin(locked: true)
        XCTAssertEqual(terminal.state, .finalizing)
        XCTAssertEqual(composer.state, .locked)
        XCTAssertFalse(lease.owns(terminalEngine))
        XCTAssertTrue(lease.owns(composerEngine))
        await terminalEngine.cancel()
        XCTAssertFalse(composerCapture.cancelled)
        await settle { finalizer.pending != nil }
        finalizer.release()
        await settle { !terminal.active }
        XCTAssertEqual(terminalText, "Draft Final text")
        XCTAssertEqual(composerText, "")
        clock += 2; composerCapture.recording = .init(clips: [], appleText: "Composer capture")
        await terminal.begin()
        await settle { !composer.active }
        XCTAssertEqual(composerText, "Composer capture")
        XCTAssertEqual(terminal.state, .recording)
    }

    func testPendingHoldCancellationAndEligibilityRecheckPreventSuspendedCapture() async {
        for cause in 0..<3 {
            let f = ReplyFixture()
            defer { f.teardown() }
            await f.live()
            let hold = IOSDictationHold(), delay = HoldDelayGate()
            hold.changed(voice: f.voice, translation: .zero, eligible: { f.model.canRecordReply },
                delay: { await delay.wait() })
            await settle { delay.pending != nil }
            if cause == 0 { f.model.visibilityChanged(visible: true, active: false) }
            else { await f.end(.gone) }
            // Third case deliberately omits cancellation to exercise the final eligibility fence.
            if cause != 2 { hold.cancel(); XCTAssertFalse(hold.holding) }
            delay.release()
            await settle { hold.pendingStarts == 0 }
            hold.ended(voice: f.voice, eligible: f.model.canRecordReply)
            XCTAssertEqual(f.voice.state, .idle)
            XCTAssertFalse(f.model.canRecordReply)
        }
    }

    func testTerminalMicHeldGrowthRespectsReduceMotionAndRendersFilledCircle() throws {
        XCTAssertEqual(IOSTerminalMicStyle.diameter, 44)
        XCTAssertEqual(IOSTerminalMicStyle.scale(held: false, reduceMotion: false), 1)
        XCTAssertGreaterThan(IOSTerminalMicStyle.scale(held: true, reduceMotion: false), 1)
        XCTAssertEqual(IOSTerminalMicStyle.scale(held: true, reduceMotion: true), 1)
        let f = ReplyFixture()
        defer { f.teardown() }
        let renderer = ImageRenderer(content: HoldToTalkButton(voice: f.voice, compact: true, rendersStaticFixture: true)
            .background(ComposePalette.bg))
        renderer.scale = 2
        let image = try XCTUnwrap(renderer.uiImage)
        XCTAssertEqual(image.size.width, 44)
        // Interior below the glyph must be filled amber, rather than the old dark outline.
        let sample = try pixel(image, x: 44, y: 70)
        XCTAssertGreaterThan(sample.0, 180)
        XCTAssertGreaterThan(sample.1, 100)
        XCTAssertLessThan(sample.2, 100)
    }

    func testProductionPaletteRendersWholeKeycapsAtDefaultAndLargeText() async throws {
        let f = ReplyFixture()
        defer { f.teardown() }
        await f.live()
        let directory = URL(fileURLWithPath: "/private/tmp/claude-501/-Users-kai-osthoff-githubrepos-shepherd/36c6a6cb-46a0-4781-99da-a39e745b0a43/scratchpad/ios-reply")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        for (name, size, pageIndex) in [("default", DynamicTypeSize.large, 0), ("large", .accessibility3, 0), ("large-tab", .accessibility3, 2)] {
            let image = try await renderHostedFixture(IOSTerminalInputBar(model: f.model)
                .frame(width: 390).environment(\.dynamicTypeSize, size), width: 390, palettePage: pageIndex)
            try XCTUnwrap(image.pngData()).write(to: directory.appendingPathComponent("terminal-palette-\(name).png"))
            // At four pixels below the top border no glyph can be mistaken for a cap.
            // Every left edge must have a full-width right edge, including the last
            // visible scrolling key. A sliver produces an unmatched/narrow pair.
            let borders = try (0..<780).filter { x in
                let p = try pixel(image, x: x, y: 4)
                return p.0 > 20 && p.0 < 40 && p.1 > 28 && p.1 < 48
            }
            var edges: [Int] = []
            for x in borders where edges.last.map({ x - $0 > 2 }) ?? true { edges.append(x) }
            XCTAssertEqual(edges.count, name == "default" ? 14 : 8)
            let capWidth = try XCTUnwrap(edges.dropFirst().first) - (edges.first ?? 0)
            for index in stride(from: 0, to: edges.count - 1, by: 2) {
                XCTAssertEqual(edges[index + 1] - edges[index], capWidth, accuracy: 2)
            }
            let top = try pixel(image, x: 30, y: 0)
            XCTAssertGreaterThan(top.1, 28, "The entire cap, including its top border, must render")
            let width = CGFloat(capWidth) / 2
            let page = IOSTerminalKeyPage(available: 390 - 20 - width * 2 - 12, keyWidth: width)
            XCTAssertLessThanOrEqual(page.width, 390 - 20 - width * 2 - 12)
        }
    }

    /// ImageRenderer omits UIKit-backed ScrollView content. Rasterize the actual
    /// hosted production view first, then use ImageRenderer for the fixture PNG.
    /// This is a unit-test window on the shared runner, never a simulator screenshot.
    private func renderHostedFixture<V: View>(_ content: V, width: CGFloat, height: CGFloat? = nil, palettePage: Int = 0) async throws -> UIImage {
        let measuring = UIHostingController(rootView: content)
        let fitted = measuring.sizeThatFits(in: CGSize(width: width, height: height ?? 1000))
        let size = CGSize(width: width, height: height ?? fitted.height)
        let host = UIHostingController(rootView: content.frame(width: width, height: size.height, alignment: .top).ignoresSafeArea(.container))
        host.safeAreaRegions = []
        let window = UIWindow(frame: CGRect(origin: .zero, size: size))
        window.rootViewController = host
        window.isHidden = false
        host.view.frame = window.bounds
        defer { window.isHidden = true; window.rootViewController = nil }
        await settle {
            host.view.setNeedsLayout(); host.view.layoutIfNeeded()
            func ready(_ view: UIView) -> Bool {
                if let scroll = view as? UIScrollView { return scroll.contentSize.width > scroll.bounds.width && scroll.bounds.width > 0 }
                return view.subviews.contains(where: ready)
            }
            return ready(host.view)
        }
        if palettePage > 0 {
            func scrollView(_ view: UIView) -> UIScrollView? {
                if let scroll = view as? UIScrollView { return scroll }
                return view.subviews.compactMap { scrollView($0) }.first
            }
            let scroll = try XCTUnwrap(scrollView(host.view))
            scroll.setContentOffset(CGPoint(x: scroll.bounds.width * CGFloat(palettePage), y: 0), animated: false)
            host.view.layoutIfNeeded()
        }
        // UIKit fills its backing surfaces only after the hosted scroll layout.
        let format = UIGraphicsImageRendererFormat(); format.scale = 2
        let hosted = UIGraphicsImageRenderer(size: size, format: format).image { _ in
            host.view.drawHierarchy(in: host.view.bounds, afterScreenUpdates: true)
        }
        let renderer = ImageRenderer(content: Image(uiImage: hosted).resizable().frame(width: size.width, height: size.height))
        renderer.scale = 2
        return try XCTUnwrap(renderer.uiImage)
    }

    private func pixel(_ image: UIImage, x: Int, y: Int) throws -> (UInt8, UInt8, UInt8) {
        let cg = try XCTUnwrap(image.cgImage)
        var bytes = [UInt8](repeating: 0, count: cg.width * cg.height * 4)
        let context = try XCTUnwrap(CGContext(data: &bytes, width: cg.width, height: cg.height,
            bitsPerComponent: 8, bytesPerRow: cg.width * 4, space: CGColorSpaceCreateDeviceRGB(),
            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue))
        context.draw(cg, in: CGRect(x: 0, y: 0, width: cg.width, height: cg.height))
        let offset = (y * cg.width + x) * 4
        return (bytes[offset], bytes[offset + 1], bytes[offset + 2])
    }

    func testRenderTerminalReplyStates() async throws {
        let directory = URL(fileURLWithPath: "/private/tmp/claude-501/-Users-kai-osthoff-githubrepos-shepherd/36c6a6cb-46a0-4781-99da-a39e745b0a43/scratchpad/ios-reply")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        for name in ["ended-resume", "idle", "recording", "locked", "transcript", "finalizing", "sending", "error", "large-type"] {
            let f = ReplyFixture()
            defer { f.teardown() }
            if name == "finalizing" { f.finalizer = ReplyFinalizer() }
            await f.live()
            if name == "ended-resume" { await f.end(.gone) }
            if name == "transcript" { f.core.promptText = "Prüfe die Tests und ergänze die deutsche Beschriftung." }
            if name == "recording" || name == "locked" {
                await f.voice.begin(locked: name == "locked")
                f.engine.emit(.preview("Prüfe die Tests und ergänze die deutsche Beschriftung…"))
                f.engine.emit(.level(0.8))
                await settle { !f.voice.preview.isEmpty && f.voice.level > 0 }
                f.clock += 12; f.voice.tick()
            }
            if name == "finalizing" {
                await f.voice.begin()
                f.engine.recording = .init(clips: [], appleText: "Prüfe die Tests…")
                f.clock += 2
                f.voice.finalize()
                await settle { (f.finalizer as? ReplyFinalizer)?.pending != nil }
            }
            var sending: Task<Bool, Never>?
            if name == "sending" || name == "error" {
                f.core.promptText = "Prüfe die Tests und ergänze die deutsche Beschriftung."
                if name == "sending" {
                    f.holdReply = true
                    sending = Task { await f.model.submitReply() }
                    await settle { f.model.replying }
                } else {
                    f.replyError = ShepherdError.notFound
                    _ = await f.model.submitReply()
                }
            }
            let output = VStack(alignment: .leading, spacing: 12) {
                Text(verbatim: "$ shepherd session attach TASK-01").foregroundStyle(IOSTerminalStyle.muted)
                Text(verbatim: "⏺ Checking the iOS terminal…\n\n  Shared session actions\n  Apple live preview + Whisper final\n\n⏺ Ready for your reply")
                Spacer()
            }.font(.system(.caption, design: .monospaced)).padding(12)
            let content = IOSTerminalPane(model: f.model, allowsInput: true, surface: output,
                fontSize: .constant(12), rendersStaticFixture: true)
                .frame(width: 390, height: 760)
                .background(IOSTerminalStyle.background).foregroundStyle(IOSTerminalStyle.ink)
                .tint(IOSTerminalStyle.amber).preferredColorScheme(.dark)
                .environment(\.dynamicTypeSize, name == "large-type" ? .accessibility3 : .large)
            let stateBeforeRendering = f.voice.state
            let image = try await renderHostedFixture(content, width: 390, height: 760)
            try XCTUnwrap(image.pngData()).write(to: directory.appendingPathComponent("terminal-\(name).png"))
            XCTAssertEqual(f.voice.state, stateBeforeRendering, "Rendering must preserve the fixture recording state")
            f.release()
            if let sending { _ = await sending.value }
        }
    }

    private func settle(_ condition: () -> Bool) async {
        let deadline = ContinuousClock.now + .seconds(10)
        while !condition(), ContinuousClock.now < deadline { await Task.yield() }
        XCTAssertTrue(condition())
    }
}

@MainActor
private final class ReplyPTY: PTYAttaching {
    let output: AsyncStream<Data> = AsyncStream { _ in }
    let lifecycle: AsyncStream<PTYConnection.LifecycleEvent>
    private let sink: AsyncStream<PTYConnection.LifecycleEvent>.Continuation
    var starts = 0, takeovers = 0
    init() { (lifecycle, sink) = AsyncStream.makeStream() }
    func start() { starts += 1 }
    func stop() {}
    func takeOver() { takeovers += 1 }
    func send(_ bytes: Data) {}
    func resize(cols: Int, rows: Int) {}
    func emit(_ event: PTYConnection.LifecycleEvent) { sink.yield(event) }
}

@MainActor
private final class ReplyFixture {
    var record = PreviewData.session(name: "Terminal reply")
    var uploads: AttachmentModel?
    var writable = true, holdResume = false, holdReply = false
    var resumes = 0
    var clock: TimeInterval = 100
    var resumeError: ShepherdError?, replyError: ShepherdError?
    var pending: CheckedContinuation<Void, Never>?
    var sent: [String] = []
    var finalizer: (any DictationFinalizer)?
    var pty = ReplyPTY()
    var attachments: [ReplyPTY] = []
    let engine = FakeDictationEngine()
    let merge = MergeModel(reads: .init(snapshot: { MergeSnapshot() }))
    let rules = ActionsModel(reads: .init(recaps: { [:] }), now: { 1 })
    lazy var core = TerminalSessionModel(sessionID: record.id, reply: { _ in }, makeAttachment: { _, _ in
        if self.pty.starts > 0 { self.pty = ReplyPTY() }
        self.attachments.append(self.pty)
        return self.pty
    })
    lazy var voice = DictationController(engine: engine, finalizer: finalizer, locale: "de-DE", now: { Date(timeIntervalSince1970: self.clock) },
        getText: { self.core.promptText }, setText: { self.core.promptText = $0 })
    lazy var state: IOSSessionActionState = IOSSessionActionState(operations: .init(
        stop: { _ in throw ShepherdError.notFound },
        resume: { _ in try await self.resumeSession() }, ready: { _, _ in throw ShepherdError.notFound }, rename: { _, _ in throw ShepherdError.notFound },
        amend: { _, _, _ in throw ShepherdError.notFound }, relaunch: { _, _ in throw ShepherdError.notFound },
        recap: { _ in throw ShepherdError.notFound }, git: { _ in throw ShepherdError.notFound },
        merge: { _, _, _, _ in throw ShepherdError.notFound }), merge: merge,
        session: { self.record }, actions: { self.rules.actions(for: $0) },
        canWrite: { self.writable }, isSelected: { true }, canSelectReplacement: { false },
        resumeSucceeded: { [weak self] _ in self?.model.resumeSucceeded() }, selectReplacement: { _, _ in })
    lazy var model: IOSTerminalPresentation = IOSTerminalPresentation(session: core, attachments: uploads, actions: { self.state }, reply: { text in
        try await self.send(text)
    })
    init() { record.status = .init(known: .done) }
    func resumeSession() async throws {
        resumes += 1
        if holdResume { await withCheckedContinuation { pending = $0 } }
        if let resumeError { throw resumeError }
    }
    func send(_ text: String) async throws {
        sent.append(text)
        if holdReply { await withCheckedContinuation { pending = $0 } }
        if let replyError { throw replyError }
    }
    func release() { holdResume = false; holdReply = false; pending?.resume(); pending = nil }
    func live() async {
        model.installVoice(voice)
        model.visibilityChanged(visible: true, active: true)
        model.rendererMounted(cols: 48, rows: 24)
        pty.emit(.attached)
        await wait { self.core.phase == .live }
    }
    func end(_ closure: PTYConnection.Closure) async {
        if !model.isAttached { await live() }
        pty.emit(.closed(closure))
        await wait { self.core.phase == .ended(closure) }
    }
    private func wait(_ condition: () -> Bool) async {
        let deadline = ContinuousClock.now + .seconds(10)
        while !condition(), ContinuousClock.now < deadline { await Task.yield() }
        XCTAssertTrue(condition())
    }
    func teardown() { release(); model.teardown(); (finalizer as? ReplyFinalizer)?.release(); state.invalidate(); merge.teardown(); rules.teardown() }
}

@MainActor
private final class ReplyFinalizer: DictationFinalizer {
    var pending: CheckedContinuation<DictationFinalization, Never>?
    func finalize(_ recording: DictationRecording, locale: String) async -> DictationFinalization {
        await withCheckedContinuation { pending = $0 }
    }
    func release() { pending?.resume(returning: .init(text: "Final text")); pending = nil }
}

@MainActor
private final class StatusGate {
    var reads = 0
    var pending: CheckedContinuation<Bool, any Error>?
    func read() async throws -> Bool {
        reads += 1
        return try await withCheckedThrowingContinuation { pending = $0 }
    }
    func release(_ value: Bool) { pending?.resume(returning: value); pending = nil }
    func fail() { pending?.resume(throwing: ShepherdError.notFound); pending = nil }
}

@MainActor
private final class HoldDelayGate {
    var pending: CheckedContinuation<Void, Never>?
    func wait() async { await withCheckedContinuation { pending = $0 } }
    func release() { pending?.resume(); pending = nil }
}
