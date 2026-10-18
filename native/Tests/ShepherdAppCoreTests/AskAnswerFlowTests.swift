import Foundation
import ShepherdKit
import Testing

@testable import ShepherdAppCore

extension CoreSeamTests {
@Suite(.serialized)
@MainActor
struct AskAnswerFlowTests {
    private func ask(_ id: String = "tu1") -> PendingAsk {
        .init(toolUseId: id, questions: [
            .init(question: "Pick one", header: "Mode", multiSelect: false,
                  options: [.init(label: "Fast", description: "Quick"), .init(label: "Safe", description: "Careful")]),
            .init(question: "Pick any", header: "Parts", multiSelect: true,
                  options: [.init(label: "A", description: ""), .init(label: "B", description: ""), .init(label: "C", description: "")]),
            .init(question: "Name it", header: "Name", multiSelect: false,
                  options: [.init(label: "Foo", description: ""), .init(label: "Bar", description: "")]),
        ])
    }

    private func writer(_ verdict: AskAnswerVerdict? = .verified,
                        calls: @escaping @MainActor ([RawAnswer]) -> Void = { _ in }) -> AskAnswerWriter {
        AskAnswerWriter(send: { _, _, answers in
            calls(answers)
            guard let verdict else { throw ShepherdError.conflict(code: nil, message: "ask_not_open") }
            return verdict
        })
    }

    @Test func mapsTheAskToAFormKeyedByToolUseIDAndQuestionIndex() {
        let block = AskForm.block(ask())
        #expect(block.id == "tu1")
        #expect(block.questions.map(\.id) == ["0", "1", "2"])
        #expect(block.questions.map(\.kind.known) == [.single, .multi, .single])
        #expect(block.questions[0].options == ["Fast", "Safe"])
    }

    @Test func opensOncePerToolUseIDAndClosesWhenTheAskLeaves() {
        let flow = AskAnswerFlow()
        flow.sync(ask: ask())
        #expect(flow.presentedID == "tu1")
        flow.dismiss()
        flow.sync(ask: ask())
        #expect(flow.presentedID == nil, "a re-emitted block must not reopen a closed sheet")
        flow.reopen(ask())
        #expect(flow.presentedID == "tu1")
        flow.sync(ask: nil)
        #expect(flow.presentedID == nil)
        flow.sync(ask: ask("tu2"))
        #expect(flow.presentedID == "tu2")
    }

    @Test func keepsTheDraftAcrossReopenButNotAcrossAsks() {
        let flow = AskAnswerFlow()
        flow.sync(ask: ask())
        let form = flow.form(sessionID: "s1", ask: ask())
        form.single["0"] = 1
        #expect(flow.form(sessionID: "s1", ask: ask()) === form)
        flow.sync(ask: ask("tu2"))
        #expect(flow.form(sessionID: "s1", ask: ask("tu2")) !== form)
    }

    @Test func answersThreeMixedQuestionsAndReportsTheVerdict() async {
        let flow = AskAnswerFlow()
        flow.sync(ask: ask())
        let form = flow.form(sessionID: "s1", ask: ask())
        form.single["0"] = 1
        form.multi["1"] = [2, 0]
        form.single["2"] = .some(QuestionFormModel.otherIndex)
        form.otherText["2"] = " Baz "
        var sent: [RawAnswer] = []
        await flow.submit(sessionID: "s1", ask: ask(), writer: writer(.mismatch) { sent = $0 })
        #expect(sent == [
            .init(blockId: "tu1", questionId: "0", optionIndices: [1]),
            .init(blockId: "tu1", questionId: "1", optionIndices: [0, 2]),
            .init(blockId: "tu1", questionId: "2", optionIndices: [], text: "Baz"),
        ])
        #expect(flow.presentedID == nil, "the sheet closes on submit")
        #expect(flow.status == .init(sessionID: "s1", toolUseID: "tu1", phase: .mismatch))
        #expect(flow.status?.phase.isWarning == true)
        flow.clearStatus(toolUseID: "tu1")
        #expect(flow.status == nil)
    }

    @Test func refusesAnIncompleteFormAndReportsAFailedWrite() async {
        let flow = AskAnswerFlow()
        flow.sync(ask: ask())
        let form = flow.form(sessionID: "s1", ask: ask())
        var calls = 0
        await flow.submit(sessionID: "s1", ask: ask(), writer: writer { _ in calls += 1 })
        #expect(calls == 0 && flow.status == nil && flow.presentedID == "tu1")
        form.single["0"] = 0
        form.multi["1"] = [1]
        form.single["2"] = 0
        await flow.submit(sessionID: "s1", ask: ask(), writer: writer(nil) { _ in calls += 1 })
        #expect(calls == 1 && flow.status?.phase == .failed)
        flow.sync(ask: ask("tu2"))
        #expect(flow.status == nil, "a new question clears the stale verdict")
    }
}
}
