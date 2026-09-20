import SwiftUI
import ShepherdKit

/// Display values only; server data always comes from generated contract types.
struct SessionBadgeMarker: Identifiable, Equatable {
    let id: String
    let text: String
    let tint: Color
    var symbol: String? = nil
}

struct SessionBadge: Identifiable, Equatable {
    let id: String
    let text: String
    let tint: Color
    var url: URL? = nil
    var markers: [SessionBadgeMarker] = []
}

enum SessionBadges {
    /// Pre-provider sessions were Claude. Compute over the entire visible list, not each group.
    static func showsCli(for sessions: [Session]) -> Bool {
        Set(sessions.map { ($0.agentProvider ?? .claude).rawValue }).count > 1
    }

    static func items(
        for session: Session, block: BlockReason?, git: GitState? = nil,
        verdict: ReviewVerdict? = nil, reviewing: Bool = false, showCli: Bool = false,
        now: Int = 0, repoAutopilotDefault: Bool? = nil
    ) -> [SessionBadge] {
        var items: [SessionBadge] = []
        if showCli {
            items.append(.init(id: "cli", text: session.agentProvider == .codex
                ? L.t("clibadge_label_codex") : L.t("clibadge_label_claude"), tint: .secondary))
        }
        if session.research == true {
            items.append(.init(id: "research", text: L.t("research_badge_label"), tint: .purple))
        }
        if session.terminal == true {
            items.append(.init(id: "terminal", text: L.t("terminal_badge_label"), tint: .secondary))
        }
        if let issue = issue(session, git: git) { items.append(issue) }
        if let pr = pr(git) { items.append(pr) }
        if let critic = critic(verdict, reviewing: reviewing, now: now) { items.append(critic) }
        if let kind = HerdPartition.quotaKind(block), let text = quotaLabel(kind) {
            items.append(.init(id: "quota", text: text, tint: .orange))
        }
        if let autopilot = autopilot(session, reviewing: reviewing, repoDefault: repoAutopilotDefault) {
            items.append(autopilot)
        }
        if let status = status(session, git: git, reviewing: reviewing, now: now) { items.append(status) }
        if !session.manualSteps.isEmpty {
            items.append(.init(id: "manual-steps", text: L.t("unitrow_manual_steps", "\(session.manualSteps.count)"), tint: .yellow))
        }
        return items
    }

    static func safeURL(_ candidates: String?...) -> URL? {
        for candidate in candidates {
            guard let candidate, let url = URL(string: candidate),
                ["https", "http"].contains(url.scheme?.lowercased() ?? ""),
                let host = url.host, !host.isEmpty else { continue }
            return url
        }
        return nil
    }

    static func issue(_ session: Session, git: GitState?) -> SessionBadge? {
        guard let number = session.issueNumber else { return nil }
        // Session's open contract preserves launch/archived metadata without a second wire type.
        let launch = session.additionalProperties.value["launchMetadata"] as? [String: any Sendable]
        let issue = launch?["issue"] as? [String: any Sendable]
        let url = safeURL(git?.issueUrl, issue?["url"] as? String,
            session.additionalProperties.value["issueUrl"] as? String)
        return .init(id: "issue", text: L.t("issuebadge_label", "\(number)"), tint: .secondary, url: url)
    }

    static func ci(_ git: GitState) -> SessionBadgeMarker? {
        guard git.state.known == .open else { return nil }
        switch git.checks.known {
        case .success:
            return .init(id: "ci", text: L.t("activity_ci_success"), tint: .green, symbol: "checkmark.circle.fill")
        case .pending:
            return .init(id: "ci", text: L.t("activity_ci_pending"), tint: .orange, symbol: "clock.fill")
        case .failure:
            return .init(id: "ci", text: L.t("activity_ci_failure"), tint: .red, symbol: "xmark.circle.fill")
        case nil:
            // Unknown wire values remain visible; known `none` alone suppresses the dot.
            return .init(id: "ci", text: L.t("gitrail_ci_status", git.checks.rawValue), tint: .secondary, symbol: "questionmark.circle")
        case .some(.none): return nil
        }
    }

    static func pr(_ git: GitState?) -> SessionBadge? {
        guard let git else { return nil }
        let text: String
        let tint: Color
        switch git.state.known {
        case .open: text = L.t("prbadge_open", "\(git.number ?? 0)"); tint = .secondary
        case .merged: text = L.t("prbadge_merged"); tint = .secondary
        case .closed: text = L.t("prbadge_closed"); tint = .secondary.opacity(0.65)
        default: return nil
        }
        var markers: [SessionBadgeMarker] = []
        if let ci = ci(git) { markers.append(ci) }
        if let review = git.latestReview {
            let key: StaticString
            let color: Color
            switch review.state.known {
            case .approved: key = "prbadge_review_approved"; color = .green
            case .commented: key = "prbadge_review_comment"; color = .blue
            default: key = "prbadge_review_changes"; color = .orange
            }
            markers.append(.init(id: "review", text: L.t(key), tint: color))
        }
        if git.state.known == .open, git.isDraft == true {
            markers.append(.init(id: "draft", text: L.t("prbadge_draft"), tint: .secondary))
        }
        switch HerdClassifier.prReadinessBlock(git) {
        case .behind: markers.append(.init(id: "stale", text: L.t("prbadge_behind"), tint: .orange))
        case .conflict: markers.append(.init(id: "stale", text: L.t("prbadge_conflict"), tint: .orange))
        default: break
        }
        return .init(id: "pr", text: text, tint: tint, url: safeURL(git.url), markers: markers)
    }

