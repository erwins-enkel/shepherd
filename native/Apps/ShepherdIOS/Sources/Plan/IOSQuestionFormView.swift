import SwiftUI
import ShepherdAppCore
import ShepherdKit

struct IOSQuestionFormView: View {
    @Bindable var model: QuestionFormModel
    var answered = false
    // ImageRenderer cannot draw UIKit text inputs. Render their current values in fixtures.
    var fixture = false

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            ForEach(Array(model.block.questions.enumerated()), id: \.offset) { _, question in
                VStack(alignment: .leading, spacing: 6) {
                    Text(verbatim: question.prompt).sessionFont(weight: .semibold)
                        .accessibilityAddTraits(.isHeader)
                    Text(verbatim: kindLabel(question.kind)).sessionFont(label: true)
                        .foregroundStyle(SessionListStyle.muted)
                    input(question).disabled(model.inputsDisabled)
                }
            }
            if let message = model.footerMessage {
                Label(message, systemImage: model.footerIsWarning ? "exclamationmark.triangle" : "checkmark.circle")
                    .foregroundStyle(model.footerIsWarning ? SessionListStyle.amber : SessionListStyle.muted)
                    .accessibilityIdentifier("question-form-sent")
            } else if answered {
                Label(L.t("qform_sent"), systemImage: "checkmark.circle").foregroundStyle(SessionListStyle.muted)
            } else if model.interactive {
                if model.errored {
                    Text(verbatim: L.t("qform_submit_error")).foregroundStyle(SessionListStyle.red)
                        .accessibilityIdentifier("question-form-error")
                }
                Button { model.requestConfirmation() } label: {
                    HStack {
                        if model.submitting {
                            if fixture { Image(systemName: "arrow.triangle.2.circlepath") }
                            else { ProgressView() }
                        }
                        Text(verbatim: model.submitting ? L.t("qform_submitting") : L.t("qform_submit"))
                    }
                }
                .buttonStyle(IOSPlanButtonStyle()).disabled(!model.canSubmit)
                .accessibilityIdentifier("question-form-submit-\(model.block.id)")
            }
        }
        .sessionFont().foregroundStyle(SessionListStyle.ink).tint(SessionListStyle.amber)
        .frame(maxWidth: .infinity, alignment: .leading)
        .confirmationDialog(L.t("qform_submit"), isPresented: $model.confirming, titleVisibility: .visible) {
            Button(L.t("qform_submit")) { Task { await model.confirmSubmission() } }
            Button(L.t("common_cancel"), role: .cancel) { model.cancelConfirmation() }
        } message: { Text(verbatim: model.confirmationMessage) }
    }

    private func kindLabel(_ kind: QuestionKind) -> String {
        switch kind.known {
        case .single: L.t("qform_kind_single")
        case .multi: L.t(model.interactive ? "qform_kind_multi_optional" : "qform_kind_multi")
        case .freeform: L.t("qform_kind_freeform")
        case nil: kind.rawValue
        }
    }

    @ViewBuilder private func input(_ question: PlanQuestion) -> some View {
        switch question.kind.known {
        case .single, .multi:
            ForEach(Array((question.options ?? []).enumerated()), id: \.offset) { index, option in
                let selected = question.kind.known == .single
                    ? (model.single[question.id] ?? nil) == index
                    : model.multi[question.id, default: []].contains(index)
                Button {
                    if question.kind.known == .single { model.single[question.id] = .some(index) }
                    else if selected { model.multi[question.id, default: []].remove(index) }
                    else { model.multi[question.id, default: []].insert(index) }
                } label: {
                    HStack(alignment: .firstTextBaseline, spacing: 10) {
                        Image(systemName: question.kind.known == .single
                            ? (selected ? "largecircle.fill.circle" : "circle")
                            : (selected ? "checkmark.square" : "square"))
                            .foregroundStyle(selected ? SessionListStyle.amber : SessionListStyle.muted)
                            .accessibilityHidden(true)
                        Text(verbatim: option).frame(maxWidth: .infinity, alignment: .leading)
                    }
                    .padding(10).frame(minHeight: 44)
                    .background(SessionListStyle.panel)
                    .overlay { Rectangle().stroke(selected ? SessionListStyle.amber : SessionListStyle.line) }
                }
                .buttonStyle(.plain)
                .accessibilityLabel(Text(verbatim: question.prompt + ": " + option))
                .accessibilityAddTraits(selected ? .isSelected : [])
                .accessibilityIdentifier("question-option-\(model.block.id)-\(question.id)-\(index)")
            }
        case .freeform:
            if fixture {
                Text(verbatim: model.freeform[question.id, default: ""].isEmpty
                    ? L.t("qform_freeform_placeholder") : model.freeform[question.id, default: ""])
                    .foregroundStyle(SessionListStyle.muted).padding(12)
                    .frame(maxWidth: .infinity, minHeight: 60, alignment: .topLeading)
                    .overlay { Rectangle().stroke(SessionListStyle.brightLine) }
            } else {
                TextField(L.t("qform_freeform_placeholder"), text: Binding(
                    get: { model.freeform[question.id, default: ""] },
                    set: { model.freeform[question.id] = $0 }
                ), axis: .vertical)
                .lineLimit(3...8).padding(12).background(SessionListStyle.background)
                .overlay { Rectangle().stroke(SessionListStyle.brightLine) }
                .accessibilityLabel(Text(verbatim: question.prompt))
                .accessibilityIdentifier("question-text-\(model.block.id)-\(question.id)")
            }
        case nil:
            Text(verbatim: question.kind.rawValue).foregroundStyle(SessionListStyle.muted)
        }
    }
}
