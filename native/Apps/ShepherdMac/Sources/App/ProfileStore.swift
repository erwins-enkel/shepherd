import Foundation
import ShepherdKit

/// Server profiles persisted as JSON in UserDefaults. No secrets live here —
/// tokens are in the Keychain under ServerProfile.credentialKey.
///
/// Deviates from the task brief's literal `Sendable` conformance: `UserDefaults`
/// does not conform to `Sendable` on this SDK (Xcode 26.6 / Swift 6.3, confirmed
/// with a minimal `swiftc -strict-concurrency=complete` repro independent of this
/// target), and the plan's global constraints forbid `@preconcurrency`,
/// `nonisolated(unsafe)` and `@unchecked Sendable` outside the test `URLProtocol`
/// stub. Dropping `Sendable` here is the smallest change that keeps strict
/// concurrency clean without an escape hatch; flagged for the orchestrator in
/// case Gate 2 work wants this type Sendable.
struct ProfileStore {
    static let profilesKey = "run.shepherd.mac.profiles"
    static let activeKey = "run.shepherd.mac.activeProfileID"

    private let defaults: UserDefaults

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
    }

    func load() -> (profiles: [ServerProfile], activeID: UUID?) {
        guard let data = defaults.data(forKey: Self.profilesKey) else { return ([], nil) }

        let profiles: [ServerProfile]
        do {
            profiles = try JSONDecoder().decode([ServerProfile].self, from: data)
        } catch {
            Log.app.error("dropping unreadable profile list: \(String(describing: error), privacy: .public)")
            return ([], nil)
        }

        let raw = defaults.string(forKey: Self.activeKey)
        guard let activeID = raw.flatMap(UUID.init(uuidString:)),
              profiles.contains(where: { $0.id == activeID })
        else {
            return (profiles, nil)
        }
        return (profiles, activeID)
    }

    func save(profiles: [ServerProfile], activeID: UUID?) {
        guard !profiles.isEmpty else {
            defaults.removeObject(forKey: Self.profilesKey)
            defaults.removeObject(forKey: Self.activeKey)
            return
        }
        do {
            defaults.set(try JSONEncoder().encode(profiles), forKey: Self.profilesKey)
        } catch {
            Log.app.error("could not persist profiles: \(String(describing: error), privacy: .public)")
            return
        }
        if let activeID, profiles.contains(where: { $0.id == activeID }) {
            defaults.set(activeID.uuidString, forKey: Self.activeKey)
        } else {
            defaults.removeObject(forKey: Self.activeKey)
        }
    }
}
