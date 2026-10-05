import Foundation
import Testing
import ShepherdKit
@testable import ShepherdAppCore

extension CoreSeamTests {
    @MainActor
    struct MultiServerSignalTests {
        @Test func scopedCapacityReadsOwningSidebarAndDoesNotRewireLegacySignals() throws {
            let suite = "multi-signals.\(UUID())"
            let defaults = UserDefaults(suiteName: suite)!
            defer { defaults.removePersistentDomain(forName: suite); resetStreamSeams() }
            let credentials = InMemoryCredentialStore()
            func make(_ name: String, pct: Double) throws -> (AppModel, SessionStore) {
                let app = AppModel(defaults: defaults, credentials: credentials,
                    notifications: CoreTestSupport.environment(defaults: defaults), usesModelScopedSignals: true)
                CoreStreamInstallers.installReadOnlySidebar(into: app)
                let profile = ServerProfile(name: name, baseURL: URL(string: "https://\(name).fixture.invalid")!, mode: .remote)
                let store = try SessionStore(profile: profile, credentials: credentials)
                let sidebar = SidebarModel(store: store, app: app)
                app.liveExtensions = [(ObjectIdentifier(SidebarModel.self), sidebar)]
                store.reconcileUsageLimits(.init(session5h: .init(pct: pct, resetAt: 1_800_000_000_000), perModelWeek: [], stale: false, subscriptionOnly: false))
                return (app, store)
            }
            let legacy = UsageLimits(session5h: .init(pct: 42, resetAt: 1_800_000_000_000), perModelWeek: [], stale: false, subscriptionOnly: false)
            SessionSignals.usageLimits = { legacy }
            SessionSignals.workingBlocked = { ["same": true] }
            SessionSignals.gitMerged = { _ in true }
            SessionSignals.planQuestionsUnanswered = { _ in true }
            PlanSignals.planReviewing = { _ in true }
            let (a, storeA) = try make("a", pct: 95), (b, storeB) = try make("b", pct: 7)
            defer { a.teardown(); b.teardown(); storeA.stop(); storeB.stop() }
            #expect(SessionSignals.usageLimits(for: a)?.session5h?.pct == 95)
            #expect(SessionSignals.usageLimits(for: b)?.session5h?.pct == 7)
            #expect(SessionSignals.usageLimits()?.session5h?.pct == 42)
            #expect(SessionSignals.workingBlocked() == ["same": true])
            #expect(SessionSignals.gitMerged("same"))
            #expect(SessionSignals.planQuestionsUnanswered("same"))
            #expect(PlanSignals.planReviewing("same"))
            b.teardown()
            #expect(SessionSignals.usageLimits(for: a)?.session5h?.pct == 95)
            #expect(SessionSignals.usageLimits(for: b) == nil)
            #expect(!SessionSignals.planQuestionsUnanswered("same", for: a))
        }

        @Test func defaultModelRetainsLegacySignalAndInactiveDeactivationBehavior() {
            let suite = "multi-default.\(UUID())"
            let defaults = UserDefaults(suiteName: suite)!
            defer { defaults.removePersistentDomain(forName: suite); resetStreamSeams() }
            let app = AppModel(defaults: defaults, credentials: InMemoryCredentialStore(), notifications: CoreTestSupport.environment(defaults: defaults))
            #expect(!app.usesModelScopedSignals)
            #expect(app.authenticationQueue == nil)
            let limits = UsageLimits(perModelWeek: [], stale: false, subscriptionOnly: false)
            SessionSignals.usageLimits = { limits }
            SessionSignals.planQuestionsUnanswered = { _ in true }
            #expect(SessionSignals.usageLimits(for: app) != nil)
            #expect(SessionSignals.planQuestionsUnanswered("same", for: app))
            app.deactivate()
            #expect(app.activationGeneration == 0)
            app.deactivate(includingPendingActivation: true)
            #expect(app.activationGeneration == 1)
        }
    }
}
