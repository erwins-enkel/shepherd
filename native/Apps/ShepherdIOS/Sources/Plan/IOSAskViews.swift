import SwiftUI
import ShepherdAppCore
import ShepherdKit

/// The agent's AskUserQuestion dialog as a native form (#3166). The server types the answer into
/// the real terminal, so the question stays answerable there too — whoever answers first wins.
struct IOSAskSheet: View {
    let ask: PendingAsk
    let model: QuestionFormModel
    let submit: () -> Void
    var fixture = false
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    Text(verbatim: L.t("ask_dialog_hint")).sessionFont(label: true)
                        .foregroundStyle(SessionListStyle.muted)
                    IOSQuestionFormView(model: model, fixture: fixture, ask: ask, onSubmit: submit)
                }.padding(16)
            }
            .background(SessionListStyle.background)
            .navigationTitle(L.t("ask_dialog_title"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(L.t("common_close")) { dismiss() }.accessibilityIdentifier("ask-close")
                }
            }
        }
        .tint(SessionListStyle.amber).preferredColorScheme(.dark)
        .presentationDetents([.large])
        .accessibilityIdentifier("ask-sheet")
    }
}

/// The strip above the terminal: reopens an open ask, then reports how its answer landed.
struct IOSAskStrip: View {
    let ask: PendingAsk?
    let status: AskAnswerFlow.Status?
    let open: (PendingAsk) -> Void
    let clear: (String) -> Void

    var body: some View {
        if let ask, !(status?.toolUseID == ask.toolUseId && status?.phase == .sending) {
            askRow(ask)
        } else if let status {
            statusRow(status)
        }
    }

    private func askRow(_ ask: PendingAsk) -> some View {
        HStack(spacing: 10) {
            Image(systemName: "questionmark.bubble").foregroundStyle(SessionListStyle.amber)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                Text(verbatim: L.t("ask_banner_title", String(ask.questions.count)))
                    .font(.system(.caption, design: .monospaced).weight(.semibold))
                if let first = ask.questions.first?.question {
                    Text(verbatim: first).font(.system(.caption2, design: .monospaced))
                        .foregroundStyle(SessionListStyle.muted).lineLimit(1)
                }
            }.frame(maxWidth: .infinity, alignment: .leading)
            Button(L.t("ask_banner_answer")) { open(ask) }
                .buttonStyle(IOSPlanButtonStyle())
                .accessibilityIdentifier("ask-strip-answer")
        }
        .padding(.horizontal, 12).padding(.vertical, 6)
        .background(IOSTerminalStyle.panel)
        .overlay(alignment: .bottom) { Rectangle().fill(IOSTerminalStyle.line).frame(height: 1) }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("ask-strip")
    }

    private func statusRow(_ status: AskAnswerFlow.Status) -> some View {
        HStack(spacing: 10) {
            if status.phase == .sending { ProgressView().controlSize(.small) }
            else {
                Image(systemName: status.phase.isWarning ? "exclamationmark.triangle" : "checkmark.circle")
                    .foregroundStyle(status.phase.isWarning ? SessionListStyle.amber : SessionListStyle.muted)
                    .accessibilityHidden(true)
            }
            Text(verbatim: status.phase.message).font(.system(.caption, design: .monospaced))
                .frame(maxWidth: .infinity, alignment: .leading)
            if status.phase != .sending {
                Button { clear(status.toolUseID) } label: { Image(systemName: "xmark").frame(width: 44, height: 44) }
                    .buttonStyle(.plain).foregroundStyle(SessionListStyle.muted)
                    .accessibilityLabel(L.t("common_close"))
            }
        }
        .padding(.horizontal, 12).frame(minHeight: 44)
        .background(IOSTerminalStyle.panel)
        .overlay(alignment: .bottom) { Rectangle().fill(IOSTerminalStyle.line).frame(height: 1) }
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("ask-status")
        // A confirmed delivery fades on its own; a warning waits for the operator.
        .task(id: status) {
            guard status.phase == .verified else { return }
            try? await Task.sleep(for: .seconds(4))
            if !Task.isCancelled { clear(status.toolUseID) }
        }
    }
}
