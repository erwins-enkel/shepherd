import SwiftUI
import ShepherdKit

/// One lifecycle group: a collapsible header carrying its count, then its rows. The `active` stage
/// has no heading (the web renders it headerless), so it is never collapsible either.
struct HerdGroupView: View {
    let group: HerdGroup
    let isCollapsed: Bool
    let block: (String) -> BlockReason?
    let onToggle: () -> Void

    var body: some View {
        Section {
            if !isCollapsed {
                ForEach(group.sessions, id: \.id) { session in
                    VStack(alignment: .leading, spacing: 3) {
                        SessionRow(session: session)
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
