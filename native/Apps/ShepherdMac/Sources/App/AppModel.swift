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

/// Where the connection watcher reads `ConnectionState` from.
///
/// Production hands it a **weak** view of the active `SessionStore`, so the
/// watcher can never be the reason a dropped model's store — and the socket
/// behind it — stays alive. The unit tests hand it an `@Observable` box they
/// flip by hand, which is the only way the watcher's re-arm contract can be
/// exercised without a live server.
@MainActor
struct ConnectionSource {
    /// The current state, or `nil` once the store behind it is gone.
    let read: () -> ConnectionState?
    /// Called when the watcher finds its model released without a `teardown()`:
    /// ends the store's loop rather than leaving it reconnecting forever. A
    /// store parked inside `start()` on a quiet socket is released only here,
    /// on its *next* connection-state change — `start()`'s own suspended frame
    /// keeps it alive until then. Accepted: `ShepherdApp` holds one
    /// app-lifetime `@State AppModel`, so the only drop path today is process
    /// exit; an isolated `deinit` (needs macOS 15.4+, past this app's floor)
    /// is the proper fix once the deployment target moves.
    let abandon: () -> Void
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
    /// A sign-out whose server-side revoke failed, in operator-facing words.
    ///
    /// App-level rather than window-level on purpose: `signOutActive()` ends
    /// the activation, so the main window — where the sign-out affordance
    /// lives — is unmounted in the same turn the failure becomes known. A
    /// notice owned by that window would never be read. Written and cleared
    /// by the view, like `sheet`.
    var signOutWarning: String?

    /// Bumped by every `activate(_:)`, every `teardown()`, and every
    /// `remove(_:)` of the profile that is currently active (via the
    /// `teardown()` that call makes) — never by removing an *inactive*
    /// profile, which must leave the active profile's own watcher running.
    /// An async step that started under an older generation — a sign-in the
    /// operator left mid-flight, a sign-out, a connection watcher — must not
    /// touch the model when it finally completes: by then a different profile
    /// may be active, or none at all. Profile identity is not enough, because
    /// re-activating the *same* profile has to invalidate the older
    /// completions too.
    private(set) var activationGeneration = 0

    /// Profiles whose `remove(_:)` is currently in flight. `activate(_:)` and
    /// `signIn`'s completion consult this in addition to `activationGeneration`:
    /// a profile can be mid-removal without a generation bump ever having run
    /// for it (it may never have been active), and once `remove(_:)` finishes
    /// the profile is simply gone from `profiles` — a longer-lived signal this
    /// set does not carry once removal completes and clears it here.
    @ObservationIgnored private var removing: Set<ServerProfile.ID> = []

    /// The two server-facing setup steps, behind stored closures so a test can
    /// hold a sign-in mid-flight or remove a profile without touching the
    /// network. Internal, not private, and replaced only by the unit tests.
    @ObservationIgnored
    var login: @MainActor (ServerProfile, String, any CredentialStore) async throws -> Void = {
        try await ProfileSetup.login(profile: $0, password: $1, credentials: $2)
    }
    @ObservationIgnored
    var logout: @MainActor (ServerProfile, any CredentialStore) async throws -> Void = {
        try await ProfileSetup.logout(profile: $0, credentials: $1)
    }

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

    /// Drops a profile *and its credential*. Removing a row the operator has
    /// signed in to used to strand the minted token: the random `credentialKey`
    /// went with the row, so the Keychain item survived un-revokable and the
    /// server-side token stayed valid forever.
    ///
    /// Order matters. The active store goes first — it must not keep using a
    /// credential that is about to be revoked — then the server-side revocation
    /// (best effort: a server that refuses it must not strand the local item),
    /// then the local delete, then the row.
    ///
    /// `removing` is marked before anything else, so a sign-in already in
    /// flight for this profile cannot land after this call starts and
    /// re-activate a row this method is in the middle of deleting, and a
    /// `logout` gated by a test cannot let a re-`activate(_:)` of the still-
    /// listed row install a replacement store either — `removing` blocks both
    /// directly, by membership, not by generation. `activationGeneration` is
    /// bumped here only when `profile` is the active one, through the
    /// `teardown()` call below: bumping it for every removal used to also
    /// invalidate an *unrelated* active profile's own connection watcher,
    /// which reads the same counter. A `.login(profile)` sheet left open for
    /// the removed row is cleared explicitly for the same reason —
    /// `teardown()` only clears the sheet when `profile` was the one active.
    /// A sign-in that lands after this call has already removed the row gets
    /// the same best-effort `logout` + `credentials.delete(for:)` cleanup
    /// below, in its own guard in `signIn(profile:password:)`. Nothing here
    /// bails out early on a generation mismatch — removal always runs to
    /// completion once started.
    func remove(_ profile: ServerProfile) async {
        removing.insert(profile.id)
        if activeProfile?.id == profile.id {
            teardown()
        } else {
            clearSheet(forRemovedProfile: profile.id)
        }
        // `logout` revokes and clears the local item; the explicit delete covers
        // the paths where it bailed out before getting there.
        try? await logout(profile, credentials)
        try? credentials.delete(for: profile.credentialKey)
        profiles.removeAll { $0.id == profile.id }
        persist()
        removing.remove(profile.id)
        Log.app.info("removed profile \(profile.name, privacy: .public)")
    }

