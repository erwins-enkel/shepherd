import Foundation
import Observation
import ShepherdKit
import SwiftUI

public struct QuestionAnswerContext: Equatable {
    public let sessionID: String
    var locked: Bool
}

/// The generated client is the only wire boundary. Tests supply a fake writer.
public struct QuestionFormWriter: Sendable {
    var send: @MainActor @Sendable (String, [RawAnswer]) async throws -> AnswerPlanQuestionsResult

    var isCurrent: @MainActor @Sendable () -> Bool = { true }

    @MainActor
    public static func live(session: Session, store: SessionStore, app: AppModel) -> Self {
        Self(send: { id, answers in
            try await store.client.answerPlanQuestions(sessionID: id, answers: answers)
        }, isCurrent: { [weak app] in
            guard let app else { return false }
            return CurrentSessionSelection.isCurrent(session: session, store: store, app: app)
        })
    }
}

@Observable @MainActor
public final class QuestionFormModel {
    public let block: VisualBlockQuestionForm
    public var answerContext: QuestionAnswerContext? {
        didSet { if answerContext != oldValue { cancelConfirmation() } }
    }
    public var single: [String: Int?] = [:]
    public var multi: [String: Set<Int>] = [:]
    public var freeform: [String: String] = [:]
    public private(set) var submitting = false
    private(set) var submitted = false
    private(set) var delivered = true
    public private(set) var errored = false
    public var confirming = false
    private let writer: QuestionFormWriter?
    private var pending: (sessionID: String, answers: [RawAnswer])?

    public init(block: VisualBlockQuestionForm, answerContext: QuestionAnswerContext?, writer: QuestionFormWriter?) {
        self.block = block
        self.answerContext = answerContext
        self.writer = writer
        for question in block.questions {
            switch question.kind.known {
            case .single: single[question.id] = .some(nil)
            case .multi: multi[question.id] = []
            case .freeform: freeform[question.id] = ""
            case nil: break
            }
        }
    }

    public var interactive: Bool { answerContext != nil }
    var locked: Bool { submitting || submitted || answerContext?.locked == true }
    public var inputsDisabled: Bool { !interactive || locked }
    public var canSubmit: Bool {
        guard interactive, !locked, writer != nil else { return false }
        return block.questions.allSatisfy { question in
            switch question.kind.known {
            case .single: (single[question.id] ?? nil) != nil
            case .multi: true // Empty is the real answer "none".
            case .freeform: !(freeform[question.id] ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            case nil: false // A future kind must never send an invented answer.
            }
        }
    }

    func buildAnswers() -> [RawAnswer] {
        block.questions.map { question in
            switch question.kind.known {
            case .single:
                RawAnswer(blockId: block.id, questionId: question.id,
                          optionIndices: (single[question.id] ?? nil).map { [$0] } ?? [])
            case .multi:
                RawAnswer(blockId: block.id, questionId: question.id,
                          optionIndices: (multi[question.id] ?? []).sorted())
            case .freeform, nil:
                RawAnswer(blockId: block.id, questionId: question.id, text: freeform[question.id] ?? "")
            }
        }
    }

    public var confirmationMessage: String { L.t("qform_native_confirm_body", String(block.questions.count)) }
    public var footerMessage: String? {
        guard submitted else { return nil }
        return delivered ? L.t("qform_sent") : L.t("qform_sent_undelivered")
    }
    public var footerIsWarning: Bool { submitted && !delivered }

    public func requestConfirmation() {
        guard canSubmit, let answerContext else { return }
        pending = (answerContext.sessionID, buildAnswers())
        confirming = true
    }

    public func cancelConfirmation() {
        confirming = false
        pending = nil
    }

    public func confirmSubmission() async {
        // SwiftUI dismisses its dialog before calling the action. The pending payload, not
        // isPresented, proves consent. Consume it before awaiting so it cannot be used twice.
        let consent = pending
        cancelConfirmation()
        guard let consent, canSubmit, let writer, writer.isCurrent(),
              consent.sessionID == answerContext?.sessionID, consent.answers == buildAnswers() else { return }
        submitting = true
        errored = false
        defer { submitting = false }
        do {
            let result = try await writer.send(consent.sessionID, consent.answers)
            guard writer.isCurrent() else { return }
            delivered = result.delivered
            submitted = true
        } catch {
            guard writer.isCurrent() else { return }
            errored = true
        }
    }
}
