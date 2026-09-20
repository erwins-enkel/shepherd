import Foundation
import Testing

@testable import Shepherd

/// Removes the private `UserDefaults` suites a test created once that test's suite value goes
/// away. Deliberately not isolated: a `deinit` may run on any thread, and `UserDefaults` is
/// thread-safe.
private final class ScratchSuites {
    var names: [String] = []

    deinit {
        for name in names {
            UserDefaults.standard.removePersistentDomain(forName: name)
            UserDefaults.standard.removeSuite(named: name)
        }
    }
}

@MainActor
struct NotificationSettingsTests {
    /// Swift Testing builds a fresh suite value per test and releases it when the test ends, so
    /// this box's `deinit` is the nearest thing a `struct` suite has to a teardown hook. Every
    /// scratch domain handed out below is emptied and unregistered there.
    private let suites = ScratchSuites()

    /// A throwaway `UserDefaults` suite per test, emptied on the way in and removed on the way
    /// out — the house pattern every sibling app-target suite follows (`ProfileStoreTests`,
    /// `AppModelTests`, `LiveServerTests`, …). Without the removal each run left a
    /// `run.shepherd.mac.notifytests.<uuid>` domain behind on the machine, one per test that
    /// wrote anything.
    private func scratch() -> UserDefaults {
        let name = "run.shepherd.mac.notifytests.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: name)!
        defaults.removePersistentDomain(forName: name)
        suites.names.append(name)
        return defaults
    }

    @Test func theDefaultIsEverythingOn() {
        let d = NotificationSettings.default
        #expect(d.enabled)
        for category in NotificationCategory.allCases { #expect(d.isOn(category)) }
    }

    @Test func theMasterSwitchOverridesEveryCategory() {
        let off = NotificationSettings.default.settingEnabled(false)
        for category in NotificationCategory.allCases { #expect(!off.allows(category)) }
    }

    @Test func aMutedCategoryIsRefusedAndTheOthersAreNot() {
        let muted = NotificationSettings.default.setting(.ci, to: false)
        #expect(!muted.allows(.ci))
        #expect(muted.allows(.agent))
        #expect(!muted.isOn(.ci))
    }

    @Test func anUnknownCategoryInStorageDefaultsToOn() {
        // A settings blob written by a newer build may not carry today's categories. Absent must
        // mean "on": silently muting a signal the operator never turned off is the worse failure.
        let partial = NotificationSettings(enabled: true, categories: ["ci": false])
        #expect(partial.allows(.agent))
        #expect(!partial.allows(.ci))
    }

    @Test func settingsRoundTripPerProfile() {
        let defaults = scratch()
        let store = NotificationSettingsStore(defaults: defaults)
        let a = UUID()
        let b = UUID()

        #expect(store.load(for: a) == .default, "an unseen profile starts at the default")
        store.save(NotificationSettings.default.setting(.agent, to: false), for: a)
        #expect(!store.load(for: a).isOn(.agent))
        #expect(store.load(for: b) == .default, "settings are per profile, not global")
    }

    @Test func anUnreadableBlobFallsBackToTheDefaultRatherThanCrashing() {
        // Case 1 of 3 for forward compatibility: a wholly unparseable value (not JSON at all).
        let defaults = scratch()
        let id = UUID()
        defaults.set(Data("not json".utf8), forKey: NotificationSettingsStore.key(for: id))
        #expect(NotificationSettingsStore(defaults: defaults).load(for: id) == .default)
    }

    @Test func aBlobOfTheWrongShapeFallsBackToTheDefaultRatherThanCrashing() {
        // Also case 1 of 3: valid JSON, but not an object this type can decode at all (a bare
        // JSON array). This must not throw out of `load`, and must not crash.
        let defaults = scratch()
        let id = UUID()
        defaults.set(Data("[1, 2, 3]".utf8), forKey: NotificationSettingsStore.key(for: id))
        #expect(NotificationSettingsStore(defaults: defaults).load(for: id) == .default)
    }

    @Test func aBlobMissingAFieldKeepsWhatItDidCarryRatherThanLosingTheOtherToggles() throws {
        // Case 2 of 3: a future build drops (or never wrote) a field this build still expects.
        // The category toggle the operator actually set must survive, not be wiped by falling
        // back to the whole-object default.
        let defaults = scratch()
        let id = UUID()
        // No "enabled" key at all.
        let json = Data(#"{"categories": {"agent": false}}"#.utf8)
        defaults.set(json, forKey: NotificationSettingsStore.key(for: id))

        let loaded = NotificationSettingsStore(defaults: defaults).load(for: id)
        #expect(loaded.enabled, "a missing master switch defaults to on")
        #expect(!loaded.isOn(.agent), "the toggle that WAS present must not be discarded")
        #expect(loaded.isOn(.ci))

        // Symmetric case: "categories" absent, "enabled" present.
        let id2 = UUID()
        let json2 = Data(#"{"enabled": false}"#.utf8)
        defaults.set(json2, forKey: NotificationSettingsStore.key(for: id2))
        let loaded2 = NotificationSettingsStore(defaults: defaults).load(for: id2)
        #expect(!loaded2.enabled, "the field that WAS present must not be discarded")
        for category in NotificationCategory.allCases { #expect(loaded2.isOn(category)) }
    }

    @Test func anUnknownCategoryKeyRoundTripsWithoutLosingTheKnownOnes() throws {
        // Case 3 of 3: a blob written by a later build carries a category this build has never
        // heard of, alongside ones it knows. Decoding must succeed and keep both.
        let defaults = scratch()
        let id = UUID()
        let json = Data(#"{"enabled": true, "categories": {"agent": false, "digest": true}}"#.utf8)
        defaults.set(json, forKey: NotificationSettingsStore.key(for: id))

        let loaded = NotificationSettingsStore(defaults: defaults).load(for: id)
        #expect(!loaded.isOn(.agent), "the known category's toggle must survive")
        #expect(loaded.isOn(.ci), "a category absent from the blob still defaults to on")
        #expect(loaded.categories["digest"] == true, "the unknown key must not be dropped")

        // And it must still round-trip through save/load unharmed.
        let store = NotificationSettingsStore(defaults: defaults)
        store.save(loaded, for: id)
        #expect(store.load(for: id) == loaded)
    }

    @Test func theStorageKeyIsNamespacedPerProfile() {
        let id = UUID()
        #expect(
            NotificationSettingsStore.key(for: id)
                == "run.shepherd.mac.notifications.\(id.uuidString)")
    }
}
