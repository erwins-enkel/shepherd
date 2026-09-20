import SwiftUI
import ShepherdKit

/// One chip in a row's badge stack, decided outside the view so the gates are unit-testable without
/// hosting SwiftUI — the pattern `SessionStatusStyle` already uses.
struct SessionBadge: Identifiable, Equatable {
    let id: String
    let text: String
    let tint: Color
}

/// The part of `ui/src/lib/components/unit-row/UnitRowRight.svelte` decidable from a `Session` plus
/// its block. The git-derived chips (PR state, CI dot, critic verdict) need stream S2's git snapshot
/// and are not rendered here.
enum SessionBadges {
    static func items(for session: Session, block: BlockReason?) -> [SessionBadge] {
        var items: [SessionBadge] = []
        if session.research == true {
            items.append(.init(id: "research", text: L.t("research_badge_label"), tint: .purple))
        }
        if session.terminal == true {
            items.append(.init(id: "terminal", text: L.t("terminal_badge_label"), tint: .secondary))
        }
        if let kind = HerdPartition.quotaKind(block), let text = quotaLabel(kind) {
            items.append(.init(id: "quota", text: text, tint: .orange))
        }
        // The web hides this while the critic is re-reviewing; that needs git, so here it stands on
        // `autopilotPaused` alone.
        if session.autopilotPaused {
            items.append(
                .init(id: "needs-you", text: L.t("session_autopilot_paused_label"), tint: .orange))
        }
        let steps = session.manualSteps.count
        if steps > 0 {
            items.append(
                .init(
                    id: "manual-steps", text: L.t("unitrow_manual_steps", "\(steps)"),
                    tint: .yellow))
        }
        return items
    }

    /// Exhaustive over `HerdPartition.quotaKind`'s typed result, so a call site can no longer match
    /// an arbitrary string. `.plan` never reaches here (`quotaKind` already filters it), and
    /// `@unknown default` is this build's usual answer to a value it has never seen — no chip,
    /// same as `quotaKind`'s own doc comment — never the `.error` copy, which is a real, distinct
    /// quota kind and must not be the catch-all for "something else".
    private static func quotaLabel(_ kind: BlockReason.QuotaKindPayload.Value1Payload) -> String? {
        switch kind {
        case .rework: L.t("unitrow_quota_rework")
        case .review: L.t("unitrow_quota_review")
        case .error: L.t("unitrow_quota_error")
        case .plan: nil
        @unknown default: nil
        }
    }
}

struct SessionBadgeStack: View {
    let badges: [SessionBadge]

    var body: some View {
        if !badges.isEmpty {
            HStack(spacing: 4) {
                ForEach(badges) { badge in
                    Text(verbatim: badge.text)
                        .font(.caption2.weight(.semibold))
                        .lineLimit(1)
                        .padding(.horizontal, 5)
                        .padding(.vertical, 1)
                        .background(badge.tint.opacity(0.14), in: Capsule())
                        .foregroundStyle(badge.tint)
                }
            }
            .accessibilityElement(children: .combine)
        }
    }
}
