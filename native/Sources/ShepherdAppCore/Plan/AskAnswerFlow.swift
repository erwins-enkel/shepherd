import Foundation
import Observation
import ShepherdKit

/// An AskUserQuestion dialog (#3165) as a question form, mirroring ui/src/lib/askForm.ts. The block
/// id is the tool_use id and each question id its index — what `answer-ask` resolves against.
public enum AskForm {
    public static func block(_ ask: PendingAsk) -> VisualBlockQuestionForm {
        .init(_type: .questionForm, id: ask.toolUseId, questions: ask.questions.enumerated().map { index, question in
            .init(id: String(index), prompt: question.question,
                  kind: .init(known: question.multiSelect ? .multi : .single),
                  options: question.options.map(\.label))
        })
    }
}

public enum AskAnswerVerdict: Equatable, Sendable {
    case verified, mismatch, unverified
}

/// The generated client is the only wire boundary. Tests supply a fake writer.
public struct AskAnswerWriter: Sendable {
    var send: @MainActor @Sendable (_ sessionID: String, _ toolUseID: String, [RawAnswer]) async throws -> AskAnswerVerdict

    public static func live(client: ShepherdClient) -> Self {
        Self(send: { id, toolUseID, answers in
            // An unknown future verdict reads as "unverified", like the web.
            switch try await client.answerAsk(sessionID: id, toolUseID: toolUseID, answers: answers).result.value1 {
            case .verified: .verified
            case .mismatch: .mismatch
            case .unverified, nil: .unverified
            }
        })
    }
}

/// One session view's AskUserQuestion state: the sheet opens once per tool_use id (closing it is a
/// decision a re-emitted block must not undo) and closes as soon as the ask leaves the block. The
/// answer outlives the sheet, so its progress and verdict live here.
@Observable @MainActor
public final class AskAnswerFlow {
    public enum Phase: Equatable, Sendable {
        case sending, verified, mismatch, unverified, failed
    }

    public struct Status: Equatable, Sendable {
        public let sessionID: String
        public let toolUseID: String
        public let phase: Phase

        public init(sessionID: String, toolUseID: String, phase: Phase) {
            self.sessionID = sessionID
            self.toolUseID = toolUseID
            self.phase = phase
        }
    }

    public private(set) var presentedID: String?
    public private(set) var status: Status?
    private var seen: Set<String> = []
    private var forms: [String: QuestionFormModel] = [:]

    public init() {}

    /// Call when the detail view appears and whenever the block's ask changes.
    public func sync(ask: PendingAsk?) {
        guard let id = ask?.toolUseId else {
            presentedID = nil
            forms = [:]
            return
        }
        forms = forms.filter { $0.key == id }
        if seen.insert(id).inserted {
            // A new question makes an older answer's verdict stale.
            if let status, status.toolUseID != id, status.phase != .sending { self.status = nil }
            presentedID = id
        } else if presentedID != id { presentedID = nil }
    }

    public func reopen(_ ask: PendingAsk) {
        guard !isSending(ask.toolUseId) else { return }
        presentedID = ask.toolUseId
    }

    public func dismiss() { presentedID = nil }

    /// Kept per tool_use id, so closing and reopening the sheet keeps the draft.
    public func form(sessionID: String, ask: PendingAsk) -> QuestionFormModel {
        if let form = forms[ask.toolUseId] { return form }
        let form = QuestionFormModel(block: AskForm.block(ask),
            answerContext: QuestionAnswerContext(sessionID: sessionID, locked: false), writer: nil, allowsOther: true)
        forms[ask.toolUseId] = form
        return form
    }

    public func isSending(_ toolUseID: String) -> Bool {
        status?.toolUseID == toolUseID && status?.phase == .sending
    }

    public func submit(sessionID: String, ask: PendingAsk, writer: AskAnswerWriter) async {
        let toolUseID = ask.toolUseId
        guard let form = forms[toolUseID], form.answersComplete, !isSending(toolUseID) else { return }
        let answers = form.buildAnswers()
        presentedID = nil
        status = Status(sessionID: sessionID, toolUseID: toolUseID, phase: .sending)
        let phase: Phase
        do {
            phase = switch try await writer.send(sessionID, toolUseID, answers) {
            case .verified: .verified
            case .mismatch: .mismatch
            case .unverified: .unverified
            }
        } catch { phase = .failed }
        // A newer answer owns the status line now.
        guard status?.toolUseID == toolUseID else { return }
        status = Status(sessionID: sessionID, toolUseID: toolUseID, phase: phase)
    }

    public func clearStatus(toolUseID: String) {
        if status?.toolUseID == toolUseID, status?.phase != .sending { status = nil }
    }
}

extension AskAnswerFlow.Phase {
    public var message: String {
        switch self {
        case .sending: L.t("ask_result_sending")
        case .verified: L.t("ask_result_verified")
        case .mismatch: L.t("ask_result_mismatch")
        case .unverified: L.t("ask_result_unverified")
        case .failed: L.t("ask_result_failed")
        }
    }

    /// Everything but a confirmed delivery asks the operator to check the terminal.
    public var isWarning: Bool { self != .sending && self != .verified }
}
