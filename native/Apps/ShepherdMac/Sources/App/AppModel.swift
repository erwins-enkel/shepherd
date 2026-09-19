import Foundation
import Observation
import ShepherdKit

enum AppSheet: Identifiable, Equatable {
    case login(ServerProfile)
    case firstRun
    case newSession

    var id: String {
        switch self {
        case .login(let profile): "login-\(profile.id.uuidString)"
        case .firstRun: "first-run"
        case .newSession: "new-session"
        }
    }
}

/// The remote-server form's own validation: parsing only.
///
/// The https-unless-loopback-or-`.ts.net` rule is **ShepherdKit's**
/// (`ServerProfile.validated()`), and this app never reimplements it — a second
/// copy of a security policy is a second place for it to be wrong. What is left
/// here is what the kit cannot express: an empty field, and text that is not an
/// http(s) URL at all.
enum RemoteServerForm {
    enum FieldError: Error, Equatable, Sendable {
        case empty
        case malformed
    }

    /// Scheme + host + port only — the client appends its own paths. A bare
    /// host gets `https://`, the host is lowercased, and path, query, fragment
    /// and any userinfo are dropped.
    static func normalize(_ raw: String) throws -> URL {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { throw FieldError.empty }

        let withScheme = trimmed.contains("://") ? trimmed : "https://\(trimmed)"
        guard var components = URLComponents(string: withScheme) else { throw FieldError.malformed }

        guard let scheme = components.scheme?.lowercased(),
              scheme == "http" || scheme == "https"
        else { throw FieldError.malformed }
        guard let host = components.host?.lowercased(), !host.isEmpty else {
            throw FieldError.malformed
        }

        components.scheme = scheme
        components.host = host
        components.path = ""
        components.query = nil
        components.fragment = nil
        components.user = nil
        components.password = nil

        guard let url = components.url else { throw FieldError.malformed }
        return url
    }

    /// Builds a `.remote` profile and returns it only if the kit's policy
    /// accepts it. Throws `FieldError` for a typo and `ServerProfileError` for
    /// an address the policy rejects.
    static func profile(
        name: String, address: String, credentialKey: String
    ) throws -> ServerProfile {
        let url = try normalize(address)
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        let profile = ServerProfile(
            id: UUID(),
            name: trimmed.isEmpty ? (url.host() ?? url.absoluteString) : trimmed,
            baseURL: url,
            mode: .remote,
            credentialKey: credentialKey)
        return try profile.validated()
    }
}

/// Owns the profile list, the active SessionStore and sheet routing. Holds no
/// networking of its own — everything server-facing goes through ShepherdKit.
@Observable
@MainActor
final class AppModel {
    private(set) var profiles: [ServerProfile] = []
    private(set) var activeProfile: ServerProfile?
    private(set) var store: SessionStore?
    var sheet: AppSheet?
    var selectedSessionID: String?

    @ObservationIgnored private let persistence: ProfileStore
    @ObservationIgnored private let credentials: any CredentialStore
    /// Runs `SessionStore.start()` — bootstrap plus the event loop.
    @ObservationIgnored private var storeRunner: Task<Void, Never>?
    /// Watches `SessionStore.connection` and routes sheets off it.
    @ObservationIgnored private var connectionWatcher: Task<Void, Never>?

    init(
        defaults: UserDefaults = .standard,
        credentials: any CredentialStore = KeychainCredentialStore()
    ) {
        self.persistence = ProfileStore(defaults: defaults)
        self.credentials = credentials

        let loaded = persistence.load()
        self.profiles = loaded.profiles
        self.activeProfile = loaded.profiles.first { $0.id == loaded.activeID }
    }

    var appVersion: String {
        Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "0.0.0"
    }

    // MARK: - Profiles

    @discardableResult
    func addRemoteProfile(name: String, address: String) throws -> ServerProfile {
        // RemoteServerForm parses; ShepherdKit decides whether the address is
        // allowed. Nothing is appended if either step throws.
        let profile = try RemoteServerForm.profile(
            name: name,
            address: address,
            credentialKey: "run.shepherd.mac.\(UUID().uuidString)")
        profiles.append(profile)
        persist()
        Log.app.info("added remote profile \(profile.name, privacy: .public)")
        return profile
    }

