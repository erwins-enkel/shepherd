import SwiftUI
import ShepherdAppCore
import ShepherdKit

struct IOSQuestionFormView: View {
    @Bindable var model: QuestionFormModel
    var answered = false
    // ImageRenderer cannot draw UIKit text inputs. Render their current values in fixtures.
    var fixture = false
    /// The AskUserQuestion it renders (#3166): headers and option descriptions. Its sheet
    /// submits directly through `onSubmit`, without the plan form's confirmation.
    var ask: PendingAsk? = nil
    var onSubmit: (() -> Void)? = nil

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            ForEach(Array(model.block.questions.enumerated()), id: \.offset) { _, question in
                VStack(alignment: .leading, spacing: 6) {
                    if let header = askQuestion(question)?.header, !header.isEmpty {
                        Text(verbatim: header.uppercased()).sessionFont(label: true)
                            .foregroundStyle(SessionListStyle.amber)
                    }
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
            } else if let onSubmit {
                Button(action: onSubmit) { Text(verbatim: L.t("ask_dialog_submit")) }
                    .buttonStyle(IOSPlanButtonStyle()).disabled(!model.answersComplete)
                    .accessibilityIdentifier("ask-submit")
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
        case .multi: L.t(model.interactive && !model.allowsOther ? "qform_kind_multi_optional" : "qform_kind_multi")
        case .freeform: L.t("qform_kind_freeform")
        case nil: kind.rawValue
        }
    }

    private func askQuestion(_ question: PlanQuestion) -> AskQuestion? {
        guard let ask, let index = Int(question.id), ask.questions.indices.contains(index) else { return nil }
        return ask.questions[index]
    }

    private func optionDescription(_ question: PlanQuestion, _ index: Int) -> String? {
        guard let options = askQuestion(question)?.options, options.indices.contains(index) else { return nil }
        let option = options[index]
        return option.description.isEmpty || option.description == option.label ? nil : option.description
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
                        VStack(alignment: .leading, spacing: 2) {
                            Text(verbatim: option)
                            if let description = optionDescription(question, index) {
                                Text(verbatim: description).sessionFont(label: true)
                                    .foregroundStyle(SessionListStyle.muted)
                            }
                        }.frame(maxWidth: .infinity, alignment: .leading)
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
            if model.allowsOther { other(question) }
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

    /// "Other…": the radio group's extra value for single, its own checkbox for multi.
    @ViewBuilder private func other(_ question: PlanQuestion) -> some View {
        let single = question.kind.known == .single
        let selected = model.otherOn(question)
        Button {
            if single { model.single[question.id] = .some(QuestionFormModel.otherIndex) }
            else { model.otherChecked[question.id] = !selected }
        } label: {
            HStack(alignment: .firstTextBaseline, spacing: 10) {
                Image(systemName: single
                    ? (selected ? "largecircle.fill.circle" : "circle")
                    : (selected ? "checkmark.square" : "square"))
                    .foregroundStyle(selected ? SessionListStyle.amber : SessionListStyle.muted)
                    .accessibilityHidden(true)
                Text(verbatim: L.t("qform_other")).frame(maxWidth: .infinity, alignment: .leading)
            }
            .padding(10).frame(minHeight: 44)
            .background(SessionListStyle.panel)
            .overlay { Rectangle().stroke(selected ? SessionListStyle.amber : SessionListStyle.line) }
        }
        .buttonStyle(.plain)
        .accessibilityLabel(Text(verbatim: question.prompt + ": " + L.t("qform_other")))
        .accessibilityAddTraits(selected ? .isSelected : [])
        .accessibilityIdentifier("question-other-\(model.block.id)-\(question.id)")
        if selected {
            if fixture {
                Text(verbatim: model.otherText[question.id, default: ""].isEmpty
                    ? L.t("qform_other_placeholder") : model.otherText[question.id, default: ""])
                    .foregroundStyle(SessionListStyle.muted).padding(12)
                    .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                    .overlay { Rectangle().stroke(SessionListStyle.brightLine) }
            } else {
                TextField(L.t("qform_other_placeholder"), text: Binding(
                    get: { model.otherText[question.id, default: ""] },
                    set: { model.otherText[question.id] = String($0.prefix(500)) }
                ), axis: .vertical)
                .lineLimit(1...4).padding(12).background(SessionListStyle.background)
                .overlay { Rectangle().stroke(SessionListStyle.brightLine) }
                .accessibilityLabel(Text(verbatim: question.prompt + ": " + L.t("qform_other")))
                .accessibilityIdentifier("question-other-text-\(model.block.id)-\(question.id)")
            }
        }
    }
}
