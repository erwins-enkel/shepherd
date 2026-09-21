import Foundation
import ShepherdKit

/// A per-stream sub-model owned by `AppModel`.
///
/// Built in `activate(_:)` once the `SessionStore` exists, torn down in
/// `teardown()` — and at the top of the next `activate(_:)` — before that store
/// stops. It therefore never outlives its store, which is the point: it may hold
/// the store strongly without keeping a dead activation alive.
///
/// `AnyObject` because an extension holds tasks and observable state. Conform
/// with a `final class`: a non-final one would need `required init`.
///
/// **Async work is the extension's own problem.** Anything that suspends must
/// capture `app.activationGeneration` before the first `await` and drop its
/// result once that value has moved on, exactly as `AppModel`'s own async steps
/// do. `teardown()` is synchronous and must cancel, not await.
@MainActor
public protocol AppExtension: AnyObject {
    init(store: SessionStore, app: AppModel)
    /// Cancel tasks, drop observers, release the store. Called exactly once.
    func teardown()
}

extension AppModel {
    /// Records `type` so every future activation builds one, and builds one now if
    /// a store is already live.
    ///
    /// Idempotent per type. Building immediately matters because
    /// `StreamRegistrations.installAll(into:)` runs from a view task, which can
    /// land after a restored profile has already activated — without it that
    /// launch would silently have no extensions.
    ///
    /// A type registered this way is built against a store that may already
    /// have published events the extension never saw — it must reconcile from
    /// the store's current state rather than assume it starts at the
    /// beginning, exactly as `makeExtensions(store:)`'s own instances would
    /// after a relaunch.
    public func register<E: AppExtension>(_ type: E.Type) {
        let key = ObjectIdentifier(type)
        guard !extensionFactories.contains(where: { $0.key == key }) else { return }
        extensionFactories.append((key, { store, app in E(store: store, app: app) }))
        if let store {
            liveExtensions.append((key, E(store: store, app: self)))
        }
    }

    /// The live instance for `type`, or `nil` when nothing is active. Backticks
    /// because `extension` is a keyword — Appendix B's spelling is kept.
    public func `extension`<E: AppExtension>(_ type: E.Type) -> E? {
        let key = ObjectIdentifier(type)
        guard let entry = liveExtensions.first(where: { $0.key == key }) else { return nil }
        // The key is `type`'s own `ObjectIdentifier`, and every entry with
        // that key was built as exactly `E` by `register`/`makeExtensions` —
        // a mismatch here means the registry itself is corrupted, which is
        // worth crashing on rather than silently returning `nil`.
        return (entry.value as! E)
    }

    /// One instance per registered type, in registration order. Called by
    /// `activate(_:)` right after `self.store` is set — always onto an empty
    /// registry, since `tearDownExtensions()` runs before every store change.
    /// A build that finds a live instance already there means a `tearDownExtensions()`
    /// call was skipped somewhere along the way, which would let an extension
    /// bound to the outgoing store leak into the next activation.
    func makeExtensions(store: SessionStore) {
        precondition(
            liveExtensions.isEmpty,
            "extensions must be torn down before a new store")
        for factory in extensionFactories {
            liveExtensions.append((factory.key, factory.make(store, self)))
        }
    }

    /// Tears live instances down in reverse creation order, so an extension built
    /// on top of an earlier one goes first. Called by `activate(_:)` and
    /// `teardown()` immediately before `store?.stop()`.
    func tearDownExtensions() {
        for entry in liveExtensions.reversed() { entry.value.teardown() }
        liveExtensions.removeAll()
    }
}
