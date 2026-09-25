import Foundation
import ShepherdKit
import SwiftUI
import Testing

@testable import ShepherdAppCore

@MainActor
private final class QuestionFormFakeClient {
    var calls: [(String, [RawAnswer])] = []
    var delivered = true
    var fails = false
    var suspended = false
    private var continuation: CheckedContinuation<Void, Never>?

    var writer: QuestionFormWriter {
        QuestionFormWriter { [self] id, answers in
            calls.append((id, answers))
            if suspended { await withCheckedContinuation { continuation = $0 } }
            if fails { throw ShepherdError.notFound }
            return .init(ok: true, delivered: delivered)
        }
    }

    func resume() { continuation?.resume(); continuation = nil }
}

extension CoreSeamTests {
@Suite(.serialized)
@MainActor
struct QuestionFormTests {
    private let context = QuestionAnswerContext(sessionID: "s1", locked: false)

    private func block() -> VisualBlockQuestionForm {
        .init(_type: .questionForm, id: "block", questions: [
            .init(id: "single", prompt: "Choose one", kind: .init(known: .single), options: ["A", "B"]),
            .init(id: "multi", prompt: "Choose any", kind: .init(known: .multi), options: ["A", "B", "C"]),
            .init(id: "text", prompt: "Explain", kind: .init(known: .freeform)),
        ])
    }

    private func model(_ fake: QuestionFormFakeClient) -> QuestionFormModel {
        QuestionFormModel(block: block(), answerContext: context, writer: fake.writer)
    }

    private func fill(_ m: QuestionFormModel) {
        m.single["single"] = 1
        m.freeform["text"] = "  Keep this spacing.\n"
    }

    @Test func requiresEverySingleAndTrimmedFreeformButMultiIsOptional() {
        let m = model(QuestionFormFakeClient())
        #expect(!m.canSubmit)
        m.single["single"] = 0
        m.freeform["text"] = " \n\t "
        #expect(!m.canSubmit)
        m.freeform["text"] = "answer"
        #expect(m.canSubmit)
        m.single["single"] = .some(nil)
        #expect(!m.canSubmit)
        var two = block()
        two.questions.append(.init(id: "second", prompt: "Also explain", kind: .init(known: .freeform)))
        let other = QuestionFormModel(block: two, answerContext: context, writer: QuestionFormFakeClient().writer)
        fill(other)
        #expect(!other.canSubmit, "every freeform is required")
        other.freeform["second"] = "second answer"
        #expect(other.canSubmit)
        two.questions.append(.init(id: "secondSingle", prompt: "Also choose", kind: .init(known: .single)))
        let third = QuestionFormModel(block: two, answerContext: context, writer: QuestionFormFakeClient().writer)
        fill(third)
        third.freeform["second"] = "answer"
        #expect(!third.canSubmit, "every single is required")
        third.single["secondSingle"] = 0
        #expect(third.canSubmit)
    }

