import Foundation
import SwiftUI
import Testing
import ShepherdKit
@testable import Shepherd
@Suite(.serialized) @MainActor struct MergeRegistrationTests {
    @Test func installsOnceAndPreservesEarlierSlots() throws {
        resetStreamSeams(); MergeStream.resetForTests()
        let suite = "MergeRegistration-" + UUID().uuidString
        let defaults = UserDefaults(suiteName: suite)!
        defer {
            defaults.removePersistentDomain(forName: suite)
            SidebarSlot.reset(); ActionBarSlot.reset(); DetailTabRegistry.reset()
            CommandRegistry.reset(); MergeStream.resetForTests()
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

    @Test func fallbackStaysIntactUntilEarlierSidebarExists() {
        resetStreamSeams(); MergeStream.resetForTests()
        defer { resetStreamSeams(); MergeStream.resetForTests() }
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
        resetStreamSeams(); MergeStream.resetForTests()
        defer { resetStreamSeams(); MergeStream.resetForTests() }
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
