import AppKit
import ApplicationServices
import Foundation
import ShepherdKit
import SwiftUI
import Testing

@testable import Shepherd
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

extension MacSeamTests {
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

}
}

extension MacSeamTests.QuestionFormTests {
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
