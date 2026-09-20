import AppKit
import ApplicationServices
import Foundation
import ShepherdKit
import SwiftUI
import Testing

@testable import Shepherd

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
        for _ in 0..<1_000 {
            if !fake.calls.isEmpty { break }
            await Task.yield()
        }
        #expect(fake.calls.count == 1)
        #expect(m.submitting && m.locked && m.inputsDisabled && !m.canSubmit)
        m.requestConfirmation()
        await m.confirmSubmission()
        #expect(fake.calls.count == 1)
        fake.resume()
        await sending.value
        #expect(m.submitted && !m.submitting)
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
        let path = try #require(Bundle.main.path(forResource: locale, ofType: "lproj"))
        let bundle = try #require(Bundle(path: path))
        let key = "qform_native_confirm_body"
        let format = bundle.localizedString(forKey: key, value: nil, table: nil)
        #expect(format != key)
        let message = String(format: format, "37")
        #expect(message.contains("37") && !message.contains("{"))
    }
}


extension QuestionFormTests {
    private struct Element {
        let id: String
        let text: String
        let role: NSAccessibility.Role?
        let enabled: Bool
    }

    private func rendered<V: View>(_ view: V) async -> [Element] {
        let host = NSHostingView(rootView: view)
        let window = NSWindow(contentRect: NSRect(x: -10000, y: -10000, width: 900, height: 1500),
                              styleMask: [.borderless], backing: .buffered, defer: false)
        window.contentView = host
        window.orderFront(nil)
        host.layoutSubtreeIfNeeded()
        defer { window.orderOut(nil); window.contentView = nil }
        let processID = ProcessInfo.processInfo.processIdentifier
        let result = await Task.detached {
            var windows: CFTypeRef?
            return AXUIElementCopyAttributeValue(AXUIElementCreateApplication(processID),
                                                kAXWindowsAttribute as CFString, &windows).rawValue
        }.value
        #expect(result == AXError.success.rawValue)
        func walk(_ object: Any, depth: Int = 0) -> [Element] {
            guard depth < 60 else { return [] }
            let element = object as AnyObject
            let value: Any? = element.accessibilityValue?()
            let current = Element(id: element.accessibilityIdentifier?() ?? "",
                text: [element.accessibilityLabel?(), value as? String].compactMap { $0 }.joined(separator: " "),
                role: element.accessibilityRole?(), enabled: element.isAccessibilityEnabled?() ?? false)
            return [current] + (element.accessibilityChildren?() ?? []).flatMap { walk($0, depth: depth + 1) }
        }
        return walk(host)
    }

    @Test func rendererShowsReadOnlyQuestionsAndOptionsWithoutASubmitButton() async {
        let elements = await rendered(VisualBlocksView(blocks: [.init(value13: block())]))
        let text = elements.map(\.text).joined(separator: " ")
        for expected in ["Choose one", "Choose any", "Explain", "A", "B", "C", L.t("qform_kind_multi")] {
            #expect(text.contains(expected))
        }
        #expect(!elements.contains { $0.id == "question-form-submit" })
        let controls = elements.filter { [.radioButton, .checkBox, .textField].contains($0.role) }
        #expect(!controls.isEmpty)
        #expect(controls.allSatisfy { !$0.enabled })
        #expect(!text.contains(L.t("vblock_native_not_rendered")))
    }

    @Test(arguments: [false, true])
    func renderedSuccessUsesWarningForUndeliveredAndNeverAnError(delivered: Bool) async {
        let fake = QuestionFormFakeClient()
        fake.delivered = delivered
        let m = model(fake)
        fill(m)
        let before = await rendered(QuestionFormBody(model: m))
        #expect(before.contains { $0.id == "question-form-submit" && $0.enabled })
        m.requestConfirmation()
        await m.confirmSubmission()
        let after = await rendered(QuestionFormBody(model: m))
        let expectedID = delivered ? "question-form-sent" : "question-form-warning"
        #expect(after.contains { $0.id == expectedID })
        #expect(!after.contains { $0.id == "question-form-error" || $0.id == "question-form-submit" })
        let text = after.map(\.text).joined(separator: " ")
        #expect(text.contains(delivered ? L.t("qform_sent") : L.t("qform_sent_undelivered")))
    }
}
