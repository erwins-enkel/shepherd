import Foundation
import ShepherdKit

/// Where a completed epic's landing stands. Mirrors `IntegratedEpicSituation` in
/// ui/src/lib/integrated-epic-status.ts, minus the web's inline `confirming` step: the native
/// apps confirm a land in a system dialog instead.
public enum CompletedEpicSituation: Sendable, Equatable {
    case preparing, checking, repairing, ciRetrying, ciFailed, conflicts, nothingToLand, ready,
        landing, landed, error, notReady
}

/// Who has to act next — the card's chip.
public enum CompletedEpicTurn: Sendable, Equatable { case nothingToDo, yourTurn, ready, done }

/// The card's colour: quiet slate, warn orange, or green for ready to land only.
public enum CompletedEpicTone: Sendable, Equatable { case quiet, warn, ready }

/// The display decision for one row, shared by the card, the band's order and its placement.
/// The server owns merge readiness; this only reads the signals it sent.
public struct CompletedEpicStatus: Sendable, Equatable {
    public enum CiVariant: Sendable, Equatable { case exhausted, drainOff, afterRepair, unsupported }
    public enum CiRetrying: Sendable, Equatable { case reruns, repair }
    public enum RepairKind: Sendable, Equatable { case conflicts, ci }

    public let situation: CompletedEpicSituation
    public let turn: CompletedEpicTurn
    public let tone: CompletedEpicTone
    public let sortOrder: Int
    public let needsOperator: Bool
    public let canLand: Bool
    public let canResolveConflicts: Bool
    /// #2872: the operator may start a CI-repair agent.
    public let canRepairCi: Bool
    public let ciVariant: CiVariant?
    public let ciRetrying: CiRetrying?
    public let repairKind: RepairKind?

    /// `landing`: the operator's land request is still in flight (the merge runs inside the POST).
    public init(_ epic: CompletedEpic, landing: Bool = false) {
        let open = epic.landingState.rawValue == "open"
        let situation: CompletedEpicSituation = landing && open ? .landing : Self.situation(epic)
        self.situation = situation
        let turn = Self.turn(situation)
        self.turn = turn
        let policy = Self.policy(turn)
        tone = policy.tone
        sortOrder = policy.sortOrder
        needsOperator = policy.needsOperator
        canLand = policy.canLand
        let pause = epic.landingRebasePauseReason?.rawValue
        canResolveConflicts = open && epic.landingRepairing != true
            && (pause == "conflict" || epic.landingMergeable == false)
        // The server only repairs a terminally red PR, and only on GitHub.
        canRepairCi = (situation == .ciFailed || situation == .ciRetrying)
            && epic.landingChecks?.rawValue == "failure" && !Self.forgeUnsupported(epic)
        ciVariant = situation == .ciFailed ? Self.ciVariant(epic) : nil
        if situation == .ciRetrying {
            let reruns = epic.landingCiAutomation?.reruns.status.rawValue
            ciRetrying = reruns == "pending" || reruns == "running" ? .reruns : .repair
        } else {
            ciRetrying = nil
        }
        if situation == .repairing {
            repairKind = epic.landingMergeable == false || pause == "conflict" ? .conflicts : .ci
        } else {
            repairKind = nil
        }
    }

    private static func situation(_ epic: CompletedEpic) -> CompletedEpicSituation {
        switch epic.landingState.rawValue {
        case "pending": return .preparing
        case "none": return .nothingToLand
        case "merged": return .landed
        case "error": return .error
        case "open": break
        // A state this client does not know yet: nothing to act on, nothing to claim.
        default: return .checking
        }
        if epic.landingRepairing == true { return .repairing }
        if epic.landingRebasePauseReason != nil || epic.landingMergeable == false { return .conflicts }
        // #2872: red is the operator's turn only once Shepherd's automatic stages are spent.
        let automation = epic.landingCiAutomation
        let checks = epic.landingChecks?.rawValue
        if checks == "failure" { return automationActing(automation) ? .ciRetrying : .ciFailed }
        if checks == "pending", automation?.reruns.status.rawValue == "running" { return .ciRetrying }
        if epic.landingReady == true, epic.landingPrNumber != nil { return .ready }
        if checks == "success", epic.landingMergeable == true { return .notReady }
        return .checking
    }

