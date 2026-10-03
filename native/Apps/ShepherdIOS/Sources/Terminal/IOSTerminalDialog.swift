import ShepherdAppCore
import SwiftUI

/// Claude's selection dialogs (AskUserQuestion, permission prompts, pickers) end in a key-hint
/// footer that printed prose does not carry. The fragments mirror `DIALOG_FOOTER_RE` in
/// `src/blocked.ts`; reading them from the rendered screen lets the key row follow the dialog
/// without waiting for the server's block classification.
enum IOSTerminalDialog {
    /// The same window the server classifies: the footer sits just above the input box.
    private static let tailRows = 15
    private static let footerHints = [
        "enter to select", "enter to confirm", "esc to cancel", "↑/↓ to navigate", "arrow keys to navigate",
    ]

    static func isOpen(_ rows: [String]) -> Bool {
        rows.map { $0.trimmingCharacters(in: .whitespaces) }
            .filter { !$0.isEmpty }
            .suffix(tailRows)
            .contains { row in
                let lower = row.lowercased()
                return footerHints.contains { lower.contains($0) }
            }
    }
}

/// The bottom row while a dialog is open: answer with the thumb, no keyboard.
/// Navigation keys sit right and larger; Esc, tab switching and ⌨ sit left.
/// Free text ("Type something") is opt-in via ⌨, which opens the reply bar's writing state.
struct IOSTerminalDialogBar: View {
    let model: IOSTerminalPresentation
    /// Opens the writing state for a free-text answer.
    let startTyping: () -> Void
    @ScaledMetric(relativeTo: .callout) private var labelSize: CGFloat = 16
    private var keyWidth: CGFloat { max(44, ceil(labelSize * 2.4)) }
    private var keyHeight: CGFloat { max(48, ceil(labelSize * 1.3 + 20)) }

    var body: some View {
        ViewThatFits(in: .horizontal) {
            HStack(spacing: 6) { secondaryKeys; Spacer(minLength: 0); primaryKeys }
            VStack(alignment: .leading, spacing: 6) {
                HStack(spacing: 6) { secondaryKeys }
                HStack(spacing: 6) { primaryKeys }
            }
        }
        .disabled(!model.canSendInput)
        .padding(.horizontal, 10).padding(.vertical, 6)
        .font(.system(size: labelSize, design: .monospaced))
        .background(IOSTerminalStyle.panel)
        .accessibilityElement(children: .contain)
        .accessibilityLabel(L.t("native_ios_terminal_dialog_keys"))
        .accessibilityIdentifier("terminal-dialog-keys")
    }

    @ViewBuilder private var secondaryKeys: some View {
        keyButton(.escape)
        keyButton(.left)
        keyButton(.right)
        Button(action: startTyping) {
            Image(systemName: "keyboard")
                .frame(width: keyWidth, height: keyHeight)
                .overlay(Rectangle().stroke(IOSTerminalStyle.line))
                // Same draft mark as the resting bar's ⌨.
                .overlay(alignment: .topTrailing) {
                    if model.hasDraft { Circle().fill(ComposePalette.amber).frame(width: 7, height: 7).padding(7) }
                }
        }
        .buttonStyle(.plain).foregroundStyle(IOSTerminalStyle.ink)
        .accessibilityLabel(L.t("native_ios_terminal_dialog_type"))
        .accessibilityValue(model.hasDraft ? L.t("native_ios_reply_draft") : "")
        .accessibilityIdentifier("terminal-dialog-type")
    }

    @ViewBuilder private var primaryKeys: some View {
        keyButton(.up, primary: true)
        keyButton(.down, primary: true)
        keyButton(.enter, primary: true)
    }

    private func keyButton(_ key: IOSTerminalKey, primary: Bool = false) -> some View {
        Button { model.sendKey(key) } label: {
            Text(verbatim: key.keycap).fixedSize()
                .font(primary ? .system(size: ceil(labelSize * 1.25), weight: .semibold, design: .monospaced) : nil)
                .frame(minWidth: keyWidth, maxWidth: primary ? 96 : keyWidth)
                .frame(height: keyHeight)
                .foregroundStyle(key == .enter ? IOSTerminalStyle.amber : IOSTerminalStyle.ink)
                .background(primary ? IOSTerminalStyle.line : Color.clear)
                .overlay(Rectangle().stroke(IOSTerminalStyle.line))
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .layoutPriority(primary ? 1 : 0)
        .accessibilityLabel(key.accessibilityLabel)
        .accessibilityIdentifier("terminal-dialog-key-\(key)")
    }
}
