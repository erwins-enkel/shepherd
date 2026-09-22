import Foundation
import ShepherdKit

// Short names for the three generated schemas this stream reads. ShepherdKit's own
// `Model/PublicTypes.swift` aliases only the ten types the app already used (`Session`,
// `SessionStatus`, `Settings`, …) and is S0-owned, so these three live here instead. They are
// typealiases, not wrappers: still one definition each, still from the contract, and the
// generator's `accessModifier: public` makes `Components.Schemas.*` visible from this target.
// Without them the bare names `BlockReason`, `AutoMergeStatus` and `UsageLimits` do not resolve.
public typealias BlockReason = Components.Schemas.BlockReason
typealias AutoMergeStatus = Components.Schemas.AutoMergeStatus
public typealias UsageLimits = Components.Schemas.UsageLimits

/// The toggle a notification rides. Mirrors `PushCategory` in `src/push.ts`; the web's third
/// category, `reviews`, has no native trigger yet because its events are not in the contract.
public enum NotificationCategory: String, CaseIterable, Sendable {
    case agent
    case ci

    public var label: String {
        switch self {
        case .agent: L.t("settings_push_cat_agent")
        case .ci: L.t("settings_push_cat_ci")
        }
    }
}

/// What a notification is about. One case per `NotifyInput.kind` this stream can derive from the
/// events the contract declares.
enum NotificationKind: Sendable, Equatable {
    case done
    case blocked
    case ready
    case mergeError
    case rebaseCap
    case manualSteps
    case usageLimit

    /// The web's `kind` string, so the cooldown key reads the same on both sides and a log line
    /// from either is comparable.
    var id: String {
        switch self {
        case .done: "done"
        case .blocked: "blocked"
        case .ready: "ready"
        case .mergeError: "merge_error"
        case .rebaseCap: "rebase_cap"
        case .manualSteps: "manual_steps"
        case .usageLimit: "usage_limit"
        }
    }

    /// `KIND_CATEGORY` in `src/push.ts`.
    ///
    /// Every kind rides its toggle, `ready` included — which is where this port deliberately
    /// parts company with `PushService.notify`'s
    /// `if (input.kind !== "ready" && !row.cats[category]) continue;`. The web's `ready` push is
    /// fired by `ReadyNotifier.tick`, which returns immediately unless `config.reducedPushMode`
    /// is on (`src/ready-notify.ts`); the exemption is what keeps that one reduced-mode signal
    /// reaching a device whose toggles are already being ignored. This port has no reduced mode
    /// and fires `ready` off the operator's **manual** ready-to-merge toggle
    /// (`POST /api/sessions/{id}/ready`), so inheriting the exemption would hand an operator who
    /// muted "Agent activity" an un-muteable banner announcing something they had just done
    /// themselves.
    var category: NotificationCategory {
        switch self {
        case .done, .blocked, .ready, .usageLimit: .agent
        case .mergeError, .rebaseCap, .manualSteps: .ci
        }
    }

    /// The suffix a **host-global** intent's cooldown key carries — one that names no session.
    /// The web has two such keys and they are distinct (`usage_limit:5h` and
    /// `usage_limit:credits` in `src/push.ts`), so the suffix is derived per kind rather than
    /// fixed: a second host-global kind must not silently share the usage warning's 120 s
    /// window. Exhaustive on purpose — a new kind does not compile until someone decides.
    var hostGlobalScope: String {
        switch self {
        case .usageLimit: "5h"
        // None of these is ever host-global today — they all name a session — so the suffix is
        // only a safe placeholder. It is deliberately not `"5h"`: the day one of them does
        // arrive without a session id, it must not land in the 5-hour window's bucket.
        case .done, .blocked, .ready, .mergeError, .rebaseCap, .manualSteps: "host"
        }
    }
}

/// Which hold line a `blocked` notification's body uses. A copy of `BlockShape` from
/// `src/blocked.ts` plus the `generic` fallback `blockReasonToHoldCode` falls back to.
enum BlockShapeCopy: Equatable, Sendable {
    case menu
    case yesNo
    case awaitingInput
    case stall
    case quota(QuotaKindCopy?)
    case generic
}

/// `BlockReason.quotaKind` from `src/blocked.ts`.
enum QuotaKindCopy: String, Equatable, Sendable {
    case rework
    case review
    case error
    case plan
}

/// One notification, described by intent rather than by text — exactly as the server's
/// `NotifyInput` is, and for the same reason: the text is a function of the operator's locale,
/// which is resolved at render time.
struct NotificationIntent: Equatable, Sendable {
    let kind: NotificationKind
    /// The session to select when the banner is clicked. `nil` for the host-global usage warning.
    let sessionID: String?
    /// What the copy names: a session's display name, or the merge train's designation.
    let subject: String
    let blockShape: BlockShapeCopy?
    let pct: Int?
    let resetAt: Int?