    /// The single "this Mac" profile. Idempotent: calling it twice returns the
    /// existing row so the welcome card cannot pile up duplicates.
    @discardableResult
    func addLocalProfile() -> ServerProfile {
        if let existing = profiles.first(where: { $0.mode == .local }) { return existing }
        let profile = ServerProfile(
            id: UUID(),
            name: L.t("native_welcome_local_title"),
            baseURL: URL(string: "http://127.0.0.1:7330")!,
            mode: .local,
            credentialKey: "run.shepherd.mac.\(UUID().uuidString)")
        profiles.append(profile)
        persist()
        return profile
    }

    func remove(_ profile: ServerProfile) {
        profiles.removeAll { $0.id == profile.id }
        if activeProfile?.id == profile.id {
            teardown()
        } else {
            persist()
        }
    }

    // MARK: - Activation

    func activate(_ profile: ServerProfile) async {
        connectionWatcher?.cancel()
        connectionWatcher = nil
        storeRunner?.cancel()
        storeRunner = nil
        // A stopped SessionStore cannot be restarted — the kit is explicit that
        // an app builds a fresh one per activation, which is what happens below.
        store?.stop()

        activeProfile = profile
        selectedSessionID = nil
        persist()

        let store: SessionStore
        do {
            store = try SessionStore(profile: profile, credentials: credentials)
        } catch {
            // The only failure `SessionStore.init(profile:credentials:)` has is
            // ServerProfileError.insecureRemoteURL, and addRemoteProfile already
            // applied the same policy — so this can only fire for a row persisted
            // by an older build. Drop back to the welcome screen rather than
            // linking an unusable store.
            Log.connect.error(
                """
                cannot use profile \(profile.name, privacy: .public): \
                \(String(describing: error), privacy: .public)
                """)
            self.store = nil
            activeProfile = nil
            persist()
            return
        }

        self.store = store
        watchConnection(store, profile: profile)
        // start() bootstraps, publishes `connection`, then consumes the event
        // stream until stop(). It never throws — failures land in `connection`.
        storeRunner = Task { await store.start() }
    }

    func signIn(profile: ServerProfile, password: String) async throws {
        try await ProfileSetup.login(profile: profile, password: password, credentials: credentials)
        Log.connect.info("signed in to \(profile.name, privacy: .public)")
        await activate(profile)
    }

    func signOutActive() async {
        guard let profile = activeProfile else { return }
        try? await ProfileSetup.logout(profile: profile, credentials: credentials)
        teardown()
    }

    // MARK: - Internals

    /// Turns the store's connection state into sheet routing.
    ///
    /// `SessionStore.connection` is `@Observable`-tracked, so this suspends on
    /// `withObservationTracking` and wakes on the next mutation — no timer, no
    /// missed transition. `withObservationTracking` fires `onChange` exactly once,
    /// which is why the loop re-registers on every pass.
    private func watchConnection(_ store: SessionStore, profile: ServerProfile) {
        routeSheet(for: store.connection, profile: profile)

        connectionWatcher = Task { @MainActor [weak self] in
            var current = store.connection
            while !Task.isCancelled {
                await withCheckedContinuation { continuation in
                    withObservationTracking {
                        _ = store.connection
                    } onChange: {
                        continuation.resume()
                    }
                }
                // `onChange` runs just before the property is written, so yield
                // once to let the writer finish before reading the new value.
                await Task.yield()
                guard let self, !Task.isCancelled else { return }

                let next = store.connection
                guard next != current else { continue }
                current = next
                self.routeSheet(for: next, profile: profile)
            }
        }
    }

    /// A 401 opens the login sheet; a pending first run opens the folder picker.
    /// An already-open sheet is never replaced — the operator is mid-task in it.
    func routeSheet(for state: ConnectionState, profile: ServerProfile) {
        switch state {
        case .needsLogin:
            if sheet == nil { sheet = .login(profile) }
        case .firstRunPending:
            if sheet == nil { sheet = .firstRun }
        case .idle, .connecting, .live, .offline:
            break
        }
    }

    private func teardown() {
        connectionWatcher?.cancel()
        connectionWatcher = nil
        storeRunner?.cancel()
        storeRunner = nil
        // stop() also publishes `connection = .idle`, which releases the
        // watcher's continuation so the cancelled task can actually finish.
        store?.stop()
        store = nil
        activeProfile = nil
        sheet = nil
        selectedSessionID = nil
        persist()
    }

    private func persist() {
        persistence.save(profiles: profiles, activeID: activeProfile?.id)
    }
}