    private static func turn(_ situation: CompletedEpicSituation) -> CompletedEpicTurn {
        switch situation {
        case .preparing, .checking, .repairing, .ciRetrying, .landing: .nothingToDo
        case .ciFailed, .conflicts, .nothingToLand, .error, .notReady: .yourTurn
        case .ready: .ready
        case .landed: .done
        }
    }

    private static func policy(_ turn: CompletedEpicTurn)
        -> (tone: CompletedEpicTone, sortOrder: Int, needsOperator: Bool, canLand: Bool) {
        switch turn {
        case .nothingToDo: (.quiet, 2, false, false)
        case .yourTurn: (.warn, 1, true, false)
        case .ready: (.ready, 0, true, true)
        case .done: (.quiet, 3, false, false)
        }
    }

    private static func automationActing(_ automation: LandingCiAutomation?) -> Bool {
        guard let automation else { return false }
        return [automation.reruns.status.rawValue, automation.repair.status.rawValue]
            .contains { $0 == "pending" || $0 == "running" }
    }

    private static func forgeUnsupported(_ epic: CompletedEpic) -> Bool {
        epic.landingCiAutomation?.reruns.skipReason?.rawValue == "no-github"
    }

    private static func ciVariant(_ epic: CompletedEpic) -> CiVariant {
        if forgeUnsupported(epic) { return .unsupported }
        let repair = epic.landingCiAutomation?.repair
        if repair?.status.rawValue == "done" { return .afterRepair }
        if repair?.skipReason?.rawValue == "auto-drain-off" { return .drainOff }
        return .exhausted
    }
}

/// Everything one card of the "Epics to land" band shows, worded exactly as the web's
/// IntegratedEpicRow / IntegratedEpicLanding. Pure: a view renders it, never re-derives it.
public struct CompletedEpicCard: Identifiable, Sendable {
    public enum Marker: Sendable, Equatable { case done, running, failure, warn, ready, open }

    /// One step of "Path to main".
    public struct Step: Identifiable, Sendable, Equatable {
        public let id: Int
        public let label: String
        public let value: String
        public let detail: String?
        public let marker: Marker
        public let url: URL?
    }

    /// One sub-issue in "In the landing PR".
    public struct Child: Identifiable, Sendable, Equatable {
        public let id: Int
        public let ref: String
        public let url: URL?
        public let integrated: Bool
        public let note: String
        public let title: String?
    }

    public enum Action: Sendable, Equatable {
        case land, repairCi, resolveConflicts, ackMigrations, dismiss
        case openURL(URL)
        case openSession(String)
    }

    /// One button in "Next step". A prominent one is the state's main action, filled in the tone.
    public struct ActionButton: Identifiable, Sendable, Equatable {
        public var id: String { label }
        public let action: Action
        public let label: String
        public let prominent: Bool
    }

    /// The land confirmation's title, message and migration warning.
    public struct Confirmation: Sendable, Equatable {
        public let prompt: String
        public let message: String
        public let migrationWarning: String?
    }

    public let id: String
    public let repoPath: String
    public let parentNumber: Int
    public let status: CompletedEpicStatus
    public let identity: String
    public let repoName: String
    public let finished: String
    public let title: String
    public let turnLabel: String
    /// "Waiting for 6d", "Conflict unresolved for 2d", the no-CI hold.
    public let flags: [String]
    /// The collapsed card's one-line state.
    public let summary: String
    public let heading: String
    public let body: String
    public let steps: [Step]
    public let buttons: [ActionButton]
    /// Set while the land request is in flight: a disabled button with this label.
    public let busyLabel: String?
    /// Why "Land epic" is locked, shown beside the locked button. Nil when it is not shown.
    public let lockedReason: String?
    public let notes: [String]
    public let showsFooter: Bool
    public let childrenHeading: String
    public let children: [Child]
    public let confirmation: Confirmation?
    public let expandLabel: String
    public let collapseLabel: String

