import Foundation
import Observation
import ShepherdKit
import SwiftUI

struct QuestionAnswerContext: Equatable {
    let sessionID: String
    var locked: Bool
}

/// The generated client is the only wire boundary. Tests supply a fake writer.
struct QuestionFormWriter: Sendable {
    var send: @MainActor @Sendable (String, [RawAnswer]) async throws -> AnswerPlanQuestionsResult

    var isCurrent: @MainActor @Sendable () -> Bool = { true }

    @MainActor
    static func live(session: Session, store: SessionStore, app: AppModel) -> Self {
        Self(send: { id, answers in
            try await store.client.answerPlanQuestions(sessionID: id, answers: answers)
        }, isCurrent: { [weak app] in
            guard let app else { return false }
            return ActionBarView.isCurrent(session: session, store: store, app: app)
        })
    }
}

@Observable @MainActor
final class QuestionFormModel {
    let block: VisualBlockQuestionForm
    var answerContext: QuestionAnswerContext? {
        didSet { if answerContext != oldValue { cancelConfirmation() } }
    }
    var single: [String: Int?] = [:]
    var multi: [String: Set<Int>] = [:]
    var freeform: [String: String] = [:]
    private(set) var submitting = false
    private(set) var submitted = false
    private(set) var delivered = true
    private(set) var errored = false
    var confirming = false
    private let writer: QuestionFormWriter?
    private var pending: (sessionID: String, answers: [RawAnswer])?

    init(block: VisualBlockQuestionForm, answerContext: QuestionAnswerContext?, writer: QuestionFormWriter?) {
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

    var interactive: Bool { answerContext != nil }
    var locked: Bool { submitting || submitted || answerContext?.locked == true }
    var inputsDisabled: Bool { !interactive || locked }
    var canSubmit: Bool {
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

    var confirmationMessage: String { L.t("qform_native_confirm_body", String(block.questions.count)) }
    var footerMessage: String? {
        guard submitted else { return nil }
        return delivered ? L.t("qform_sent") : L.t("qform_sent_undelivered")
    }
    var footerIsWarning: Bool { submitted && !delivered }

    func requestConfirmation() {
        guard canSubmit, let answerContext else { return }
        pending = (answerContext.sessionID, buildAnswers())
        confirming = true
    }

    func cancelConfirmation() {
        confirming = false
        pending = nil
    }

    func confirmSubmission() async {
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

/// A form owns its state per block and session. No context means a read-only recap/plan.
struct QuestionFormView: View {
    let block: VisualBlockQuestionForm
    var answerContext: QuestionAnswerContext?
    var writer: QuestionFormWriter?

    private struct Identity: Hashable {
        let blockID: String
        let sessionID: String?
    }

    var body: some View {
        QuestionFormInstance(block: block, answerContext: answerContext, writer: writer)
            .id(Identity(blockID: block.id, sessionID: answerContext?.sessionID))
    }
}

private struct QuestionFormInstance: View {
    let block: VisualBlockQuestionForm
    let answerContext: QuestionAnswerContext?
    let writer: QuestionFormWriter?
    @State private var model: QuestionFormModel

    init(block: VisualBlockQuestionForm, answerContext: QuestionAnswerContext?, writer: QuestionFormWriter?) {
        self.block = block
        self.answerContext = answerContext
        self.writer = writer
        _model = State(initialValue: QuestionFormModel(block: block, answerContext: answerContext, writer: writer))
    }

    var body: some View {
        QuestionFormBody(model: model)
            .onChange(of: answerContext) { _, context in model.answerContext = context }
            .onChange(of: block) { _, block in
                model.cancelConfirmation()
                model = QuestionFormModel(block: block, answerContext: answerContext, writer: writer)
            }
            .onDisappear { model.cancelConfirmation() }
    }
}

/// Shared by the live view and hosted rendering tests; controls read the same observable state.
struct QuestionFormBody: View {
    @Bindable var model: QuestionFormModel

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            ForEach(Array(model.block.questions.enumerated()), id: \.offset) { _, question in
                VStack(alignment: .leading, spacing: 6) {
                    Text(verbatim: question.prompt).font(.headline)
                    Text(verbatim: kindLabel(question.kind)).font(.caption).foregroundStyle(.secondary)
                    input(question).disabled(model.inputsDisabled)
                }
            }
            if model.interactive {
                if let message = model.footerMessage {
                    Label {
                        Text(verbatim: message)
                    } icon: {
                        Image(systemName: model.footerIsWarning ? "exclamationmark.triangle" : "checkmark.circle")
                    }
                    .foregroundStyle(model.footerIsWarning ? Color.orange : Color.secondary)
                    .accessibilityIdentifier(model.footerIsWarning ? "question-form-warning" : "question-form-sent")
                } else {
                    if model.errored {
                        Text(verbatim: L.t("qform_submit_error")).foregroundStyle(.red)
                            .accessibilityIdentifier("question-form-error")
                    }
                    Button(model.submitting ? L.t("qform_submitting") : L.t("qform_submit")) {
                        model.requestConfirmation()
                    }
                    .disabled(!model.canSubmit)
                    .accessibilityIdentifier("question-form-submit")
                }
            }
        }
        .confirmationDialog(L.t("qform_submit"), isPresented: $model.confirming, titleVisibility: .visible) {
            Button(L.t("qform_submit")) { Task { await model.confirmSubmission() } }
            Button(L.t("common_cancel"), role: .cancel) { model.cancelConfirmation() }
        } message: {
            Text(verbatim: model.confirmationMessage)
        }
    }

    private func kindLabel(_ kind: QuestionKind) -> String {
        switch kind.known {
        case .single: L.t("qform_kind_single")
        case .multi: model.interactive ? L.t("qform_kind_multi_optional") : L.t("qform_kind_multi")
        case .freeform: L.t("qform_kind_freeform")
        case nil: kind.rawValue
        }
    }

    @ViewBuilder
    private func input(_ question: PlanQuestion) -> some View {
        switch question.kind.known {
        case .single:
            Picker(selection: Binding<Int?>(
                get: { model.single[question.id] ?? nil },
                set: { model.single[question.id] = .some($0) }
            )) {
                ForEach(Array((question.options ?? []).enumerated()), id: \.offset) { index, option in
                    Text(verbatim: option).tag(Optional(index))
                }
            } label: { Text(verbatim: question.prompt) }
            .pickerStyle(.radioGroup)
            .labelsHidden()
        case .multi:
            ForEach(Array((question.options ?? []).enumerated()), id: \.offset) { index, option in
                Toggle(isOn: Binding(
                    get: { model.multi[question.id, default: []].contains(index) },
                    set: { selected in
                        if selected { model.multi[question.id, default: []].insert(index) }
                        else { model.multi[question.id, default: []].remove(index) }
                    }
                )) { Text(verbatim: option) }
                .toggleStyle(.checkbox)
            }
        case .freeform:
            TextField(L.t("qform_freeform_placeholder"), text: Binding(
                get: { model.freeform[question.id, default: ""] },
                set: { model.freeform[question.id] = $0 }
            ), axis: .vertical)
            .accessibilityLabel(Text(verbatim: question.prompt))
            .textFieldStyle(.roundedBorder)
        case nil: EmptyView()
        }
    }
}
