import ShepherdAppCore
import ShepherdKit
import SwiftUI

struct ComposeFooter: View {
    let readiness: ComposeReadiness.State
    let repoName: String?
    let branch: RepoBranchModel
    let held: Bool
    var serverName: String?
    var shortcutsBlocked = false
    let submit: (Bool) -> Void

    private var submitCopy: String {
        if readiness.blocker == "submitting" { return L.t("newtask_spawning") }
        return repoName.map { L.t("newtask_submit_in_repo", $0) } ?? L.t("newtask_submit")
    }
    private var status: String {
        let line = readiness.canSubmit
            ? "✓ \(readiness.copy) · \(L.t("newtask_readiness_branches", branch.baseBranch))" : readiness.copy
        return serverName.map { "\($0) · \(line)" } ?? line
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(verbatim: status).font(.caption).foregroundStyle(.secondary)
                .accessibilityIdentifier("compose.readiness")
            HStack {
                Text(verbatim: held ? L.t("keymap_footer_held", "⌘") : L.t("keymap_footer_idle", "⌘"))
                    .font(.caption.monospaced()).foregroundStyle(.secondary)
                Spacer()
                // Exactly one ⌘↵ binding in either state. Plain Return belongs to text entry.
                if readiness.dualCTA {
                    Button { submit(false) } label: {
                        Text(verbatim: L.t("newtask_hold_for_reset") + "  " + ComposeKeymap.entry("submit").cap)
                    }
                    .keyboardShortcut(.return, modifiers: .command)
                    .accessibilityIdentifier("compose.hold")
                    Button(L.t("newtask_submit_anyway")) { submit(true) }
                        .accessibilityIdentifier("compose.submitAnyway")
                } else {
                    Button { submit(false) } label: {
                        Text(verbatim: submitCopy + "  " + ComposeKeymap.entry("submit").cap)
                    }
                    .buttonStyle(.borderedProminent)
                    .keyboardShortcut(.return, modifiers: .command)
                    .accessibilityIdentifier("compose.submit")
                }
            }
            .disabled(!readiness.canSubmit || shortcutsBlocked)
        }
    }
}