    static func critic(_ verdict: ReviewVerdict?, reviewing: Bool, now: Int) -> SessionBadge? {
        guard reviewing || verdict != nil else { return nil }
        // CriticBadge.rawView: a streak REPLACES the verdict/reviewing label.
        // Only a stalled streak yields to an in-flight re-review.
        if let verdict, verdict.addressRound > 0 {
            let status = HerdClassifier.addressStallStatus(verdict, now: now)
            if status != .stalled || !reviewing {
                let text: String
                switch status {
                case .round: text = L.t("criticbadge_round", "\(min(verdict.addressRound, verdict.addressCap))", "\(verdict.addressCap)")
                case .final: text = L.t("criticbadge_final")
                case .stalled: text = L.t("criticbadge_stalled")
                }
                return .init(id: "critic", text: text, tint: status == .stalled ? .red : .orange)
            }
        }
        let text: String
        let tint: Color
        if reviewing { text = L.t("criticbadge_reviewing"); tint = .orange }
        else {
            switch verdict?.decision.known {
            case .changesRequested: text = L.t("criticbadge_changes"); tint = .orange
            case .commented: text = L.t("criticbadge_commented"); tint = .blue
            default: text = L.t("criticbadge_error"); tint = .secondary.opacity(0.65)
            }
        }
        return .init(id: "critic", text: text, tint: tint)
    }

    static func autopilot(_ session: Session, reviewing: Bool, repoDefault: Bool? = nil) -> SessionBadge? {
        guard !reviewing else { return nil }
        if session.autopilotPaused {
            return .init(id: "needs-you", text: L.t("session_autopilot_paused_label"), tint: .orange)
        }
        if session.autopilotComplete {
            return .init(id: "autopilot", text: L.t("session_autopilot_complete_label"), tint: .green)
        }
        let launch = session.additionalProperties.value["codexLaunchId"] as? String
        if (session.autopilotEnabled ?? repoDefault) == true, session.agentProvider == .codex,
            launch?.isEmpty != false || session.providerSessionId?.isEmpty != false,
            session.research != true {
            return .init(id: "autopilot", text: L.t("session_autopilot_unavailable_label"), tint: .secondary)
        }
        return nil
    }

    static func status(_ session: Session, git: GitState?, reviewing: Bool, now: Int) -> SessionBadge? {
        // UnitRowRight's row predicate intentionally has NO !isReworkRunning term: the row
        // receives only `reviewing`, unlike the lifecycle classifier's richer HerdContext.
        if let git, git.state.known == .open,
            HerdClassifier.checksCleared(git.checks, noCi: git.noCi ?? false),
            session.status.known != .running, session.status.known != .blocked, !reviewing {
            if let block = git.reviewBlock {
                return .init(id: "status", text: L.t("unitrow_changes_requested", block.reviewer), tint: .orange)
            }
            if git.mergeStateStatus?.known == .blocked {
                return .init(id: "status", text: L.t("unitrow_merge_blocked"), tint: .orange)
            }
        }
        if HerdPartition.isMerging(session, now: now) {
            return .init(id: "status", text: L.t("status_merging"), tint: .orange)
        }
        if session.readyToMerge {
            return .init(id: "status", text: L.t("status_ready_to_merge"), tint: .green)
        }
        return nil
    }

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
            ScrollView(.horizontal) {
                HStack(spacing: 4) {
                    ForEach(badges) { badge in
                        if let url = badge.url {
                            Link(destination: url) { chip(badge) }.buttonStyle(.plain)
                        } else { chip(badge) }
                    }
                }
            }
            .scrollIndicators(.never)
        }
    }

    private func chip(_ badge: SessionBadge) -> some View {
        HStack(spacing: 4) {
            Text(verbatim: badge.text).foregroundStyle(badge.tint)
            ForEach(badge.markers) { marker in
                if let symbol = marker.symbol {
                    Image(systemName: symbol).foregroundStyle(marker.tint)
                        .accessibilityLabel(Text(verbatim: marker.text))
                        .help(marker.text)
                } else { Text(verbatim: marker.text).foregroundStyle(marker.tint) }
            }
        }
        .font(.caption2.weight(.semibold))
        .lineLimit(1)
        .fixedSize()
        .padding(.horizontal, 5)
        .padding(.vertical, 2)
        .background(badge.tint.opacity(0.14), in: Capsule())
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("herd-badge-\(badge.id)")
    }
}
