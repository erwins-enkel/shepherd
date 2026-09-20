import Foundation
import SwiftUI
import Testing
import ShepherdKit
@testable import Shepherd
@Suite(.serialized) @MainActor struct MergeRegistrationTests {
    @Test func installsOnceAndPreservesEarlierSlots() throws {
        resetStreamSeams()
        let suite = "MergeRegistration-" + UUID().uuidString
        let defaults = UserDefaults(suiteName: suite)!
        defer {
            defaults.removePersistentDomain(forName: suite)
            SidebarSlot.reset(); ActionBarSlot.reset(); DetailTabRegistry.reset()
            CommandRegistry.reset()
        }
        let app = AppModel(defaults: defaults, credentials: InMemoryCredentialStore())
        defer { app.teardown() }
        var sidebarCalls = 0; var actionCalls = 0
        SidebarSlot.content = { _ in sidebarCalls += 1; return AnyView(EmptyView()) }
        ActionBarSlot.content = { _,_,_ in actionCalls += 1; return AnyView(EmptyView()) }
        MergeStream.installScene(); MergeStream.installScene()
        MergeStream.install(app); MergeStream.install(app)
        #expect(app.extensionFactories.count == 1)
        #expect(DetailTabRegistry.tabs.filter { $0.id == "merge" }.count == 1)
        #expect(CommandRegistry.commands(in: .session).filter { $0.id == "merge.overview" }.count == 1)
        _ = SidebarSlot.content?(app)
        #expect(sidebarCalls == 1)
        #expect(actionCalls == 0)
        let client = try ShepherdClient(profile: .init(name: "fixture",
            baseURL: URL(string: "http://127.0.0.1:1")!, mode: .local, credentialKey: "merge"),
            credentials: InMemoryCredentialStore())
        let store = SessionStore(client: client)
        _ = ActionBarSlot.content?(PreviewData.session(), store, app)
        #expect(actionCalls == 1)
        #expect(sidebarCalls == 1)
        #expect(app.extension(MergeModel.self) == nil)
        store.stop()
        app.teardown()
    }

    private func withApp(_ body: (AppModel) throws -> Void) rethrows {
        let suite = "MergeRegistration-" + UUID().uuidString
        let defaults = UserDefaults(suiteName: suite)!
        let app = AppModel(defaults: defaults, credentials: InMemoryCredentialStore())
        defer { app.teardown(); defaults.removePersistentDomain(forName: suite) }
        try body(app)
    }

    // Only open AnyView's erasure storage, never arbitrary model/reference fields.
    private func rendered<T>(_ value: Any, as type: T.Type, depth: Int = 0) -> [T] {
        guard depth < 30 else { return [] }
        if let result = value as? T { return [result] }
        let mirror = Mirror(reflecting: value)
        guard mirror.displayStyle != .class
            || String(reflecting: Swift.type(of: value)).contains("AnyViewStorage<") else { return [] }
        return mirror.children.flatMap { rendered($0.value, as: type, depth: depth + 1) }
    }

    @Test func completeInstallerPassAndSeamResetPreserveBothCompositions() async throws {
        resetStreamSeams()
        defer { resetStreamSeams() }
        let suite = "MergeReinstall-" + UUID().uuidString
        let defaults = try #require(UserDefaults(suiteName: suite))
        let app = AppModel(defaults: defaults, credentials: InMemoryCredentialStore())
        defer { app.teardown(); defaults.removePersistentDomain(forName: suite) }
        let client = try ShepherdClient(profile: .init(name: "fixture",
            baseURL: URL(string: "http://127.0.0.1:1")!, mode: .local, credentialKey: "merge"),
            credentials: InMemoryCredentialStore())
        let store = SessionStore(client: client)
        defer { store.stop() }
        let session = PreviewData.session()
        let queue = BuildQueue(sessionId: session.id, steps: [], approved: false)
        let model = MergeModel(reads: .init(snapshot: { .init(queues: [session.id: queue]) }))
        app.liveExtensions = [(ObjectIdentifier(MergeModel.self), model)]
        await model.refresh()

        // RootView repeats this real wave-1 pass for a second window. It replaces both
        // predecessor slots before S0's forthcoming S9 call composes them again.
        for pass in 0..<3 {
            if pass == 2 { resetStreamSeams() } // No S9-specific reset should be needed.
            StreamRegistrations.installAll(into: app)
            MergeStream.installScene()
            MergeStream.install(app)
            MergeStream.install(app) // Also remain idempotent without predecessors.
            let sidebar = try #require(SidebarSlot.content?(app))
            let actions = try #require(ActionBarSlot.content?(session, store, app))
            #expect(rendered(sidebar, as: MergeLauncher.self).count == 1)
            #expect(rendered(actions, as: Label<Text, Image>.self).count == 1)
            let command = try #require(CommandRegistry.commands(in: .session)
                .first { $0.id == "merge.overview" })
            model.showOverview = false
            command.action(app)
            #expect(model.showOverview)
            #expect(DetailTabRegistry.tabs.filter { $0.id == "merge" }.count == 1)
            #expect(app.extension(MergeModel.self) === model)
        }
    }

    @Test func fallbackStaysIntactUntilEarlierSidebarExists() {
        resetStreamSeams()
        defer { resetStreamSeams() }
        withApp { first in
            MergeStream.install(first)
            #expect(SidebarSlot.resolution == .fallback)
            #expect(ActionBarSlot.resolution == .fallback)
            #expect(first.extensionFactories.count == 1)
            #expect(DetailTabRegistry.tabs.filter { $0.id == "merge" }.count == 1)

            var renderedApps: [ObjectIdentifier] = []
            SidebarSlot.content = { app in
                renderedApps.append(ObjectIdentifier(app))
                return AnyView(EmptyView())
            }
            MergeStream.install(first)
            withApp { second in
                MergeStream.install(second); MergeStream.install(second)
                #expect(second.extensionFactories.count == 1)
                _ = SidebarSlot.content?(second)
                _ = SidebarSlot.content?(first)
                #expect(renderedApps == [ObjectIdentifier(second), ObjectIdentifier(first)])
            }
        }
    }

    @Test func sceneCommandResolvesTheCurrentModelWhenInvoked() throws {
        resetStreamSeams()
        defer { resetStreamSeams() }
        try withApp { app in
            MergeStream.installScene(); MergeStream.installScene()
            #expect(app.extensionFactories.isEmpty)
            #expect(SidebarSlot.resolution == .fallback)
            #expect(ActionBarSlot.resolution == .fallback)
            let command = try #require(CommandRegistry.commands(in: .session)
                .first { $0.id == "merge.overview" })
            #expect(command.order == 600)
            #expect(!command.isEnabled(app))
            command.action(app)

            // Inject inert models to test lookup without starting a store or network task.
            let first = MergeModel(reads: .init(snapshot: { .init() }))
            app.liveExtensions = [(ObjectIdentifier(MergeModel.self), first)]
            #expect(command.isEnabled(app))
            command.action(app)
            #expect(first.showOverview)
            first.showOverview = false
            app.tearDownExtensions()
            #expect(!command.isEnabled(app))
            let second = MergeModel(reads: .init(snapshot: { .init() }))
            app.liveExtensions = [(ObjectIdentifier(MergeModel.self), second)]
            command.action(app)
            #expect(second.showOverview)
            #expect(!first.showOverview)
        }
    }
}