    public init(_ epic: CompletedEpic, now: Int, landing: Bool = false) {
        let status = CompletedEpicStatus(epic, landing: landing)
        let parent = epic.parentIssueNumber
        let number = epic.landingPrNumber
        let open = epic.landingState.rawValue == "open"
        let total = epic.children.count
        let included = epic.children.filter(\.integrated).count
        let pendingAck = !epic.migrationPaths.isEmpty && epic.migrationsAckedAt == nil
        let copy = Self.copy(epic, status: status, included: included)

        self.status = status
        id = CompletedEpicsBand.key(epic)
        repoPath = epic.repoPath
        parentNumber = parent
        identity = L.t("integrated_epics_identity", String(parent))
        repoName = epic.repoPath.split(separator: "/").last.map(String.init) ?? epic.repoPath
        finished = L.t("integrated_epics_finished_ago", CompletedEpicsBand.ago(now - epic.completedAt))
        title = epic.parentTitle
        turnLabel = switch status.turn {
        case .nothingToDo: L.t("integrated_epics_turn_nothing")
        case .yourTurn: L.t("integrated_epics_turn_you")
        case .ready: L.t("integrated_epics_turn_ready")
        case .done: L.t("integrated_epics_turn_done")
        }
        var flags: [String] = []
        if epic.landingStranded == true {
            flags.append(L.t("integrated_epics_land_stranded", CompletedEpicsBand.ago(now - epic.completedAt)))
        }
        if epic.landingNoCiHold == true { flags.append(L.t("integrated_epics_land_no_ci")) }
        if epic.landingConflictStranded == true, let since = epic.landingConflictSince {
            flags.append(L.t("integrated_epics_land_conflict_stranded", CompletedEpicsBand.ago(now - since)))
        }
        self.flags = flags
        summary = Self.summary(epic, status: status)
        heading = copy.heading
        body = PlacementCopy.plain(copy.body)
        expandLabel = L.t("integrated_epics_expand_aria", String(parent))
        collapseLabel = L.t("integrated_epics_collapse_aria", String(parent))

        let landingLabel = number.map { L.t("integrated_epics_path_landing", String($0)) }
            ?? L.t("integrated_epics_path_landing_nonum")
        steps = [
            Step(id: 0, label: L.t("integrated_epics_path_tasks"), value: "\(total)/\(total)",
                 detail: L.t("integrated_epics_path_counts", String(included), String(total - included)),
                 marker: .done, url: nil),
            Step(id: 1, label: L.t("integrated_epics_path_collected"),
                 value: L.t("integrated_epics_path_pr_count", String(included)),
                 detail: epic.integrationBranch ?? L.t("integrated_epics_path_branch_unknown"),
                 marker: included > 0 ? .done : .open, url: nil),
            Step(id: 2, label: landingLabel, value: copy.label, detail: nil, marker: Self.landingMarker(status),
                 url: epic.landingPrUrl.flatMap { URL(string: $0) }),
            Step(id: 3, label: L.t("integrated_epics_path_landed"), value: "", detail: nil,
                 marker: status.situation == .landed ? .done : .open, url: nil),
        ]

        let checksURL = epic.landingPrUrl.flatMap { url in
            URL(string: (url.hasSuffix("/") ? String(url.dropLast()) : url) + "/checks")
        }
        let repairSession = epic.landingCiAutomation?.repair.sessionId
        let ackInstead = !open && pendingAck
        let fieldRemoval = status.situation == .nothingToLand || status.situation == .landed
        var buttons: [ActionButton] = []
        switch status.situation {
        case .landing: break
        case .ready:
            buttons.append(.init(action: .land, label: L.t("integrated_epics_land"), prominent: true))
        case _ where status.canRepairCi:
            // #2872: primary once nothing automatic is left; secondary while Shepherd still retries.
            buttons.append(.init(action: .repairCi, label: status.ciVariant == .afterRepair
                ? L.t("integrated_epics_repair_ci_again") : L.t("integrated_epics_repair_ci"),
                prominent: status.situation == .ciFailed))
            if status.ciVariant == .afterRepair, let repairSession {
                buttons.append(.init(action: .openSession(repairSession),
                    label: L.t("integrated_epics_last_session"), prominent: false))
            }
            if let checksURL {
                buttons.append(.init(action: .openURL(checksURL),
                    label: L.t("integrated_epics_view_checks"), prominent: false))
            }
        case .ciRetrying, .ciFailed:
            if let checksURL {
                buttons.append(.init(action: .openURL(checksURL), label: L.t("integrated_epics_view_checks"),
                    prominent: status.situation == .ciFailed))
            }
        case .repairing:
            if let repairSession {
                buttons.append(.init(action: .openSession(repairSession),
                    label: L.t("integrated_epics_open_session"), prominent: false))
            }
        case .conflicts where status.canResolveConflicts:
            buttons.append(.init(action: .resolveConflicts, label: L.t("integrated_epics_resolve_conflicts"),
                prominent: true))
        case .nothingToLand:
            if let issue = Self.parentURL(epic) {
                buttons.append(.init(action: .openURL(issue), label: L.t("integrated_epics_open_issue"),
                    prominent: true))
            }
        case .notReady:
            if let pr = epic.landingPrUrl.flatMap { URL(string: $0) } {
                buttons.append(.init(action: .openURL(pr), label: L.t("integrated_epics_open_pr"), prominent: true))
            }
        default: break
        }
        if ackInstead {
            buttons.append(.init(action: .ackMigrations, label: L.t("integrated_epics_ack_migrations"),
                prominent: true))
        } else if fieldRemoval {
            buttons.append(.init(action: .dismiss, label: L.t("integrated_epics_dismiss"),
                prominent: status.situation == .landed))
        }
        self.buttons = buttons
        busyLabel = status.situation == .landing ? L.t("integrated_epics_land_in_progress") : nil
        lockedReason = open && !status.canLand && status.situation != .landing ? copy.reason : nil

        var notes: [String] = []
        if status.canRepairCi { notes.append(L.t("integrated_epics_repair_ci_hint")) }
        if ackInstead {
            notes.append(L.t("epic_migrations_pending", String(epic.migrationPaths.count)))
        } else if fieldRemoval {
            notes.append(L.t("integrated_epics_dismiss_hint"))
        }
        self.notes = notes
        showsFooter = !fieldRemoval && !ackInstead && status.situation != .landing

        childrenHeading = L.t("integrated_epics_children_heading", String(included), String(total))
        children = epic.children.map { child in
            let ref: String
            let url: URL?
            if child.integrated, let pr = child.prNumber {
                ref = L.t("integrated_epics_pr_ref", String(pr))
                url = child.prUrl.flatMap { URL(string: $0) }
            } else if child.integrated, let prURL = child.prUrl {
                ref = L.t("integrated_epics_pr_ref_nonum")
                url = URL(string: prURL)
            } else {
                ref = "#\(child.number)"
                url = URL(string: child.url)
            }
            return Child(id: child.number, ref: ref, url: url, integrated: child.integrated,
                note: child.integrated
                    ? L.t("integrated_epics_child_merged_ago",
                        CompletedEpicsBand.ago(now - (child.mergedAt ?? epic.completedAt)))
                    : L.t("integrated_epics_child_closed"),
                title: child.title == "#\(child.number)" ? nil : child.title)
        }

        if status.canLand, let number {
            confirmation = Confirmation(
                prompt: L.t("integrated_epics_land_confirm_prompt", String(number)),
                message: L.t("integrated_epics_land_confirm_body", String(included), String(parent)),
                migrationWarning: pendingAck
                    ? L.t("integrated_epics_land_confirm_migration_warn", String(epic.migrationPaths.count))
                    : nil)
        } else {
            confirmation = nil
        }
    }