    // MARK: - Activation

    /// Makes `profile` the active one: tears down any existing store, builds
    /// a fresh `SessionStore`, and arms the connection watcher for it.
    ///
    /// A profile mid-`remove(_:)` — or already gone — is silently ignored: it
    /// may be about to lose its credential, or already have lost it, so it
    /// must not be (re-)activated.
    func activate(_ profile: ServerProfile) async {
        guard !removing.contains(profile.id), profiles.contains(where: { $0.id == profile.id })
        else {
            Log.app.debug(
                "ignoring activate for a profile that is being removed or already gone")
            return
        }

        activationGeneration &+= 1
        let generation = activationGeneration

        connectionWatcher?.cancel()
        connectionWatcher = nil
        storeRunner?.cancel()
        storeRunner = nil
        // A stopped SessionStore cannot be restarted — the kit is explicit that
        // an app builds a fresh one per activation, which is what happens below.
        store?.stop()

        activeProfile = profile
        selectedSessionID = nil
        // A sheet that belongs to the profile we are leaving must not hang over
        // the one we are entering: submitting it would authenticate the old
        // server and switch back, and while it is up routing cannot open the new
        // profile's own login sheet.
        clearProfileBoundSheet()
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
            // Nothing is active now, so no profile-bound sheet may be left
            // floating over the welcome screen.
            clearProfileBoundSheet()
            persist()
            return
        }

