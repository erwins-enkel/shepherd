import ShepherdKit
import SwiftUI

/// The terminal tab's body: the emulator, a state overlay, and the prompt bar.
struct TerminalPane: View {
    @Bindable var model: TerminalSessionModel
    @FocusState private var promptFocused: Bool
    /// Debounces the `.connecting` card; see its own doc comment.
    @State private var connectingOverlay = ConnectingOverlayDebouncer()

    var body: some View {
        VStack(spacing: 0) {
            ZStack {
                TerminalHostView(model: model)
                    .accessibilityLabel(L.t("native_terminal_tab_title"))
                overlay
            }
            Divider()
            promptBar
        }
        .onDisappear { model.detach() }
        // Autofocus the prompt when the tab appears — the operator switching
        // to (or back to) a session almost always wants to type immediately.
        .onAppear { promptFocused = true }
        .onChange(of: model.phase, initial: true) { _, phase in
            connectingOverlay.phaseChanged(toConnecting: phase == .connecting)
        }
    }

    @ViewBuilder
    private var overlay: some View {
        switch model.phase {
        case .idle, .live:
            EmptyView()
        case .connecting:
            if connectingOverlay.isVisible {
                statusCard(
                    title: L.t("native_terminal_connecting"), body: nil, action: nil,
                    systemImage: nil)
            } else {
                EmptyView()
            }
        case .superseded:
            statusCard(
                title: L.t("native_terminal_superseded_title"),
                body: L.t("native_terminal_superseded_body"),
                action: (L.t("native_terminal_superseded_action"), { model.takeOver() }),
                systemImage: "display.2"
            )
        case .ended(let closure):
            endedCard(for: closure)
        }
    }

    /// `TerminalSessionModel.apply(_:)` routes `.closed(.superseded)` to
    /// `.superseded` and `.closed(.stopped)` to `.idle` before a `.closed`
    /// event ever reaches the generic `.ended(closure)` phase — so only
    /// `.gone` and `.unreachable` are actually reachable here. `default`
    /// (rather than naming `.superseded`/`.stopped` again) keeps this switch
    /// exhaustive over `PTYConnection.Closure` without implying either one can
    /// happen.
    @ViewBuilder
    private func endedCard(for closure: PTYConnection.Closure) -> some View {
        switch closure {
        case .gone:
            statusCard(
                title: L.t("native_terminal_ended_title"),
                body: L.t("native_terminal_ended_body"),
                action: nil,
                systemImage: "moon.zzz"
            )
        default:
            statusCard(
                title: L.t("native_terminal_unreachable_title"),
                body: L.t("native_terminal_unreachable_body"),
                action: (L.t("common_retry"), { model.takeOver() }),
                systemImage: "exclamationmark.triangle"
            )
        }
    }

    /// A descriptive title, one short explanatory sentence, and the one next
    /// step — the house rule for explanatory surfaces.
    private func statusCard(
        title: String,
        body: String?,
        action: (label: String, run: () -> Void)?,
        systemImage: String?
    ) -> some View {
        VStack(spacing: 10) {
            if let systemImage {
                Image(systemName: systemImage).font(.largeTitle).foregroundStyle(.secondary)
            }
            Text(verbatim: title).font(.headline)
            if let body {
                Text(verbatim: body)
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                    .frame(maxWidth: 360)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if let action {
                // One identifier for both recoveries: each one is the operator
                // reclaiming the terminal, and only one is ever on screen.
                Button(action.label, action: action.run)
                    .keyboardShortcut(.defaultAction)
                    .accessibilityIdentifier("terminal-takeover")
            }
        }
        .padding(24)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 12))
        .shadow(radius: 8)
    }

    private var promptBar: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 8) {
                TextField(L.t("native_terminal_prompt_placeholder"), text: $model.promptText)
                    .textFieldStyle(.roundedBorder)
                    .focused($promptFocused)
                    .onSubmit { Task { await model.submitPrompt() } }
                    .disabled(model.promptBusy)
                    .accessibilityIdentifier("terminal-prompt")
                Button(L.t("native_terminal_prompt_send")) {
                    Task { await model.submitPrompt() }
                }
                .disabled(model.promptBusy || trimmedPrompt.isEmpty)
                .accessibilityIdentifier("terminal-send")
            }
            if let error = model.promptError {
                Text(verbatim: error).font(.caption).foregroundStyle(.red)
            }
        }
        .padding(8)
    }

    private var trimmedPrompt: String {
        model.promptText.trimmingCharacters(in: .whitespacesAndNewlines)
    }
}
