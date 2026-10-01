import ShepherdAppCore
import SwiftUI

struct IOSTerminalReplySheet: View {
    let model: IOSTerminalPresentation
    @Environment(\.dismiss) private var dismiss
    @FocusState private var focused: Bool

    var body: some View {
        @Bindable var session = model.session
        NavigationStack {
            VStack(alignment: .leading, spacing: 12) {
                Text(L.t("native_terminal_prompt_placeholder"))
                    .font(.system(.callout, design: .monospaced))
                    .foregroundStyle(IOSTerminalStyle.muted)
                TextEditor(text: $session.promptText)
                    .font(.system(.body, design: .monospaced))
                    .scrollContentBackground(.hidden)
                    .background(IOSTerminalStyle.background)
                    .overlay(Rectangle().stroke(IOSTerminalStyle.line))
                    .focused($focused)
                    .accessibilityLabel(L.t("native_terminal_prompt_placeholder"))
                    .accessibilityIdentifier("terminal-reply-text")
                if let error = session.promptError {
                    Text(verbatim: error).font(.system(.callout, design: .monospaced))
                        .accessibilityIdentifier("terminal-reply-error")
                }
                if model.replying { ProgressView().accessibilityLabel(L.t("common_loading")) }
            }
            .padding(16)
            .background(IOSTerminalStyle.panel)
            .foregroundStyle(IOSTerminalStyle.ink)
            .navigationTitle(L.t("native_ios_terminal_reply"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(L.t("common_close")) { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(L.t("native_terminal_prompt_send")) {
                        Task { if await model.submitReply() { dismiss() } }
                    }
                    .disabled(!model.canSubmitReply)
                    .accessibilityIdentifier("terminal-reply-send")
                }
            }
        }
        .tint(IOSTerminalStyle.amber)
        .preferredColorScheme(.dark)
        .onAppear { focused = true }
        .onDisappear { focused = false }
    }
}