    private struct Copy {
        let heading: String
        let body: String
        let label: String
        let reason: String
    }

    private static func copy(_ epic: CompletedEpic, status: CompletedEpicStatus, included: Int) -> Copy {
        let number = epic.landingPrNumber.map(String.init)
        let parent = String(epic.parentIssueNumber)
        let checking = epic.landingChecks?.rawValue == "pending"
            || (epic.landingChecks != nil && epic.landingMergeable == nil)
        let paused: String? = switch epic.landingRebasePauseReason?.rawValue {
        case "cap": L.t("integrated_epics_rebase_paused_cap")
        case "conflict": L.t("integrated_epics_rebase_paused_conflict")
        case "driver": L.t("integrated_epics_rebase_paused_driver")
        default: nil
        }
        switch status.situation {
        case .preparing:
            return Copy(heading: L.t("integrated_epics_heading_preparing"),
                body: L.t("integrated_epics_body_preparing"),
                label: L.t("integrated_epics_status_preparing"), reason: "")
        case .checking:
            return Copy(
                heading: checking && number != nil
                    ? L.t("integrated_epics_heading_checking", number ?? "")
                    : L.t("integrated_epics_heading_unknown"),
                body: checking ? L.t("integrated_epics_body_checking") : L.t("integrated_epics_body_unknown"),
                label: checking ? L.t("integrated_epics_status_checking") : L.t("integrated_epics_status_unknown"),
                reason: checking
                    ? L.t("integrated_epics_land_not_ready_computing")
                    : L.t("integrated_epics_land_not_ready_generic"))
        case .repairing:
            let conflicts = status.repairKind == .conflicts
            return Copy(
                heading: conflicts
                    ? L.t("integrated_epics_heading_repairing_conflicts")
                    : L.t("integrated_epics_heading_repairing_ci"),
                body: conflicts
                    ? L.t("integrated_epics_body_repairing_conflicts")
                    : L.t("integrated_epics_body_repairing_ci"),
                label: L.t("integrated_epics_status_repairing"),
                reason: L.t("integrated_epics_land_not_ready_repairing"))
        case .ciRetrying:
            let repair = status.ciRetrying == .repair
            return Copy(
                heading: repair
                    ? L.t("integrated_epics_heading_ci_retrying_repair")
                    : L.t("integrated_epics_heading_ci_retrying_reruns"),
                body: repair
                    ? L.t("integrated_epics_body_ci_retrying_repair")
                    : L.t("integrated_epics_body_ci_retrying_reruns"),
                label: L.t("integrated_epics_status_ci_retrying"),
                reason: L.t("integrated_epics_land_not_ready_ci_failing"))
        case .ciFailed:
            let heading = status.ciVariant == .afterRepair
                ? L.t("integrated_epics_heading_ci_after_repair")
                : number.map { L.t("integrated_epics_heading_ci_failed", $0) }
                    ?? L.t("integrated_epics_heading_ci_failed_nonum")
            let body: String = switch status.ciVariant {
            case .afterRepair: L.t("integrated_epics_body_ci_after_repair")
            case .drainOff: L.t("integrated_epics_body_ci_drain_off")
            case .unsupported: L.t("integrated_epics_body_ci_failed")
            default: L.t("integrated_epics_body_ci_exhausted")
            }
            return Copy(heading: heading, body: body, label: L.t("integrated_epics_status_ci_failed"),
                reason: L.t("integrated_epics_land_not_ready_ci_failing"))
        case .conflicts:
            return Copy(
                heading: paused ?? (number.map { L.t("integrated_epics_heading_conflicts", $0) }
                    ?? L.t("integrated_epics_heading_conflicts_nonum")),
                body: status.canResolveConflicts
                    ? L.t("integrated_epics_body_conflicts") : L.t("integrated_epics_body_paused"),
                label: paused != nil
                    ? L.t("integrated_epics_status_paused") : L.t("integrated_epics_status_conflicts"),
                reason: status.canResolveConflicts
                    ? L.t("integrated_epics_land_not_ready_conflicts")
                    : L.t("integrated_epics_land_not_ready_generic"))
        case .nothingToLand:
            return Copy(heading: L.t("integrated_epics_heading_none"),
                body: included == 0
                    ? L.t("integrated_epics_body_nothing_merged", parent)
                    : L.t("integrated_epics_body_nothing_left"),
                label: L.t("integrated_epics_status_none"), reason: "")
        case .ready:
            return Copy(heading: L.t("integrated_epics_heading_ready"),
                body: L.t("integrated_epics_body_ready", number ?? "", parent),
                label: L.t("integrated_epics_status_ready"), reason: "")
        case .landing:
            return Copy(heading: L.t("integrated_epics_heading_landing", number ?? ""),
                body: L.t("integrated_epics_body_landing"),
                label: L.t("integrated_epics_status_landing"), reason: "")
        case .landed:
            return Copy(heading: L.t("integrated_epics_path_landed"),
                body: number.map { L.t("integrated_epics_body_landed", $0, parent) }
                    ?? L.t("integrated_epics_body_landed_nonum"),
                label: L.t("integrated_epics_status_merged"), reason: "")
        case .error:
            return Copy(heading: L.t("integrated_epics_landing_failed"), body: L.t("integrated_epics_body_error"),
                label: L.t("integrated_epics_status_error"), reason: "")
        case .notReady:
            return Copy(heading: L.t("integrated_epics_heading_not_ready"), body: L.t("integrated_epics_body_not_ready"),
                label: L.t("integrated_epics_status_not_ready"),
                reason: L.t("integrated_epics_land_not_ready_generic"))
        }
    }

