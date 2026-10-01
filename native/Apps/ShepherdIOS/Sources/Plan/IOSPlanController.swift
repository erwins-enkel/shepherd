import Observation
import ShepherdAppCore
import ShepherdKit

/// One request/draft owner per session for the whole store activation, including tab changes.
@MainActor
final class IOSPlanController: AppExtension {
    private var presentations: [String: IOSPlanPresentation] = [:]
    private let makePresentation: @MainActor (Session, PlanModel) -> IOSPlanPresentation
    private(set) var entrySessionID: String?
    private(set) var entryOpensPlan = false

    required init(store: SessionStore, app: AppModel) {
        let activation = app.activationGeneration
        makePresentation = { [weak app, weak store] session, model in
            // The controller is activation-owned, so these exist while a view can resolve it.
            guard let app, let store else { preconditionFailure("Plan activation ended") }
            return IOSPlanPresentation(session: session, model: model,
                writer: .live(store.client), answerWriter: .live(session: session, store: store, app: app),
                current: { [weak app, weak store] in
                    guard let app, let store else { return false }
                    return app.activationGeneration == activation && app.store === store
                        && app.allowsTerminalInput && app.liveRequestAudit == nil
                        && store.connection == .live
                        && Self.isWritable(store.session(id: session.id))
                        && CurrentSessionSelection.isCurrent(session: session, store: store, app: app)
                }, sendSteer: { text in try await store.client.replySession(id: session.id, text: text) })
        }
    }

    /// Uses the same ownership path with deterministic request writers in tests.
    init(makePresentation: @escaping @MainActor (Session, PlanModel) -> IOSPlanPresentation) {
        self.makePresentation = makePresentation
    }

    static func isWritable(_ liveSession: Session?) -> Bool {
        guard let liveSession else { return false }
        return liveSession.status.known != .archived && liveSession.archivedAt == nil
    }

    func presentation(for session: Session, model: PlanModel) -> IOSPlanPresentation {
        if let existing = presentations[session.id] { return existing }
        let value = makePresentation(session, model)
        presentations[session.id] = value
        return value
    }

    func select(_ session: Session?, model: PlanModel?) {
        entrySessionID = session?.id
        entryOpensPlan = session.flatMap { session in
            model.map { IOSPlanPresentation.opensPlan(session: session, model: $0) }
        } ?? false
    }

    func teardown() {
        for presentation in presentations.values { presentation.teardown() }
        presentations.removeAll()
        entrySessionID = nil
        entryOpensPlan = false
    }
}

/// Initial entry belongs to the current selection gesture; historical ticks are only a baseline.
struct IOSPlanNavigation {
    private var entered = false
    private var consumedTick = 0

    mutating func enter(opensPlan: Bool, tick: Int) -> Bool {
        guard !entered else { return false }
        entered = true
        consumedTick = tick
        return opensPlan
    }

    mutating func consume(tick: Int) -> Bool {
        guard entered, tick > consumedTick else { return false }
        consumedTick = tick
        return true
    }
}
