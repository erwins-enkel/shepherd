import ShepherdAppCore
import ShepherdKit
import SwiftUI

/// Mounted by the compose sheet next to attachments; no session exists during this round.
struct ShapeRoundView: View {
    @Bindable var model: ComposeModel

    var body: some View {
        #if os(macOS)
        VStack(alignment: .leading, spacing: 12) {
            if model.shapingOffered {
                Button {
                    Task { await model.startShaping() }
                } label: {
                    Label(L.t("newtask_shape_label"), systemImage: "sparkles")
                }
                .disabled(model.shapeBlocker != nil)
                .accessibilityLabel(L.t("newtask_shape_aria"))
                .accessibilityIdentifier("compose-shape")
                .help(L.t("newtask_shape_hint"))
            }
            if model.shaping.visible {
                ShapeRoundBody(model: model.shaping) { answers in
                    await model.useBrief(answers)
                }
            }
        }
        .onDisappear { model.shaping.discard() }
        #endif
    }
}

private struct ShapeRoundBody: View {
    @Bindable var model: ShapeRoundModel
    let useBrief: ([RawAnswer]) async -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Text(L.t("shape_heading")).font(.headline)
                if let round = model.round {
                    Text(L.t("shape_questions_count", String(round.block.questions.count)))
                        .font(.caption).foregroundStyle(.secondary)
                }
                Spacer()
                Button(L.t("shape_discard")) { model.discard() }
                    .accessibilityIdentifier("compose-shape-discard")
            }
            if model.running {
                ProgressView { Text(L.t("shape_running")) }
                    .accessibilityIdentifier("compose-shape-running")
            }
            if let errorMessage = model.errorMessage {
                Text(verbatim: errorMessage).foregroundStyle(.red)
                    .accessibilityIdentifier("compose-shape-error")
            }
            if let round = model.round {
                section("shape_s_problem", lines: [round.draft.problem])
                section("shape_s_outcome", lines: [round.draft.outcome])
                section("shape_s_constraints", lines: round.draft.constraints)
                section("shape_s_nongoals", lines: round.draft.nonGoals)
                ForEach(Array(round.block.questions.enumerated()), id: \.offset) { _, question in
                    VStack(alignment: .leading, spacing: 6) {
                        Text(verbatim: question.prompt).font(.headline)
                        input(question).disabled(model.composing)
                    }
                }
                HStack {
                    Button(L.t("shape_use_brief")) {
                        let answers = model.answers
                        Task { await useBrief(answers) }
                    }
                    .disabled(!model.canUseBrief)
                    .accessibilityIdentifier("compose-shape-use-brief")
                    if model.composing { ProgressView().controlSize(.small) }
                }
            }
        }
        .padding(12)
        .background(.quaternary, in: RoundedRectangle(cornerRadius: 8))
        .accessibilityElement(children: .contain)
        .accessibilityLabel(L.t("shape_heading"))
        .accessibilityIdentifier("compose-shape-round")
    }

    @ViewBuilder private func section(_ key: StaticString, lines: [String]) -> some View {
        let visible = lines.filter { !$0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
        if !visible.isEmpty {
            VStack(alignment: .leading, spacing: 4) {
                Text(verbatim: L.t(key)).font(.caption).foregroundStyle(.secondary)
                ForEach(Array(visible.enumerated()), id: \.offset) { _, line in
                    Text(verbatim: line).textSelection(.enabled)
                }
            }
        }
    }

    @ViewBuilder private func input(_ question: PlanQuestion) -> some View {
        switch question.kind.known {
        case .single:
            Picker(selection: Binding<Int?>(get: { model.single[question.id] }, set: {
                model.single[question.id] = $0
            })) {
                ForEach(Array((question.options ?? []).enumerated()), id: \.offset) { index, option in
                    Text(verbatim: option).tag(Optional(index))
                }
            } label: { Text(verbatim: question.prompt) }
            .pickerStyle(.radioGroup).labelsHidden()
        case .multi:
            ForEach(Array((question.options ?? []).enumerated()), id: \.offset) { index, option in
                Toggle(isOn: Binding(get: { model.multi[question.id, default: []].contains(index) }, set: {
                    if $0 { model.multi[question.id, default: []].insert(index) }
                    else { model.multi[question.id, default: []].remove(index) }
                })) { Text(verbatim: option) }
                .toggleStyle(.checkbox)
            }
        case .freeform:
            TextField(text: Binding(get: { model.freeform[question.id, default: ""] }, set: {
                model.freeform[question.id] = $0
            }), axis: .vertical) { Text(verbatim: question.prompt) }
                .textFieldStyle(.roundedBorder)
                .focusedValue(\.composeEditingText, true)
        case nil:
            // A newer question kind is visible but never given an invented answer.
            EmptyView()
        }
    }
}
