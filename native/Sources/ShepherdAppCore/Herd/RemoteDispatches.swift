import Foundation
import Observation
import ShepherdKit

/// Tasks for a connected machine that are not settled (#2774, #2775), in words: its start status
/// is unknown or a cancel is on its way; it waits here for its machine, which is out of reach or
/// blocked; or the machine holds it, busy. The web's `ui/src/lib/remote-dispatches.ts` and
/// `remoteDispatchExplanation`, so a waiting task reads the same everywhere.
public enum DispatchCopy {
    /// Shown in the herd: not confirmed by its machine, waiting for it, or held there.
    public static func isShown(_ dispatch: RemoteDispatch) -> Bool {
        ["unknown", "canceling", "waiting", "held"].contains(dispatch.state.rawValue)
    }

    /// A waiting task its machine could not take even if it were reachable: a capability, the
    /// checkout or the platform is missing there.
    public static func isBlocked(_ dispatch: RemoteDispatch) -> Bool {
        dispatch.state.rawValue == "waiting"
            && ["missing_capabilities", "project_missing", "unreleased"].contains(dispatch.readiness?.state.rawValue ?? "")
    }

    /// Cancel is offered while it waits, is held there, or its start is unknown.
    public static func isCancelable(_ dispatch: RemoteDispatch) -> Bool {
        ["waiting", "unknown", "held"].contains(dispatch.state.rawValue)
    }

    /// How the state word reads: a standing condition Shepherd is resolving (unknown start,
    /// waiting), something to fix on the machine (blocked), or the machine's to settle (held,
    /// cancel pending).
    public enum Tone: Sendable { case resolving, blocked, settling }

    public static func tone(_ dispatch: RemoteDispatch) -> Tone {
        if isBlocked(dispatch) { return .blocked }
        return ["held", "canceling"].contains(dispatch.state.rawValue) ? .settling : .resolving
    }

    /// The state word a shown dispatch leads with.
    public static func label(_ dispatch: RemoteDispatch) -> String {
        switch dispatch.state.rawValue {
        case "canceling": L.t("remote_dispatch_canceling")
        case "held": L.t("remote_dispatch_held")
        case "waiting": isBlocked(dispatch) ? L.t("remote_dispatch_blocked") : L.t("remote_dispatch_waiting")
        default: L.t("remote_dispatch_unknown")
        }
    }

    /// "Xcode (license not accepted)", for each requirement the machine lacks.
    static func missingList(_ readiness: DispatchReadiness?) -> String {
        (readiness?.missing ?? []).map {
            "\(PlacementCopy.capabilityLabel($0.capability)) (\(PlacementCopy.reasonLabel($0.reason)))"
        }.joined(separator: ", ")
    }

    /// The short reason after the state word: what the task needs, what the machine lacks, or that
    /// the machine holds it. Nil for an unknown start or a pending cancel.
    public static func detail(_ dispatch: RemoteDispatch) -> String? {
        if dispatch.state.rawValue == "held" { return L.t("remote_dispatch_held_detail") }
        guard dispatch.state.rawValue == "waiting" else { return nil }
        switch dispatch.readiness?.state.rawValue {
        case "missing_capabilities": return L.t("remote_dispatch_missing_detail", missingList(dispatch.readiness))
        case "project_missing": return L.t("remote_dispatch_project_detail")
        case "unreleased": return L.t("remote_dispatch_unreleased_detail")
        case "ready": return L.t("remote_dispatch_ready_detail")
        default: return dispatch.placement.map(PlacementCopy.reason)
        }
    }

    /// "Run on MacBook" — every machine by its name, the one that placed the task included.
    public static func redirectLabel(_ host: SessionHost) -> String {
        L.t("remote_dispatch_run_on", host.name)
    }

