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
    /// AskUserQuestion forms (#3165) add an "Other…" choice with its own text to every
    /// single/multi question. Single: `single[id] == otherIndex`. Multi: `otherChecked[id]`.
    /// Plan-gate forms never allow it, so they are unchanged.
    public let allowsOther: Bool
    public static let otherIndex = -1
    public var otherChecked: [String: Bool] = [:]
    public var otherText: [String: String] = [:]
    public private(set) var submitting = false
    private(set) var submitted = false
    private(set) var delivered = true
    public private(set) var errored = false
    public var confirming = false
    private let writer: QuestionFormWriter?
    #if os(iOS)
    private var presentationGeneration = 0
    private var recordedOutsidePresentation = false

    /// Keep drafts and request locks, but reject feedback for a departed presentation.
    public func invalidatePresentationForIOS() {
        presentationGeneration &+= 1
        cancelConfirmation()
    }
    #endif
    private var pending: (sessionID: String, answers: [RawAnswer])?

    public init(block: VisualBlockQuestionForm, answerContext: QuestionAnswerContext?, writer: QuestionFormWriter?,
                allowsOther: Bool = false) {
        self.block = block
        self.answerContext = answerContext
        self.writer = writer
        self.allowsOther = allowsOther
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
    #if os(iOS)
    var locked: Bool { submitting || submitted || recordedOutsidePresentation || answerContext?.locked == true }
    #else
    var locked: Bool { submitting || submitted || answerContext?.locked == true }
    #endif
    public var inputsDisabled: Bool { !interactive || locked }
    public var canSubmit: Bool { writer != nil && answersComplete }

    /// Every question answered, writer aside: the AskUserQuestion sheet submits without one.
    public var answersComplete: Bool {
        guard interactive, !locked else { return false }
        return block.questions.allSatisfy { question in
            switch question.kind.known {
            case .single: (single[question.id] ?? nil) != nil && otherComplete(question)
            // Empty is the real answer "none" — except with Other, where "none" goes through Other.
            case .multi: !allowsOther || (otherComplete(question) && (!(multi[question.id] ?? []).isEmpty || otherOn(question)))
            case .freeform: !(freeform[question.id] ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            case nil: false // A future kind must never send an invented answer.
            }
        }
    }

    public func otherOn(_ question: PlanQuestion) -> Bool {
        guard allowsOther else { return false }
        return question.kind.known == .single
            ? (single[question.id] ?? nil) == Self.otherIndex
            : otherChecked[question.id] == true
    }

    private func trimmedOther(_ id: String) -> String {
        (otherText[id] ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private func otherComplete(_ question: PlanQuestion) -> Bool {
        !otherOn(question) || !trimmedOther(question.id).isEmpty
    }

    public func buildAnswers() -> [RawAnswer] {
        block.questions.map { question in
            let other = otherOn(question) ? trimmedOther(question.id) : nil
            switch question.kind.known {
            case .single:
                let index = single[question.id] ?? nil
                return RawAnswer(blockId: block.id, questionId: question.id,
                          optionIndices: index.flatMap { $0 == Self.otherIndex ? nil : [$0] } ?? [], text: other)
            case .multi:
                return RawAnswer(blockId: block.id, questionId: question.id,
                          optionIndices: (multi[question.id] ?? []).sorted(), text: other)
            case .freeform, nil:
                return RawAnswer(blockId: block.id, questionId: question.id, text: freeform[question.id] ?? "")
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
        #if os(iOS)
        let presentation = presentationGeneration
        #endif
        submitting = true
        errored = false
        defer { submitting = false }
        do {
            let result = try await writer.send(consent.sessionID, consent.answers)
            #if os(iOS)
            guard presentation == presentationGeneration, writer.isCurrent() else {
                // The server recorded these answers even if the view left. Never redeliver.
                recordedOutsidePresentation = true
                return
            }
            #endif
            guard writer.isCurrent() else { return }
            delivered = result.delivered
            submitted = true
        } catch {
            #if os(iOS)
            guard presentation == presentationGeneration else { return }
            #endif
            guard writer.isCurrent() else { return }
            errored = true
        }
    }
}
