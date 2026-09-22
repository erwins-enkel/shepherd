import Foundation

/// What one server profile's notifications are allowed to do.
///
/// Per profile, not global: an operator who watches a work server all day and a home server
/// occasionally wants one of them quiet, and "which server is this about" is the only axis the
/// app can answer from what it has. The web's equivalent is per *device* — its subscription row
/// carries the category map — which has no meaning here, because the app is the device.
///
/// `categories` is a dictionary rather than three `Bool`s so a blob written by a newer build,
/// carrying a category this one has never heard of, round-trips unharmed instead of being
/// silently rewritten.
public struct NotificationSettings: Equatable, Sendable {
    /// The master switch. Off means nothing is posted for this profile at all.
    public var enabled: Bool
    /// Category raw value -> allowed. An absent key means allowed.
    var categories: [String: Bool]

    static let `default` = NotificationSettings(enabled: true, categories: [:])

    init(enabled: Bool, categories: [String: Bool]) {
        self.enabled = enabled
        self.categories = categories
    }

    /// Absent means on, so a newly added category starts audible. Muting something the operator
    /// never turned off is the worse failure of the two.
    public func isOn(_ category: NotificationCategory) -> Bool {
        categories[category.rawValue] ?? true
    }

    func allows(_ category: NotificationCategory) -> Bool {
        enabled && isOn(category)
    }

    public func setting(_ category: NotificationCategory, to on: Bool) -> NotificationSettings {
        var copy = self
        copy.categories[category.rawValue] = on
        return copy
    }

    public func settingEnabled(_ on: Bool) -> NotificationSettings {
        var copy = self
        copy.enabled = on
        return copy
    }
}

extension NotificationSettings: Codable {
    private enum CodingKeys: String, CodingKey {
        case enabled, categories
    }

    /// A hand-rolled `init` rather than the synthesized one: a blob written by a later build may
    /// be missing a field this build still expects (say, a future rename or a trimmed default
    /// that was never worth persisting). The synthesized decoder would throw `keyNotFound` for
    /// that and `NotificationSettingsStore` would then discard the *whole* blob — including a
    /// category map the operator carefully set — just because one field was absent. Defaulting
    /// each field independently keeps whatever did decode.
    ///
    /// An unknown key inside `categories` needs no special handling at all: `Dictionary`'s own
    /// `Decodable` conformance keeps it, and only `NotificationCategory.allCases` ever reads the
    /// map back out, so a category this build has never heard of just rides along unread.
    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        enabled = try container.decodeIfPresent(Bool.self, forKey: .enabled) ?? true
        categories = try container.decodeIfPresent([String: Bool].self, forKey: .categories) ?? [:]
    }
}

/// Per-profile settings persisted as JSON in `UserDefaults`, one key per profile id.
///
/// Mirrors `ProfileStore`'s shape deliberately, down to dropping `Sendable`: `UserDefaults` does
/// not conform on this SDK, and the global constraints forbid every escape hatch that would fake
/// it. Nothing secret lives here.
struct NotificationSettingsStore {
    private let defaults: UserDefaults

    init(defaults: UserDefaults) {
        self.defaults = defaults
    }

    static func key(for profileID: UUID) -> String {
        "run.shepherd.mac.notifications.\(profileID.uuidString)"
    }

    func load(for profileID: UUID) -> NotificationSettings {
        guard let data = defaults.data(forKey: Self.key(for: profileID)) else { return .default }
        do {
            return try JSONDecoder().decode(NotificationSettings.self, from: data)
        } catch {
            // Never the operator's content, so this is safe to log; and a blob we cannot read at
            // all (not JSON, or JSON of the wrong shape) is better replaced by the audible
            // default than by silence. A merely *incomplete* blob never reaches this branch —
            // `NotificationSettings.init(from:)` already defaults missing fields per-field.
            Log.app.error(
                "dropping unreadable notification settings: \(String(describing: error), privacy: .public)"
            )
            return .default
        }
    }

    func save(_ settings: NotificationSettings, for profileID: UUID) {
        do {
            defaults.set(try JSONEncoder().encode(settings), forKey: Self.key(for: profileID))
        } catch {
            Log.app.error(
                "could not persist notification settings: \(String(describing: error), privacy: .public)"
            )
        }
    }
}