        self.store = store
        watchConnection(
            ConnectionSource(
                read: { [weak store] in store?.connection },
                abandon: { [weak store] in store?.stop() }),
            profile: profile,
            generation: generation)
        // start() bootstraps, publishes `connection`, then consumes the event
        // stream until stop(). It never throws — failures land in `connection`.
        //
        // Both captures are weak. There is no isolated `deinit` on the macOS 15
        // floor to cancel these tasks from, so a model released without a
        // `teardown()` — a window closing, a test scope ending — can only let go
        // of its store if the tasks it spawned never held it strongly.
        storeRunner = Task { @MainActor [weak self, weak store] in
            guard self != nil, let store else { return }
            await store.start()
        }
    }

    func signIn(profile: ServerProfile, password: String) async throws {
        let generation = activationGeneration
        try await login(profile, password, credentials)
        Log.connect.info("signed in to \(profile.name, privacy: .public)")
        // A profile that `remove(_:)` took mid-flight, or has already
        // finished taking, must not be resurrected by a sign-in that outlived
        // it — the credential this login just stored may already be revoked.
        // Checked before the generation guard below: this cleanup is
        // generation-independent, since `remove(_:)` only bumps
        // `activationGeneration` when the removed profile was the active one
        // (through the `teardown()` it calls) — removing an inactive profile
        // never moves it. Ordered after the generation guard, the common case
        // where the operator also activated a different profile in the
        // meantime would hit that guard's mismatch and return before this
        // cleanup ever ran, orphaning the token `login` just stored.
        guard !removing.contains(profile.id), profiles.contains(where: { $0.id == profile.id })
        else {
            Log.connect.debug("ignoring sign-in completion for a profile that was removed")
            // The token this login just stored must not outlive the row it
            // was minted for — left behind, it is exactly the orphaned,
            // un-revokable credential `remove(_:)` exists to prevent.
            try? await logout(profile, credentials)
            try? credentials.delete(for: profile.credentialKey)
            return
        }
        // The token is stored either way, but a login that finished after the
        // operator moved on must not yank the app back to the old profile.
        guard generation == activationGeneration else {
            Log.connect.info("a newer activation won; not switching back")
            return
        }
        await activate(profile)
    }

    /// Revokes the active profile's token server-side and ends the activation.
    ///
    /// - Returns: the error the *revoke* failed with, or `nil` when it
    ///   succeeded — and also `nil` when a newer activation superseded this
    ///   sign-out, because nothing was torn down and there is nothing to
    ///   report about a profile the operator has already left.
    ///
    /// The local teardown happens either way: a server that refuses the revoke
    /// must not trap the operator in a session they asked to leave. What
    /// changed is that the failure is no longer swallowed — `try?` alone left
    /// an operator believing a token had been revoked when the server never
    /// confirmed it, which for a remote profile is a live credential they
    /// think is dead. The caller decides where to say so; see
    /// `signOutWarning`, which outlives the window the affordance lives in.
    @discardableResult
    func signOutActive() async -> (any Error)? {
        guard let profile = activeProfile else { return nil }
        let generation = activationGeneration
        var failure: (any Error)?
        do {
            try await logout(profile, credentials)
        } catch {
            Log.connect.error(
                """
                sign-out of \(profile.name, privacy: .public) did not revoke the token: \
                \(String(describing: error), privacy: .public)
                """)
            failure = error
        }
        // Tearing down here after a switch would take the *new* profile's store
        // down with it.
        guard generation == activationGeneration else { return nil }
        teardown()
        return failure
    }

    // MARK: - Internals

    /// Turns the store's connection state into sheet routing.
    ///
    /// `SessionStore.connection` is `@Observable`-tracked, so this suspends on
    /// `withObservationTracking` and wakes on the next mutation — no timer, no
    /// missed transition. `withObservationTracking` fires `onChange` exactly once,
    /// which is why the loop re-registers on every pass.
    ///
    /// Internal, not private: the unit tests drive it with their own
    /// `ConnectionSource` so the re-arm contract is covered without a server.
    func watchConnection(
        _ source: ConnectionSource, profile: ServerProfile, generation: Int
    ) {
        guard let initial = source.read() else { return }

        connectionWatcher = Task { @MainActor [weak self] in
            var current = initial
            var routedInitial = false
            while !Task.isCancelled {
                // Read and route *before* arming, in its own scope. Before:
                // because a state that moved between the initial read and this
                // task's first run — `start()` publishing `.connecting` is
                // exactly that — would otherwise be waited out forever, since
                // observation only reports the *next* write. In its own scope:
                // because a `self` still bound across the suspension below would
                // make this watcher the reason a dropped model never deinits.
                // This also covers the *initial* state, routed here on the
                // first pass rather than at arm time: an activation a newer
                // one has already superseded must not route a stale state just
                // because it happened to be current when `watchConnection` was
                // called.
                var routed = false
                do {
                    guard let self else {
                        // The model went away without a teardown. Stop the store
                        // so a closed window cannot leave a socket reconnecting.
                        source.abandon()
                        return
                    }
                    // A watcher from an older activation may still be unwinding;
                    // what it reads belongs to a store the app has moved on from.
                    guard self.activationGeneration == generation else { return }
                    if !routedInitial {
                        routedInitial = true
                        routed = true
                        self.routeSheet(for: current, profile: profile)
                    } else {
                        // Registering an observation on a store that is gone would
                        // park this task on a continuation no write can resume.
                        guard let latest = source.read() else { return }
                        if latest != current {
                            current = latest
                            routed = true
                            self.routeSheet(for: latest, profile: profile)
                        }
                    }
                }
                if routed { continue }

                await withCheckedContinuation { continuation in
                    withObservationTracking {
                        _ = source.read()
                    } onChange: {
                        continuation.resume()
                    }
                }
                // `onChange` runs just before the property is written, so yield
                // once to let the writer finish before the next pass reads it.
                await Task.yield()
            }
        }
    }

    /// Drops a sheet that only makes sense for the profile being left. A
    /// `.newSession` sheet is window-bound, not profile-bound, and stays.
    private func clearProfileBoundSheet() {
        switch sheet {
        case .login, .firstRun: sheet = nil
        case .newSession, .none: break
        }
    }

    /// Drops a `.login(_)` sheet identified by `profileID` specifically,
    /// leaving any other sheet alone. `remove(_:)` needs this narrower check
    /// — rather than `clearProfileBoundSheet()` — for an *inactive* profile:
    /// `.firstRun` is not tied to a particular profile identity, and a
    /// `.login` sheet for some other, still-active profile must not close
    /// just because a different row is being removed. Skipping `.firstRun`
    /// here is safe only because `.firstRun` is set solely by `routeSheet`
    /// for the *active* profile's own watcher, and `activate(_:)` /
    /// `teardown()` always clear it — so a `.firstRun` sheet can never belong
    /// to the inactive profile this method is removing.
    private func clearSheet(forRemovedProfile profileID: ServerProfile.ID) {
        if case .login(let profile) = sheet, profile.id == profileID {
            sheet = nil
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

    /// Internal, not private: the unit tests end an activation directly.
    func teardown() {
        activationGeneration &+= 1
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