    /// The collapsed card's state line (IntegratedEpicRow's `summary`).
    private static func summary(_ epic: CompletedEpic, status: CompletedEpicStatus) -> String {
        let number = epic.landingPrNumber.map(String.init)
        switch status.situation {
        case .landing: return L.t("integrated_epics_short_landing", number ?? "")
        case .preparing: return L.t("integrated_epics_short_preparing")
        case .checking:
            let checking = epic.landingChecks?.rawValue == "pending"
                || (epic.landingChecks != nil && epic.landingMergeable == nil)
            if let number, checking { return L.t("integrated_epics_short_checking", number) }
            return L.t("integrated_epics_heading_unknown")
        case .ciRetrying:
            return status.ciRetrying == .repair
                ? L.t("integrated_epics_heading_ci_retrying_repair")
                : L.t("integrated_epics_heading_ci_retrying_reruns")
        case .repairing:
            return status.repairKind == .conflicts
                ? L.t("integrated_epics_heading_repairing_conflicts")
                : L.t("integrated_epics_heading_repairing_ci")
        case .ciFailed:
            return number.map { L.t("integrated_epics_short_ci_failed", $0) }
                ?? L.t("integrated_epics_heading_ci_failed_nonum")
        case .conflicts:
            switch epic.landingRebasePauseReason?.rawValue {
            case "cap": return L.t("integrated_epics_rebase_paused_cap")
            case "driver": return L.t("integrated_epics_rebase_paused_driver")
            default:
                return number.map { L.t("integrated_epics_short_conflicts", $0) }
                    ?? L.t("integrated_epics_heading_conflicts_nonum")
            }
        case .nothingToLand: return L.t("integrated_epics_heading_none")
        case .ready: return L.t("integrated_epics_short_ready", number ?? "")
        case .landed: return L.t("integrated_epics_path_landed")
        case .error: return L.t("integrated_epics_landing_failed")
        case .notReady: return L.t("integrated_epics_heading_not_ready")
        }
    }