    /// What the herd says about a shown dispatch that resolved; `alert` for one that did not
    /// start. A waiting task taken to run elsewhere says nothing: its session shows up instead.
    public static func resolved(_ dispatch: RemoteDispatch) -> DispatchNotice? {
        let machine = dispatch.host.name
        switch dispatch.state.rawValue {
        case "started": return .init(text: L.t("toast_dispatch_started_on", machine), alert: false)
        case "held": return .init(text: L.t("toast_task_held_on", machine), alert: false)
        case "canceled": return .init(text: L.t("toast_dispatch_canceled_on", machine), alert: false)
        case "rejected", "upload_failed":
            return .init(text: L.t("toast_dispatch_declined_on", machine, dispatch.reason ?? dispatch.code ?? ""),
                         alert: true)
        default: return nil
        }
    }

    /// What the state means and what happens next: the four states the herd keeps apart, and a
    /// pending cancel.
    public static func explanation(_ dispatch: RemoteDispatch) -> RemoteExplanation {
        let machine = dispatch.host.name
        switch dispatch.state.rawValue {
        case "waiting": return waitingExplanation(dispatch)
        case "held":
            return RemoteExplanation(
                title: L.t("tooltip_held_title", machine), summary: L.t("tooltip_held_summary", machine),
                sections: [
                    .init(label: L.t("tooltip_waiting_start"), text: L.t("tooltip_held_start_body", machine)),
                    .init(label: L.t("tooltip_dispatch_cancel"), text: L.t("tooltip_held_cancel_body", machine)),
                    .init(label: L.t("tooltip_held_elsewhere"), text: L.t("tooltip_held_elsewhere_body")),
                ])
        case "canceling":
            return RemoteExplanation(
                title: L.t("remote_dispatch_canceling"), summary: L.t("tooltip_dispatch_canceling_summary", machine),
                sections: [.init(label: L.t("tooltip_dispatch_until"), text: L.t("tooltip_dispatch_until_body", machine))])
        default:
            return RemoteExplanation(
                title: L.t("remote_dispatch_unknown"), summary: L.t("tooltip_dispatch_unknown_summary", machine),
                sections: [
                    .init(label: L.t("tooltip_dispatch_check"), text: L.t("tooltip_dispatch_check_body", machine)),
                    .init(label: L.t("tooltip_dispatch_once"), text: L.t("tooltip_dispatch_once_body", machine)),
                    .init(label: L.t("tooltip_dispatch_cancel"), text: L.t("tooltip_dispatch_cancel_body", machine)),
                ])
        }
    }

    private static func waitingExplanation(_ dispatch: RemoteDispatch) -> RemoteExplanation {
        let machine = dispatch.host.name
        let fallback = RemoteExplanation.Section(
            label: L.t("tooltip_waiting_fallback"), text: PlacementCopy.noFallback(dispatch.alternatives))
        let cancel = RemoteExplanation.Section(
            label: L.t("tooltip_dispatch_cancel"), text: L.t("tooltip_waiting_cancel_body", machine))
        if isBlocked(dispatch) {
            let summary = switch dispatch.readiness?.state.rawValue {
            case "missing_capabilities":
                L.t("tooltip_blocked_missing_summary", machine, missingList(dispatch.readiness))
            case "project_missing": L.t("tooltip_blocked_project_summary", machine)
            default: L.t("tooltip_blocked_unreleased_summary", machine)
            }
            return RemoteExplanation(
                title: L.t("tooltip_blocked_title", machine), summary: summary,
                sections: [.init(label: L.t("tooltip_blocked_next"), text: L.t("tooltip_blocked_next_body", machine)),
                           fallback, cancel])
        }
        let ready = dispatch.readiness?.state.rawValue == "ready"
        let reason = dispatch.placement.map(PlacementCopy.reason) ?? ""
        let connection = RemoteExplanation.Section(
            label: L.t("tooltip_waiting_connection"), text: PlacementCopy.offlineLabel(dispatch.readiness?.status))
        let start = RemoteExplanation.Section(
            label: L.t("tooltip_waiting_start"), text: L.t("tooltip_waiting_start_body", machine))
        return RemoteExplanation(
            title: L.t("tooltip_waiting_title", machine),
            summary: ready ? L.t("tooltip_waiting_ready_summary", machine)
                : L.t("tooltip_waiting_offline_summary", machine, reason),
            sections: (ready ? [] : [connection]) + [start, fallback, cancel])
    }
}

