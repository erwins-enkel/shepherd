import SwiftUI
import ShepherdKit

/// One lifecycle group: a collapsible header carrying its count, then its rows. The `active` stage
/// has no heading (the web renders it headerless), so it is never collapsible either.
struct HerdGroupView: View {
    let group: HerdGroup
    let isCollapsed: Bool
    /// `SidebarModel.rendered` — the session as it must render, with `HerdPartition.displayStatus`
    /// applied. `SessionRow` is another stream's file and paints whatever `status` it is handed, so
    /// the display-status upgrade has to happen on the way in or the row contradicts the tallies
    /// and the Ready lens, which both already go through `displayStatus`.
    let display: (Session) -> Session
    let block: (String) -> BlockReason?
    let onToggle: () -> Void

    var body: some View {
        Section {
            if !isCollapsed {
                ForEach(group.sessions, id: \.id) { session in
                    VStack(alignment: .leading, spacing: 3) {
                        SessionRow(session: display(session))
                        // Badges read the RAW session: none of them is a status, and the
                        // display-status upgrade is display-only by contract
                        // (`ui/src/lib/display-status.ts:3-10`).
                        SessionBadgeStack(
                            badges: SessionBadges.items(for: session, block: block(session.id)))
                    }
                    .tag(session.id)
                }
            }
        } header: {
            // `who` is stream S2's handoff name; until that classifier is wired in this build never
            // has one, so every waiting group renders its `_multi` heading.
            if let key = group.stage.headingKey() {
                Button(action: onToggle) {
                    HStack(spacing: 4) {
                        Image(systemName: "chevron.down")
                            .font(.caption2)
                            .rotationEffect(.degrees(isCollapsed ? -90 : 0))
                        Text(verbatim: L.t(key, "\(group.sessions.count)"))
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