    private static func landingMarker(_ status: CompletedEpicStatus) -> Marker {
        if status.canLand { return .ready }
        switch status.situation {
        case .landed: return .done
        case .ciFailed: return .failure
        case .conflicts, .error: return .warn
        case .preparing, .checking, .repairing, .ciRetrying, .landing: return .running
        default: return .open
        }
    }

    /// The epic issue's URL, built from a child issue's URL on the same forge.
    private static func parentURL(_ epic: CompletedEpic) -> URL? {
        guard let child = epic.children.first(where: { !$0.url.isEmpty })?.url else { return nil }
        let parent = child.replacingOccurrences(of: #"/\d+/?$"#, with: "/\(epic.parentIssueNumber)",
            options: .regularExpression)
        return URL(string: parent)
    }
}

/// The band around the cards: order, the "waiting on you" count and the shared formatting.
public enum CompletedEpicsBand {
    /// One row's identity across servers' frames and actions.
    public static func key(_ epic: CompletedEpic) -> String { "\(epic.repoPath)#\(epic.parentIssueNumber)" }

    /// Ready → your turn → nothing to do → done; the server's newest-first order breaks ties.
    public static func sorted(_ epics: [CompletedEpic], landing: Set<String> = []) -> [CompletedEpic] {
        epics.enumerated().sorted { a, b in
            let left = CompletedEpicStatus(a.element, landing: landing.contains(key(a.element))).sortOrder
            let right = CompletedEpicStatus(b.element, landing: landing.contains(key(b.element))).sortOrder
            return left != right ? left < right : a.offset < b.offset
        }.map(\.element)
    }

    public static func waiting(_ epics: [CompletedEpic], landing: Set<String> = []) -> Int {
        epics.filter { CompletedEpicStatus($0, landing: landing.contains(key($0))).needsOperator }.count
    }

    public static func title(count: Int) -> String { L.t("integrated_epics_band_title", String(count)) }

    public static func waitingLabel(_ count: Int) -> String {
        count == 1 ? L.t("native_epics_waiting_on_you_one") : L.t("integrated_epics_waiting_on_you", String(count))
    }

    /// The web's `formatAgo`: "45s", "12m", "3h", "6d".
    public static func ago(_ deltaMs: Int) -> String {
        let seconds = max(0, deltaMs / 1_000)
        if seconds < 60 { return "\(seconds)s" }
        let minutes = seconds / 60
        if minutes < 60 { return "\(minutes)m" }
        let hours = minutes / 60
        if hours < 24 { return "\(hours)h" }
        return "\(hours / 24)d"
    }
}