/// A one-line outcome the herd shows above its groups: how a task for a machine ended, or what
/// a cancel or a redirect did.
public struct DispatchNotice: Equatable, Sendable {
    public let text: String
    public let alert: Bool

    public init(text: String, alert: Bool) {
        self.text = text
        self.alert = alert
    }
}

/// The tasks for connected machines that are not settled, for this server's herd (#2776). Lists
/// them (`GET /api/remote-dispatches`) on activation and on every reconnect — `remote:dispatch` is
/// push-on-change only, so a change while the socket was down is only seen by reading again —
/// and keeps them live from `remote:dispatch`. A server that predates them lists nothing.
@Observable @MainActor
public final class RemoteDispatchesModel: AppExtension {
    struct Reads: Sendable {
        var list: @Sendable () async throws -> [RemoteDispatch]
        var cancel: @Sendable (String) async throws -> RemoteDispatchCancel
        var redirect: @Sendable (String, String) async throws -> CreateOutcome

        static func live(_ client: ShepherdClient) -> Reads {
            Reads(list: { try await client.remoteDispatches() },
                  cancel: { try await client.cancelRemoteDispatch(id: $0) },
                  redirect: { try await client.redirectRemoteDispatch(id: $0, to: $1) })
        }
    }

    /// Oldest first, as the server lists them.
    public private(set) var dispatches: [RemoteDispatch] = []
    public private(set) var notice: DispatchNotice?
    /// Dispatches with a cancel or a redirect in flight.
    public private(set) var busy: Set<String> = []
    /// Cancel and redirect write; a read-only launch only shows the states.
    public let actionsAllowed: Bool

    @ObservationIgnored private let reads: Reads
    @ObservationIgnored private weak var store: SessionStore?
    @ObservationIgnored private var tap: Task<Void, Never>?
    @ObservationIgnored private var watcher: Task<Void, Never>?
    @ObservationIgnored private var connectionSignal: AsyncStream<Void>.Continuation?
    @ObservationIgnored private var refreshTask: Task<Void, Never>?
    @ObservationIgnored private var refreshPending = false
    @ObservationIgnored private var tornDown = false
    /// Frames that arrived while a list read was out, replayed over its answer.
    @ObservationIgnored private var duringRead: [RemoteDispatch]?

    public init(store: SessionStore, app: AppModel) {
        reads = .live(store.client)
        actionsAllowed = app.liveRequestAudit == nil
        self.store = store
        subscribe(store)
        watchConnection(store)
    }

    /// Test seam: no store, no socket, no automatic read.
    init(reads: Reads, actionsAllowed: Bool = true) {
        self.reads = reads
        self.actionsAllowed = actionsAllowed
    }

    public func teardown() {
        tornDown = true
        tap?.cancel(); tap = nil
        connectionSignal?.finish(); connectionSignal = nil
        watcher?.cancel(); watcher = nil
        refreshTask?.cancel(); refreshTask = nil
    }

    public func dismissNotice() { notice = nil }

    private func subscribe(_ store: SessionStore) {
        let events = store.events()
        tap = Task { [weak self] in
            for await event in events {
                guard let self, !self.tornDown else { return }
                if case .unknown(let name, let payload) = event, name == "remote:dispatch", let payload,
                   let dispatch = try? JSONDecoder().decode(RemoteDispatch.self, from: payload) {
                    self.apply(dispatch)
                }
            }
        }
    }

    /// Reads the list on activation and again on every connection that comes back live.
    private func watchConnection(_ store: SessionStore) {
        let (changes, signal) = AsyncStream<Void>.makeStream(bufferingPolicy: .bufferingNewest(1))
        connectionSignal = signal
        watcher = Task { @MainActor [weak self, weak store] in
            var iterator = changes.makeAsyncIterator()
            var wasLive = false
            while !Task.isCancelled {
                guard let self, !self.tornDown, let store else { return }
                let live = store.connection == .live
                if live, !wasLive { self.requestRefresh() }
                wasLive = live
                withObservationTracking { _ = store.connection } onChange: { signal.yield() }
                guard await iterator.next() != nil else { return }
                // Observation fires before the property's write finishes.
                await Task.yield()
            }
        }
    }

