import ShepherdKit

/// Explicit reconciliation for read-only hosts after suspension, even when the socket
/// remains live. Concurrent foreground and pull-to-refresh callers share one read.
@MainActor
public final class ReadOnlySidebarRecovery: AppExtension {
    private let reconcile: @MainActor () async -> Void
    private let isCurrent: @MainActor () -> Bool
    private var pending: Task<Void, Never>?
    private var generation = 0
    private var stopped = false

    public init(store: SessionStore, app: AppModel) {
        let activation = app.activationGeneration
        isCurrent = { [weak app, weak store] in
            guard let app, let store else { return false }
            return app.activationGeneration == activation && app.store === store
        }
        reconcile = { [weak app] in
            guard let app, app.activationGeneration == activation else { return }
            // Capture this activation's models before yielding. Each model fences its own
            // snapshot commits against teardown and profile changes.
            let sidebar = app.extension(SidebarModel.self)
            let herd = app.extension(HerdSignals.self)
            let plan = app.extension(PlanModel.self)
            let queues = app.extension(QueuesModel.self)
            let merge = app.extension(MergeModel.self)
            let actions = app.extension(ActionsModel.self)
            await Self.readSnapshots(sidebar: sidebar, herd: herd, plan: plan,
                queues: queues, merge: merge, actions: actions)
        }
    }

    init(isCurrent: @escaping @MainActor () -> Bool = { true },
         reconcile: @escaping @MainActor () async -> Void) {
        self.isCurrent = isCurrent
        self.reconcile = reconcile
    }

    static func readSnapshots(sidebar: SidebarModel?, herd: HerdSignals?, plan: PlanModel?,
                              queues: QueuesModel?, merge: MergeModel?, actions: ActionsModel?) async {
        async let s: Void? = sidebar?.refresh()
        async let h: Void? = herd?.refresh()
        async let p: Void? = plan?.refresh()
        async let q: Void? = queues?.refresh(recomputeUpNext: false, readOnly: true)
        async let m: Void? = merge?.refresh()
        async let a: Void? = actions?.refresh()
        _ = await (s, h, p, q, m, a)
    }

    public func refresh() async {
        guard !stopped, isCurrent(), !Task.isCancelled else { return }
        if let pending { await pending.value; return }
        let mine = generation
        let work = Task { [weak self] in
            guard let self, !self.stopped, self.generation == mine,
                  self.isCurrent(), !Task.isCancelled else { return }
            await self.reconcile()
        }
        pending = work
        await work.value
        if generation == mine { pending = nil }
    }

    public func teardown() {
        stopped = true
        generation &+= 1
        pending?.cancel()
        pending = nil
    }
}