    init(
        kind: NotificationKind,
        sessionID: String?,
        subject: String,
        blockShape: BlockShapeCopy? = nil,
        pct: Int? = nil,
        resetAt: Int? = nil
    ) {
        self.kind = kind
        self.sessionID = sessionID
        self.subject = subject
        self.blockShape = blockShape
        self.pct = pct
        self.resetAt = resetAt
    }

    /// `input.cooldownKey ?? \`${kind}:${sessionId}\`` in `PushService.notify`. An intent with
    /// no session id is host-global and takes its suffix from the kind — the usage warning gets
    /// the web's own `usage_limit:5h`. See `NotificationKind.hostGlobalScope`.
    var cooldownKey: String {
        guard let sessionID else { return "\(kind.id):\(kind.hostGlobalScope)" }
        return "\(kind.id):\(sessionID)"
    }

    /// The `tag` the service worker passes to the Notification API — macOS's equivalent is the
    /// thread identifier, which groups a session's banners in Notification Centre.
    var threadIdentifier: String { sessionID ?? "usage-5h" }
}

/// Title and body for an intent. Pure and synchronous, so every line is assertable without
/// hosting a view or touching `UNUserNotificationCenter`.
enum NotificationCopy {
    static func title(_ intent: NotificationIntent) -> String {
        switch intent.kind {
        case .done: L.t("native_notify_done_title", intent.subject)
        case .blocked: L.t("native_notify_blocked_title", intent.subject)
        case .ready: L.t("native_notify_ready_title", intent.subject)
        case .manualSteps: L.t("native_notify_manual_steps_title", intent.subject)
        case .mergeError: L.t("native_notify_merge_error_title")
        case .rebaseCap: L.t("native_notify_rebase_cap_title")
        // String, not Int: `gen-strings.ts` renders every placeholder as `%1$@`, and handing
        // `String(format:)` an Int for an object conversion is undefined behaviour.
        case .usageLimit: L.t("native_notify_usage_title", String(intent.pct ?? 0))
        }
    }

    static func body(
        _ intent: NotificationIntent,
        locale: Locale = .current
    ) -> String {
        switch intent.kind {
        case .done: return L.t("native_notify_done_body")
        case .ready: return L.t("native_notify_ready_body")
        case .manualSteps: return L.t("native_notify_manual_steps_body")
        case .mergeError: return L.t("native_notify_merge_error_body", intent.subject)
        case .rebaseCap: return L.t("native_notify_rebase_cap_body", intent.subject)
        case .blocked: return holdLine(for: intent.blockShape)
        case .usageLimit:
            guard let resetAt = intent.resetAt else { return L.t("native_notify_usage_body") }
            let time = Date(timeIntervalSince1970: Double(resetAt) / 1_000)
                .formatted(.dateTime.hour().minute().locale(locale))
            return L.t("native_notify_usage_body_reset", time)
        }
    }

    /// `blockReasonToHoldCode` + `renderHold` from `src/hold.ts`, reusing the identical catalog
    /// lines the web's hold row already renders.
    private static func holdLine(for shape: BlockShapeCopy?) -> String {
        switch shape {
        case .menu: L.t("hold_blocked_menu")
        case .yesNo: L.t("hold_blocked_yes_no")
        case .awaitingInput: L.t("hold_blocked_awaiting_input")
        case .stall: L.t("hold_blocked_stall")
        case .quota(.rework): L.t("hold_quota_rework")
        case .quota(.review): L.t("hold_quota_review")
        case .quota(.error): L.t("hold_quota_error")
        case .quota(.plan): L.t("hold_quota_plan")
        case .quota(nil), .generic, nil: L.t("hold_blocked_generic")
        }
    }

    /// Reads the contract's two open enums off a `BlockReason`. A shape or kind this build has
    /// never heard of degrades to the generic line rather than dropping the notification: the
    /// operator still needs to know the agent stopped.
    static func blockShape(of block: BlockReason) -> BlockShapeCopy {
        switch block.shape.value1 {
        case .menu: return .menu
        case .yesNo: return .yesNo
        case .awaitingInput: return .awaitingInput
        case .stall: return .stall
        case .quota:
            switch block.quotaKind?.value1 {
            case .rework: return .quota(.rework)
            case .review: return .quota(.review)
            case .error: return .quota(.error)
            case .plan: return .quota(.plan)
            case nil: return .quota(nil)
            }
        case nil: return .generic
        }
    }
}