    @Test func buildsEveryAnswerWithWireIDsSortedOptionsAndUntrimmedText() {
        let m = model(QuestionFormFakeClient())
        #expect(m.buildAnswers() == [
            .init(blockId: "block", questionId: "single", optionIndices: []),
            .init(blockId: "block", questionId: "multi", optionIndices: []),
            .init(blockId: "block", questionId: "text", text: ""),
        ])
        fill(m)
        m.multi["multi"] = [2, 0, 1]
        #expect(m.buildAnswers() == [
            .init(blockId: "block", questionId: "single", optionIndices: [1]),
            .init(blockId: "block", questionId: "multi", optionIndices: [0, 1, 2]),
            .init(blockId: "block", questionId: "text", text: "  Keep this spacing.\n"),
        ])
    }

    @Test func noContextIsReadOnlyAndReviewLockBlocksConfirmation() async {
        let fake = QuestionFormFakeClient()
        let m = model(fake)
        fill(m)
        m.answerContext = nil
        #expect(!m.interactive && m.inputsDisabled && !m.canSubmit)
        m.requestConfirmation()
        await m.confirmSubmission()
        #expect(!m.confirming && fake.calls.isEmpty)
        m.answerContext = .init(sessionID: "s1", locked: true)
        #expect(m.locked && m.inputsDisabled && !m.canSubmit)
        m.requestConfirmation()
        await m.confirmSubmission()
        #expect(fake.calls.isEmpty)
    }

    @Test func onlyConfirmationCanWriteAndCancellationDoesNotSend() async {
        let fake = QuestionFormFakeClient()
        let m = model(fake)
        fill(m)
        await m.confirmSubmission()
        #expect(fake.calls.isEmpty)
        m.requestConfirmation()
        #expect(m.confirming && fake.calls.isEmpty)
        #expect(m.confirmationMessage == L.t("qform_native_confirm_body", "3"))
        m.cancelConfirmation()
        await m.confirmSubmission()
        #expect(fake.calls.isEmpty)
        m.requestConfirmation()
        await m.confirmSubmission()
        #expect(fake.calls.count == 1)
        #expect(fake.calls.first?.0 == "s1")
        #expect(fake.calls.first?.1 == m.buildAnswers())
        #expect(m.submitted && m.locked && !m.canSubmit)
        m.requestConfirmation()
        await m.confirmSubmission()
        #expect(fake.calls.count == 1)
    }

    @Test(arguments: [false, true])
    func recordedAnswersAreSuccessEvenWhenNotDelivered(delivered: Bool) async {
        let fake = QuestionFormFakeClient()
        fake.delivered = delivered
        let m = model(fake)
        fill(m)
        m.requestConfirmation()
        await m.confirmSubmission()
        #expect(m.submitted && !m.errored && !m.submitting)
        #expect(m.delivered == delivered)
        #expect(m.footerMessage == (delivered ? L.t("qform_sent") : L.t("qform_sent_undelivered")))
        #expect(m.footerIsWarning == !delivered)
    }

    @Test func writeInFlightLocksInputsAndRejectsDuplicateSubmission() async {
        let fake = QuestionFormFakeClient()
        fake.suspended = true
        let m = model(fake)
        fill(m)
        m.requestConfirmation()
        let sending = Task { await m.confirmSubmission() }
        let deadline = ContinuousClock.now + .seconds(10)
        while fake.calls.isEmpty, ContinuousClock.now < deadline { await Task.yield() }
        #expect(fake.calls.count == 1)
        #expect(m.submitting && m.locked && m.inputsDisabled && !m.canSubmit)
        m.requestConfirmation()
        await m.confirmSubmission()
        #expect(fake.calls.count == 1)
        fake.resume()
        await sending.value
        #expect(m.submitted && !m.submitting)
    }

    @Test(arguments: ["session", "store"], [false, true])
    func dropsCompletionAfterIdentityChanges(change: String, fails: Bool) async throws {
        let suite = "QuestionFormTests.\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suite))
        let app = AppModel(defaults: defaults, credentials: InMemoryCredentialStore(), notifications: CoreTestSupport.environment(defaults: defaults))
        defer {
            app.teardown()
            defaults.removePersistentDomain(forName: suite)
        }
        let profile = try app.addRemoteProfile(name: "fixture", address: "http://127.0.0.1:1")
        await app.activate(profile)
        let store = try #require(app.store)
        store.stop()
        app.selectedSessionID = "s1"
        let fake = QuestionFormFakeClient()
        fake.suspended = true
        fake.fails = fails
        fake.delivered = false
        var writer = QuestionFormWriter.live(session: PreviewData.session(id: "s1"), store: store, app: app)
        writer.send = fake.writer.send
        #expect(writer.isCurrent())
        let m = QuestionFormModel(block: block(), answerContext: context, writer: writer)
        fill(m)
        m.requestConfirmation()
        let sending = Task { await m.confirmSubmission() }
        let deadline = ContinuousClock.now + .seconds(10)
        while fake.calls.isEmpty, ContinuousClock.now < deadline { await Task.yield() }
        #expect(fake.calls.count == 1)
        if change == "session" {
            app.selectedSessionID = "s2"
        } else {
            await app.activate(profile)
            app.store?.stop()
            app.selectedSessionID = "s1" // Same id on another store must still be rejected.
        }
        #expect(!writer.isCurrent())
        fake.resume()
        await sending.value
        #expect(!m.submitted && !m.errored && m.delivered)
        #expect(!m.submitting && m.footerMessage == nil)
    }

    @Test func failedWriteKeepsAnswersAndRequiresFreshConfirmationToRetry() async {
        let fake = QuestionFormFakeClient()
        fake.fails = true
        let m = model(fake)
        fill(m)
        m.requestConfirmation()
        await m.confirmSubmission()
        #expect(m.errored && !m.submitted && !m.submitting && m.canSubmit)
        #expect(m.freeform["text"] == "  Keep this spacing.\n")
        fake.fails = false
        await m.confirmSubmission()
        #expect(fake.calls.count == 1)
        m.requestConfirmation()
        await m.confirmSubmission()
        #expect(fake.calls.count == 2 && m.submitted && !m.errored)
    }

    @Test(arguments: ["lock", "session", "readonly", "answers"])
    func confirmationCannotOutliveItsContextOrAnswers(change: String) async {
        let fake = QuestionFormFakeClient()
        let m = model(fake)
        fill(m)
        m.requestConfirmation()
        switch change {
        case "lock": m.answerContext = .init(sessionID: "s1", locked: true)
        case "session": m.answerContext = .init(sessionID: "s2", locked: false)
        case "readonly": m.answerContext = nil
        default: m.freeform["text"] = "changed after confirmation opened"
        }
        await m.confirmSubmission()
        #expect(fake.calls.isEmpty)
    }

    @Test func unknownQuestionKindCannotSendAnInventedAnswer() {
        let block = VisualBlockQuestionForm(_type: .questionForm, id: "future", questions: [
            .init(id: "q", prompt: "Future input", kind: .init(unknown: "future-kind"))
        ])
        let m = QuestionFormModel(block: block, answerContext: context, writer: QuestionFormFakeClient().writer)
        #expect(!m.canSubmit)
    }

    @Test(arguments: ["en", "de"])
    func confirmationCopyResolvesCountInBothLocales(locale: String) throws {
        let path = try #require(CoreResources.bundle.path(forResource: locale, ofType: "lproj"))
        let bundle = try #require(Bundle(path: path))
        let key = "qform_native_confirm_body"
        let format = bundle.localizedString(forKey: key, value: nil, table: nil)
        #expect(format != key)
        let message = String(format: format, "37")
        #expect(message.contains("37") && !message.contains("{"))
    }
}
}
