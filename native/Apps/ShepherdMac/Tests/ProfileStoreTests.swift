import Foundation
import Testing
import ShepherdKit
@testable import Shepherd

struct ProfileStoreTests {
    /// A throwaway UserDefaults suite per test.
    private func makeDefaults() -> UserDefaults {
        let name = UUID().uuidString
        let defaults = UserDefaults(suiteName: name)!
        defaults.removePersistentDomain(forName: name)
        return defaults
    }

    private func profile(
        _ name: String, _ url: String, _ mode: ServerProfile.Mode = .remote
    ) -> ServerProfile {
        ServerProfile(
            id: UUID(), name: name, baseURL: URL(string: url)!, mode: mode,
            credentialKey: "run.shepherd.mac.\(name)")
    }

    @Test func emptyDefaultsLoadEmpty() {
        let store = ProfileStore(defaults: makeDefaults())
        let loaded = store.load()
        #expect(loaded.profiles.isEmpty)
        #expect(loaded.activeID == nil)
    }

    @Test func profilesRoundTrip() {
        let defaults = makeDefaults()
        let store = ProfileStore(defaults: defaults)
        let a = profile("Studio", "https://studio.example.ts.net")
        let b = profile("This Mac", "http://127.0.0.1:7330", .local)

        store.save(profiles: [a, b], activeID: b.id)

        let loaded = ProfileStore(defaults: defaults).load()
        #expect(loaded.profiles == [a, b])
        #expect(loaded.activeID == b.id)
    }

    @Test func activeIdIsDroppedWhenItsProfileIsGone() {
        let defaults = makeDefaults()
        let store = ProfileStore(defaults: defaults)
        let a = profile("Studio", "https://studio.example.ts.net")
        let b = profile("Other", "https://other.example.ts.net")

        store.save(profiles: [a, b], activeID: b.id)
        store.save(profiles: [a], activeID: b.id)

        #expect(store.load().activeID == nil)
    }

    @Test func corruptPayloadLoadsEmptyInsteadOfCrashing() {
        let defaults = makeDefaults()
        defaults.set(Data("not json".utf8), forKey: ProfileStore.profilesKey)
        defaults.set("not-a-uuid", forKey: ProfileStore.activeKey)

        let loaded = ProfileStore(defaults: defaults).load()
        #expect(loaded.profiles.isEmpty)
        #expect(loaded.activeID == nil)
    }

    @Test func savingEmptyClearsBothKeys() {
        let defaults = makeDefaults()
        let store = ProfileStore(defaults: defaults)
        store.save(profiles: [profile("Studio", "https://studio.example.ts.net")], activeID: nil)
        store.save(profiles: [], activeID: nil)

        #expect(defaults.data(forKey: ProfileStore.profilesKey) == nil)
        #expect(defaults.string(forKey: ProfileStore.activeKey) == nil)
    }
}