    private func requestRefresh() {
        refreshPending = true
        guard refreshTask == nil else { return }
        refreshTask = Task { [weak self] in
            while let self, self.refreshPending, !self.tornDown, !Task.isCancelled {
                self.refreshPending = false
                await self.refresh()
            }
            self?.refreshTask = nil
        }
    }

    /// Replaces the list with the server's; frames that arrive meanwhile are applied on top of it.
    func refresh() async {
        guard !tornDown else { return }
        duringRead = []
        defer { duringRead = nil }
        do {
            let listed = try await reads.list()
            guard !tornDown else { return }
            let late = duringRead ?? []
            dispatches = listed.filter(DispatchCopy.isShown)
            for dispatch in late { dispatches = Self.reduce(dispatches, dispatch).list }
        } catch {
            // A server without remote dispatches has none to show; any other failure keeps the
            // last list until the next read.
            if error as? ShepherdError == .notFound { dispatches = [] }
        }
    }

    /// A `remote:dispatch` frame, or what a cancel answered: a shown dispatch that resolved leaves
    /// the herd and says how it ended.
    func apply(_ dispatch: RemoteDispatch) {
        duringRead?.append(dispatch)
        let (list, resolved) = Self.reduce(dispatches, dispatch)
        dispatches = list
        if let resolved, let message = DispatchCopy.resolved(resolved) { notice = message }
    }

    /// The list after `dispatch` changed, and the dispatch it resolved — one that was shown and is
    /// settled now. A settled one that was not shown changes nothing.
    static func reduce(_ list: [RemoteDispatch], _ dispatch: RemoteDispatch)
        -> (list: [RemoteDispatch], resolved: RemoteDispatch?)
    {
        let shown = list.contains { $0.id == dispatch.id }
        if DispatchCopy.isShown(dispatch) {
            return (shown ? list.map { $0.id == dispatch.id ? dispatch : $0 } : list + [dispatch], nil)
        }
        return shown ? (list.filter { $0.id != dispatch.id }, dispatch) : (list, nil)
    }

    /// Makes sure it never starts on its machine. A machine out of reach gets the cancel as soon
    /// as it answers; one that already has the task cannot be canceled any more.
    public func cancel(_ dispatch: RemoteDispatch) async {
        guard actionsAllowed, busy.insert(dispatch.id).inserted else { return }
        defer { busy.remove(dispatch.id) }
        let machine = dispatch.host.name
        do {
            switch try await reads.cancel(dispatch.id) {
            case .canceled(let now):
                apply(now)
            case .pending(let now):
                apply(now)
                notice = .init(text: L.t("toast_dispatch_cancel_pending", machine), alert: false)
            }
        } catch let conflict as RemoteDispatchConflict {
            if let now = conflict.dispatch { apply(now) }
            notice = .init(text: L.t("toast_dispatch_not_cancelable", machine), alert: true)
        } catch {
            notice = .init(text: L.t("toast_dispatch_cancel_failed"), alert: true)
        }
    }

    /// Runs a waiting task on `host` now. A machine that does not fit is refused with the reason,
    /// and the task keeps waiting.
    public func redirect(_ dispatch: RemoteDispatch, to host: SessionHost) async {
        guard actionsAllowed, busy.insert(dispatch.id).inserted else { return }
        defer { busy.remove(dispatch.id) }
        do {
            switch try await reads.redirect(dispatch.id, host.instanceId) {
            case .created:
                notice = .init(text: L.t("toast_dispatch_started_on", host.name), alert: false)
            case .held(let held):
                notice = .init(text: PlacementCopy.held(held), alert: false)
            }
        } catch {
            let why = PlacementCopy.failure(error, machine: host.name) ?? L.t("toast_dispatch_redirect_failed")
            notice = .init(text: why, alert: true)
        }
    }

    #if DEBUG
        /// Stands in for the server's list in previews and tests.
        func install(_ list: [RemoteDispatch]) { dispatches = list }
    #endif
}
