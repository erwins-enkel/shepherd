import ShepherdAppCore
import ShepherdKit
import SwiftUI

struct ComposeFooter: View {
    let readiness: ComposeReadiness.State
    let repoName: String?
    let branch: RepoBranchModel
    let held: Bool
    let submit: (Bool) -> Void

    private var submitCopy: String {
        if readiness.blocker == "submitting" { return L.t("newtask_spawning") }
        return repoName.map { L.t("newtask_submit_in_repo", $0) } ?? L.t("newtask_submit")
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(verbatim: readiness.copy).font(.caption).foregroundStyle(.secondary)
            if readiness.advisories.contains("checking") {
                Text(verbatim: L.t("newtask_upstream_checking")).font(.caption).foregroundStyle(.secondary)
            } else if readiness.advisories.contains("diverged") {
                Text(verbatim: L.t("newtask_upstream_diverged", String(branch.upstream?.behind ?? 0),
                                  String(branch.upstream?.ahead ?? 0), branch.baseBranch))
                    .font(.caption).foregroundStyle(.secondary)
            } else if readiness.advisories.contains("behind") {
                Text(verbatim: L.t("newtask_upstream_behind", String(branch.upstream?.behind ?? 0)))
                    .font(.caption).foregroundStyle(.secondary)
            }
            HStack {
                Text(verbatim: held ? L.t("keymap_footer_held", "⌘") : L.t("keymap_footer_idle", "⌘"))
                    .font(.caption.monospaced()).foregroundStyle(.secondary)
                Spacer()
                if readiness.dualCTA {
                    Button { submit(false) } label: {
                        Text(verbatim: L.t("newtask_hold_for_reset") + "  " + ComposeKeymap.entry("submit").cap)
                    }
                    .keyboardShortcut(.return, modifiers: .command)
                    .accessibilityIdentifier("compose.hold")
                    Button(L.t("newtask_submit_anyway")) { submit(true) }
                        .accessibilityIdentifier("compose.submitAnyway")
                } else {
                    // The default action exists ONLY for the single CTA. In the pair, ⌘↵ holds.
                    Button { submit(false) } label: {
                        Text(verbatim: submitCopy + "  " + ComposeKeymap.entry("submit").cap)
                    }
                    .keyboardShortcut(.defaultAction)
                    .accessibilityIdentifier("compose.submit")
                }
            }
            .disabled(!readiness.canSubmit)
        }
    }
}
