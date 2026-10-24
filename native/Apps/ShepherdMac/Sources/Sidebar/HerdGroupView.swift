import ShepherdAppCore
import SwiftUI
import ShepherdKit

/// One lifecycle group: a collapsible header carrying its count, then its rows. The `active` stage
/// has no heading (the web renders it headerless), so it is never collapsible either.
struct HerdGroupView: View {
    @Environment(AppModel.self) private var app
    let group: HerdGroup
    let isCollapsed: Bool
    let now: Int
    /// `SidebarModel.rendered` — the session as it must render, with `HerdPartition.displayStatus`
    /// applied. `SessionRow` is another stream's file and paints whatever `status` it is handed, so
    /// the display-status upgrade has to happen on the way in or the row contradicts the tallies
    /// and the Ready lens, which both already go through `displayStatus`.
    let display: (Session) -> Session
    let block: (String) -> BlockReason?
    let contextMenu: SessionContextController
    let onToggle: () -> Void

    static func heading(_ group: HerdGroup, git: [String: GitState]) -> String? {
        SidebarCopy.heading(group, git: git)
    }

    var body: some View {
        let showCli = SessionBadges.showsCli(for: app.store?.visibleSessions ?? group.sessions)
        Section {
            if !isCollapsed {
                ForEach(group.sessions, id: \.id) { session in
                    HerdSessionRow(session: session, now: now, display: display, block: block,
                        showCli: showCli, contextMenu: contextMenu)
                }
            }
        } header: {
            if let title = Self.heading(group, git: app.extension(HerdSignals.self)?.git ?? [:]) {
                Button(action: onToggle) {
                    HStack(spacing: 4) {
                        Image(systemName: "chevron.down")
                            .font(.caption2)
                            .rotationEffect(.degrees(isCollapsed ? -90 : 0))
                        Text(verbatim: title)
                            .modifier(ShepherdMonoFont(label: true))
                            .tracking(1)
                            .foregroundStyle(ShepherdPalette.muted)
                        Spacer(minLength: 0)
                    }
                }
                .buttonStyle(.plain)
                .accessibilityAddTraits(.isHeader)
                .accessibilityIdentifier("herd-group-\(group.stage.rawValue)")
            }
        }
    }
}
