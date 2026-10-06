import Foundation
import Testing
import ShepherdKit
@testable import ShepherdAppCore

extension CoreSeamTests {
    @MainActor
    struct MultiServerPersistenceTests {
        @Test func scopedActivationsNeverOverwriteTheSharedCatalogue() async throws {
            let suite = "ios-multi-core.\(UUID())"
            let defaults = UserDefaults(suiteName: suite)!
            defer { defaults.removePersistentDomain(forName: suite) }
            let credentials = InMemoryCredentialStore()
            func app(_ key: String, writer: Bool = false) -> AppModel {
                let model = AppModel(defaults: defaults, credentials: credentials,
                    notifications: CoreTestSupport.environment(defaults: defaults),
                    activeProfileKey: key, persistsProfileCatalogue: writer)
                model.credentialProbe = { _, _ in StoredCredential(token: "test", tokenId: "test") }
                model.health = { _ in throw ShepherdError.transport("fixture") }
                return model
            }
            let catalogue = app("catalogue", writer: true)
            let a = try catalogue.addRemoteProfile(name: "A", address: "https://a.fixture.invalid")
            let first = app("active-a")
            let b = try catalogue.addRemoteProfile(name: "B", address: "https://b.fixture.invalid")
            let second = app("active-b")
            first.reloadProfiles()
            await first.activate(a)
            await second.activate(b)
            #expect(first.store !== second.store)
            #expect(defaults.string(forKey: "active-a") == a.id.uuidString)
            #expect(defaults.string(forKey: "active-b") == b.id.uuidString)
            #expect(ProfileStore(defaults: defaults).load().profiles == [a, b])
            first.deactivate()
            #expect(defaults.string(forKey: "active-b") == b.id.uuidString)
            #expect(ProfileStore(defaults: defaults).load().profiles == [a, b])
            second.deactivate()
        }
        @Test func readonlyCatalogueCannotResurrectARemovedProfile() {
            let suite = "ios-multi-core.\(UUID())"
            let defaults = UserDefaults(suiteName: suite)!
            defer { defaults.removePersistentDomain(forName: suite) }
            let writer = ProfileStore(defaults: defaults)
            let profile = ServerProfile(name: "A", baseURL: URL(string: "https://a.fixture.invalid")!, mode: .remote, credentialKey: "a")
            writer.save(profiles: [profile], activeID: profile.id)
            let reader = ProfileStore(defaults: defaults, activeKey: "scoped", persistsCatalogue: false)
            let stale = reader.load().profiles
            writer.save(profiles: [], activeID: nil)
            reader.save(profiles: stale, activeID: profile.id)
            #expect(writer.load().profiles.isEmpty)
            #expect(defaults.string(forKey: ProfileStore.activeKey) == nil)
        }
    }
}
