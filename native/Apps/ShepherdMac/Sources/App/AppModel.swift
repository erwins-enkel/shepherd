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

/// A one-shot race between two tasks, for `AppModel.credentialAnswers(for:)`.
///
/// The loser is a task that cannot be cancelled — a blocking Keychain read —
/// so the winner has to be able to answer without it, and the loser has to be
/// able to arrive late and change nothing.
actor ProbeGate {
    private var settled: Bool?
    private var waiter: CheckedContinuation<Bool, Never>?

    /// The first call decides the value; later ones are dropped.
    func settle(_ value: Bool) {
        guard settled == nil else { return }
        settled = value
        waiter?.resume(returning: value)
        waiter = nil
    }

    func value() async -> Bool {
        if let settled { return settled }
        return await withCheckedContinuation { waiter = $0 }
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
    /// What `GET /api/health` last reported for the active profile, or `nil`
    /// while it is unknown — no activation yet, or a health call that failed or
    /// came back `ok: false`. `serverMinClient` is what the banner compares
    /// `appVersion` against; `serverVersion` only names the server in a
    /// contract-mismatch banner, because the two numbers are different version
    /// lines and their plain difference means nothing.
    private(set) var serverVersion: String?
    private(set) var serverMinClient: String?
    /// The last health answer was `ok: false` — the server is up and answering
    /// but says it is not well. The socket may still read `.live`, so without
    /// this the window would show nothing at all.
    private(set) var serverUnhealthy = false
    /// A Retry is running. The banner's button is disabled while it is, and
    /// `retryActive()` refuses to start a second one.
    private(set) var retrying = false
    /// The one sheet over everything, written by the views and by routing.
    ///
    /// Hand-written accessors — the `@Observable` "manually track changes"
    /// pattern — because *closing* a sheet has to re-run routing. `.newSession`
    /// is window-bound and outlives any connection change, and while it is up
    /// `routeSheet(for:profile:)` refuses to replace it; the watcher, which
    /// only wakes on a *change*, will not fire again for a state that has not
    /// moved. A token expiring mid-sheet therefore left `.needsLogin` routed by
    /// nobody: Create failed, Cancel cleared the sheet, and the operator sat on
    /// a dead main window with no way to sign back in.
    var sheet: AppSheet? {
        get {
            access(keyPath: \.sheet)
            return storedSheet
        }
        set {
            let previous = storedSheet
            withMutation(keyPath: \.sheet) { storedSheet = newValue }
            // Only a *window-bound* sheet closing re-routes. Dismissing
            // `.login` or `.firstRun` must not: the state they were routed for
            // is still current, so re-routing would put the same sheet straight
            // back up and the operator could never close it.
            if newValue == nil, previous == .newSession { routeAfterSheetClose() }
        }
    }
    @ObservationIgnored private var storedSheet: AppSheet?
    var selectedSessionID: String?
    /// A sign-out whose server-side revoke failed, in operator-facing words.
    ///
    /// App-level rather than window-level on purpose: `signOutActive()` ends
    /// the activation, so the main window — where the sign-out affordance
    /// lives — is unmounted in the same turn the failure becomes known. A
    /// notice owned by that window would never be read. Written and cleared
    /// by the view, like `sheet`.
    var signOutWarning: String?
    /// Set only by an isolated launch whose private `UserDefaults` suite could
    /// not be opened — see `IsolatedLaunch.init()`. Never cleared automatically
    /// and never operator-facing copy: no isolated launch outlives its test,
    /// so unlike `signOutWarning` this is not in the catalogs, only in
    /// `RootView`'s notice bar for whoever reads the test's log or screenshot.
    var isolatedLaunchError: String?
    /// Live UI smoke may read caches but must not start server-side recomputation.
    var liveRequestAudit: ReadOnlyRequestAudit?
    var allowsQueueRecomputation = true
    /// Emulator query replies are PTY input too, even when a live smoke test never types.
    var allowsTerminalInput = true

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
    /// The health call, behind the same seam, so a test can stub the round-trip
    /// or hold it open. Takes the store's own client rather than building a
    /// second one: `/api/health` is the one route with `security: []`, so the
    /// authenticated client answers it whether or not a token exists yet.
    @ObservationIgnored
    var health: @MainActor (ShepherdClient) async throws -> Health = { try await $0.health() }

    /// One read of a profile's stored credential, for `activate(_:)`'s
    /// pre-flight. The value is thrown away — what the activation needs to know
    /// is only whether the store *answers*. Behind the same seam as the two
    /// above so a test can hold the read open without a Keychain.
    ///
    /// The default hops to a plain global-queue thread rather than staying on a
    /// Swift-concurrency executor: `KeychainCredentialStore.load` is a blocking
    /// `SecItemCopyMatching`, and blocking one of the cooperative pool's few
    /// threads is how a stalled Keychain becomes a stalled app.
    @ObservationIgnored
    var credentialProbe: @Sendable (any CredentialStore, String) async -> Void = { store, key in
        await withCheckedContinuation { continuation in
            DispatchQueue.global(qos: .userInitiated).async {
                _ = try? store.load(for: key)
                continuation.resume()
            }
        }
    }

    /// How long `activate(_:)` gives the Keychain before it treats the saved
    /// credential as unusable and asks for a fresh sign-in.
    ///
    /// Generous on purpose: the common reason for a slow read is a SecurityAgent
    /// prompt, and an operator who answers it promptly should still get their
    /// session rather than a login sheet. What this budget rules out is the
    /// prompt that never arrives — queued behind another process's, or shown on
    /// a display nobody is looking at — which has no other end.
    @ObservationIgnored var credentialTimeout: Duration = .seconds(8)

    @ObservationIgnored private let persistence: ProfileStore
    @ObservationIgnored private let credentials: any CredentialStore
    /// Runs `SessionStore.start()` — bootstrap plus the event loop.
    @ObservationIgnored private var storeRunner: Task<Void, Never>?
    /// The one health request in flight, owned by the model. Its own task, not
    /// a step inside `activate(_:)` or `storeRunner`: a health call that hangs
    /// must delay neither the caller of `activate(_:)` nor the store's
    /// bootstrap. Model-owned rather than view-owned so a teardown, a
    /// deactivate or a profile switch can cancel it, and so a second request
    /// supersedes the first instead of racing it.
    @ObservationIgnored private var healthTask: Task<Void, Never>?
    /// Bumped by every health request; a completion whose captured value no
    /// longer matches is a stale answer and writes nothing.
    @ObservationIgnored private var healthGeneration = 0
    /// Runs `retryActive()` for the banner's button.
    @ObservationIgnored private var retryTask: Task<Void, Never>?
    /// Watches `SessionStore.connection` and routes sheets off it.
    @ObservationIgnored private var connectionWatcher: Task<Void, Never>?
    /// The watcher's wake-up channel. An `AsyncStream` rather than a bare
    /// `withCheckedContinuation` because a stream can be **finished** and a
    /// checked continuation cannot be resumed by cancellation — see
    /// `watchConnection(_:profile:generation:)`.
    @ObservationIgnored private var connectionSignal: AsyncStream<Void>.Continuation?
    /// True while *the current* watcher task is alive. Written by the task
    /// itself, so a test can prove the loop actually ended rather than merely
    /// that `Task.cancel()` was called on it.
    ///
    /// "Current" is the load-bearing word: an outgoing watcher may still be
    /// unwinding after its replacement armed itself, and it must not report
    /// "no watcher" over a loop that is very much alive. Each watcher therefore
    /// carries the `connectionWatcherToken` it was installed under and clears
    /// the flag only while that token is still the model's.
    @ObservationIgnored private(set) var isWatchingConnection = false
    /// Identifies the watcher `connectionWatcher` currently holds. Bumped by
    /// every `watchConnection(_:profile:generation:)`; a watcher whose captured
    /// value no longer matches has been superseded and owns nothing.
    @ObservationIgnored private var connectionWatcherToken = 0
    /// The live activation's connection source and the profile it belongs to,
    /// kept so a sheet closing can re-route against the *current* state rather
    /// than waiting for the next change. Cleared whenever the activation ends,
    /// so a sheet dismissed over the welcome screen routes nothing.
    @ObservationIgnored private var connectionSource: ConnectionSource?
    @ObservationIgnored private var watchedProfile: ServerProfile?

    /// Per-stream sub-models, keyed by extension type. Not `private`:
    /// `AppModel+Extensions.swift` is a different file and owns every write to
    /// both of these. Nothing else may touch them.
    ///
    /// A factory closure rather than an `any AppExtension.Type`: calling a
    /// protocol `init` requirement through an existential metatype is not
    /// expressible, so `register<E>` captures the concrete `E` here instead.
    @ObservationIgnored
    var extensionFactories:
        [(key: ObjectIdentifier, make: @MainActor (SessionStore, AppModel) -> any AppExtension)] = []
    /// Live instances for the current activation, in creation order. Emptied by
    /// `tearDownExtensions()`; never outlives its store.
    @ObservationIgnored
    var liveExtensions: [(key: ObjectIdentifier, value: any AppExtension)] = []

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

    /// Adds a `.remote` profile for `address`, or returns the saved one that
    /// already points there.
    ///
    /// Idempotent per normalized base URL, like `addLocalProfile()` is for the
    /// local row. Re-typing a saved server's address used to append a *second*
    /// row with a fresh `credentialKey`: `savedServers` accumulated rows the
    /// operator could not tell apart, and the original row's token stayed live
    /// under one of them. The stored row wins — it is the one whose Keychain
    /// item is real — so only the address decides identity here, not the name
    /// typed alongside it. `.local` rows are never candidates: "Run on this
    /// Mac" owns loopback and has its own card.
    @discardableResult
    func addRemoteProfile(name: String, address: String) throws -> ServerProfile {
        // RemoteServerForm parses; ShepherdKit decides whether the address is
        // allowed. Nothing is appended if either step throws.
        let profile = try RemoteServerForm.profile(
            name: name,
            address: address,
            credentialKey: "run.shepherd.mac.\(UUID().uuidString)")
        if let existing = profiles.first(where: { $0.mode == .remote && $0.baseURL == profile.baseURL }) {
            Log.app.info("reusing the saved profile for this address")
            return existing
        }
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

    /// The welcome screen's two "Connect" buttons, as the model sees them:
    /// make sure the profile exists, then route its login through the **one**
    /// sheet channel `RootView` presents.
    ///
    /// The welcome screen used to present a `LoginSheet` of its own from
    /// view-local state. That second channel sat outside every invariant here
    /// — clear-on-activate, clear-on-remove, the generation guards — and, worse,
    /// it was still on screen when a successful login swapped Welcome for the
    /// main window: the new activation's watcher then routed `.firstRun` into
    /// `sheet` while AppKit refused to present a second modal, so the operator
    /// was parked on an empty window with a sheet state nothing could clear.
    @discardableResult
    func beginLocalLogin() -> ServerProfile {
        let profile = addLocalProfile()
        sheet = .login(profile)
        return profile
    }

    /// The remote card's twin of `beginLocalLogin()`. Throws exactly what
    /// `addRemoteProfile(name:address:)` throws — and opens no sheet when it
    /// does, because there is no profile to log in to.
    @discardableResult
    func beginRemoteLogin(name: String, address: String) throws -> ServerProfile {
        let profile = try addRemoteProfile(name: name, address: address)
        sheet = .login(profile)
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
        // Not re-entrant: the welcome screen fires a `Task` per click, so two
        // clicks used to start two removals of the same row — a second
        // `teardown()`, and a second server-side revoke of a token the first
        // call had already revoked.
        guard !removing.contains(profile.id) else {
            Log.app.debug("ignoring a second remove for a profile already being removed")
            return
        }
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

    /// The stored remote profiles, in the order they were added.
    ///
    /// What the welcome screen lists so a profile parked by `deactivate()` — or
    /// left behind by a sign-out — can be reached again without re-typing its
    /// address, which used to append a *duplicate* row with a fresh
    /// `credentialKey`. `.local` is excluded: "Run on this Mac" has its own
    /// card, which probes for a server actually listening on loopback.
    var savedServers: [ServerProfile] { profiles.filter { $0.mode == .remote } }

    // MARK: - Activation

    /// Makes `profile` the active one: tears down any existing store, builds
    /// a fresh `SessionStore`, and arms the connection watcher for it.
    ///
    /// A profile mid-`remove(_:)` — or already gone — is silently ignored: it
    /// may be about to lose its credential, or already have lost it, so it
    /// must not be (re-)activated.
    ///
    /// May suspend for up to `credentialTimeout` on the Keychain pre-flight
    /// below, and may return having routed `sheet = .login(profile)` with no
    /// store at all — a fresh sign-in instead of a connection, when the
    /// Keychain did not answer in time.
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
        // Cancellation alone leaves the loop suspended; finishing its stream is
        // what actually ends it.
        connectionSignal?.finish()
        connectionSignal = nil
        // Dropped before the sheet below is cleared: a sheet closing must never
        // re-route against the connection of the profile being left.
        connectionSource = nil
        watchedProfile = nil
        storeRunner?.cancel()
        storeRunner = nil
        healthTask?.cancel()
        healthTask = nil
        retryTask?.cancel()
        retryTask = nil
        retrying = false
        // Before the old store stops: an extension may need a last word with the
        // store it was built for, and none may outlive it.
        tearDownExtensions()
        // A stopped SessionStore cannot be restarted — the kit is explicit that
        // an app builds a fresh one per activation, which is what happens below.
        // Dropped immediately, not just stopped: the Keychain pre-flight below
        // can suspend for up to `credentialTimeout`, and a stopped store left
        // published through that wait is a server the operator has already
        // left, still shown as current — the welcome screen is the honest
        // state while the probe runs.
        store?.stop()
        store = nil

        activeProfile = profile
        selectedSessionID = nil
        // The versions belong to the server being left; carried over, the banner
        // would compare this app against a server it is no longer talking to.
        serverVersion = nil
        serverMinClient = nil
        serverUnhealthy = false
        // The warning names the profile being left; carried over, it would tell
        // the operator that the server they are now signed in to failed to sign
        // them out.
        signOutWarning = nil
        // A sheet that belongs to the profile we are leaving must not hang over
        // the one we are entering: submitting it would authenticate the old
        // server and switch back, and while it is up routing cannot open the new
        // profile's own login sheet.
        clearProfileBoundSheet()
        persist()

        // Nothing below may start until the Keychain has answered *once*, under
        // a deadline. See `credentialAnswers(for:)`: everything an activation
        // starts — the socket's token, every request's Authorization header —
        // reads the same item with a blocking call, and a read that never
        // returns leaves the window empty with no banner and no sheet.
        guard await credentialAnswers(for: profile) else {
            Log.connect.error(
                """
                the Keychain did not answer for \(profile.name, privacy: .public) \
                within \(String(describing: self.credentialTimeout), privacy: .public); \
                asking for a fresh sign-in instead of connecting
                """)
            // A newer activation started while we waited; it owns the model now.
            guard generation == activationGeneration else { return }
            self.store = nil
            activeProfile = nil
            persist()
            // Signing in again is not just the way out of this screen: it
            // rewrites the Keychain item from *this* binary, which is what
            // makes the next launch's read answer at once.
            sheet = .login(profile)
            return
        }
        // The read answered, but a profile switch or a teardown may have
        // happened while it did.
        guard generation == activationGeneration else {
            Log.connect.debug("dropping an activation a newer one superseded")
            return
        }

        let store: SessionStore
        do {
            store = try SessionStore(client: ShepherdClient(profile: profile, credentials: credentials,
                readOnlyAudit: liveRequestAudit))
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
        // After the store exists and before anything consumes events, so an
        // extension is in place for the first frame the store publishes.
        makeExtensions(store: store)
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
        beginHealthRefresh()
    }

    /// Reconnects the profile restored from `UserDefaults`, once, at launch.
    ///
    /// `init` restores `activeProfile` but starts nothing — it cannot, because
    /// activation is async — so a relaunch used to come up with a profile
    /// "active" and no store behind it: the main window never appeared, no
    /// watcher was armed, and no sheet could be routed. `ShepherdApp`'s root
    /// view calls this from its launch task.
    ///
    /// A missing or revoked credential is not this method's problem: the
    /// activation's watcher sees `.needsLogin` and routes the login sheet.
    /// Idempotent — a second call while a store is already running keeps it,
    /// rather than tearing a live activation down and building it again.
    ///
    /// It also never overrules the operator. The launch task is not first by
    /// contract: a Connect for a *different* server sets `sheet = .login(that
    /// one)` without touching `activeProfile`, and if this ran afterwards it
    /// would activate the restored profile and clear that sheet — the operator's
    /// click, silently undone. Two signals say "something already happened
    /// here": a sheet is open, or the activation counter has moved since `init`.
    func restoreActiveProfile() async {
        guard sheet == nil, activationGeneration == 0 else {
            Log.connect.debug("skipping the restore: the operator got there first")
            return
        }
        guard store == nil, let profile = activeProfile else { return }
        Log.connect.info("reconnecting the restored profile \(profile.name, privacy: .public)")
        await activate(profile)
    }

    /// GET /api/health so the banner knows what the server asks of this client.
    ///
    /// Never throws: an unreachable or unparsable health route simply leaves the
    /// versions unknown, which is exactly the state in which the banner says
    /// "cannot reach this server" rather than anything about versions. Awaits
    /// the request, so a caller that wants the answer has it on return.
    func refreshHealth() async {
        await beginHealthRefresh()?.value
    }

    /// Starts — or restarts — the one health request this model owns.
    ///
    /// There is exactly one in flight at a time: a Retry fired during
    /// activation's own request, or a second Retry, cancels the first. Ordering
    /// is not left to the network, because two overlapping requests can answer
    /// out of order and write a *stale* version over a fresh one. Every
    /// completion is gated on `healthGeneration`, captured here, as well as on
    /// the store still being the active one — the store alone does not catch
    /// two requests against the *same* store.
    @discardableResult
    private func beginHealthRefresh() -> Task<Void, Never>? {
        healthTask?.cancel()
        healthGeneration &+= 1
        let generation = healthGeneration
        guard let store else {
            healthTask = nil
            return nil
        }
        // Weak throughout, like `storeRunner`: a model released without a
        // `teardown()` must still be able to let go of its store.
        let task = Task { @MainActor [weak self, weak store] in
            guard let self, let store else { return }
            await runHealth(on: store, generation: generation)
        }
        healthTask = task
        return task
    }

    private func runHealth(on store: SessionStore, generation: Int) async {
        do {
            let reported = try await self.health(store.client)
            guard isCurrentHealthRequest(generation), store === self.store else { return }
            // `Health.ok` is a plain boolean in the contract, not `const: true`,
            // so a server that knows it is unwell decodes perfectly well. Its
            // version is not worth recording — what it reports about itself in
            // that state is not something to compare a minimum against.
            guard reported.ok else {
                Log.connect.debug("the server reported ok: false")
                serverVersion = nil
                serverMinClient = nil
                serverUnhealthy = true
                return
            }
            serverVersion = reported.version
            serverMinClient = reported.minClient
            serverUnhealthy = false
        } catch {
            guard isCurrentHealthRequest(generation), store === self.store else { return }
            Log.connect.debug(
                "health check failed: \(ShepherdErrorCopy.message(error), privacy: .public)")
            // Unknown, not stale. A version kept from an earlier answer is a
            // claim about a server the app can no longer reach, and the banner
            // would go on comparing against it.
            serverVersion = nil
            serverMinClient = nil
            serverUnhealthy = false
        }
    }

    /// False once a newer `beginHealthRefresh()` has superseded this one — the
    /// operator switched servers, or clicked Retry again.
    private func isCurrentHealthRequest(_ generation: Int) -> Bool {
        guard generation == healthGeneration else {
            Log.connect.debug("dropping a health result a newer request superseded")
            return false
        }
        return true
    }

    /// Banner "Retry", as the button calls it: the task belongs to the model, so
    /// a teardown, a deactivate or a profile switch cancels it. A view starting
    /// its own task would leave a request running against a store that is gone.
    ///
    /// `retrying` is set here, synchronously, rather than inside the task body:
    /// two clicks in the same run-loop turn both reach this guard before either
    /// task starts running, and setting the flag only inside the task body let
    /// both pass, leaving `retryTask` pointing at the second (a no-op) while
    /// the first ran untracked.
    func retry() {
        guard !retrying else {
            Log.connect.debug("ignoring a retry while one is already running")
            return
        }
        retrying = true
        let generation = activationGeneration
        retryTask?.cancel()
        retryTask = Task { @MainActor [weak self] in await self?.performRetry(generation: generation) }
    }

    /// Reload the store and re-check health. `refresh()` throws, and its failure
    /// is already recorded in `store.lastError` and `connection`, so there is
    /// nothing for this method to do with it.
    ///
    /// Internal rather than private: the unit tests drive a retry without a
    /// task in between. `retrying` makes the double-click a no-op here too, not
    /// only in `retry()`.
    func retryActive() async {
        guard !retrying else { return }
        retrying = true
        await performRetry(generation: activationGeneration)
    }

    /// The body shared by `retry()` (which already set `retrying = true`
    /// synchronously, before spawning the task this runs in) and `retryActive()`
    /// (which just set it itself, for a caller driving a retry with no task in
    /// between).
    ///
    /// `generation` is the activation this Retry started under, read before any
    /// suspension. A profile switch or a teardown bumps `activationGeneration`
    /// and already resets `retrying` for the activation it is ending — so this
    /// only clears the flag when it still describes the *current* activation.
    /// Resetting it unconditionally let a Retry that a profile switch left
    /// running finish later and clear a *newer* activation's Retry flag out
    /// from under it, even though nothing about that newer Retry had failed.
    private func performRetry(generation: Int) async {
        defer {
            if activationGeneration == generation { retrying = false }
        }
        guard let store else { return }
        try? await store.refresh()
        guard store === self.store else { return }
        await refreshHealth()
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

    /// Ends the activation and keeps the credential — the non-revoking twin of
    /// `signOutActive()`.
    ///
    /// This is what "Add server…" does. Signing out there (the old behaviour)
    /// was a workaround for a welcome screen that could not reach a stored
    /// profile: parking one would have left a live token under a row the
    /// operator could not get back to. `savedServers` closes that gap, so the
    /// token stays and the profile is one click from being active again.
    /// "Sign out" still revokes.
    func deactivate() {
        guard let profile = activeProfile else { return }
        teardown()
        Log.connect.info("parked \(profile.name, privacy: .public) without revoking its token")
    }

    /// `signOutActive()` plus the operator-facing sentence for a revoke the
    /// server refused. The mapping lives here rather than in `MainWindow`
    /// because that window is unmounted by the time the call returns — a view
    /// that is gone is also a view no test can reach, which is how the wiring
    /// stayed uncovered.
    ///
    /// Writes `signOutWarning` *after* the teardown inside `signOutActive()`,
    /// which clears it.
    func signOutActiveReporting() async {
        guard let error = await signOutActive() else { return }
        signOutWarning = L.t("native_signout_failed", ShepherdErrorCopy.message(error))
    }

    // MARK: - Internals

    /// Whether the Keychain answered for `profile` inside `credentialTimeout`.
    ///
    /// This is the pre-flight `activate(_:)` owes every activation. The token
    /// this profile is signed in with is read synchronously — by the event
    /// stream when it opens the socket, and by `AuthenticationMiddleware` on
    /// every single request — and `SecItemCopyMatching` against the legacy
    /// (file-based) Keychain **blocks until a SecurityAgent decision**. An
    /// ad-hoc signature changes with every build, so a new build is exactly the
    /// case where the item's ACL no longer names the app asking for it, and the
    /// prompt that decides it can sit queued behind another process's, invisible.
    /// What the operator saw was the whole of it: the store never got past
    /// `.connecting`, which is the one connection state with no banner and no
    /// sheet — a main window with an empty sidebar, for as long as they waited.
    ///
    /// The reader is deliberately *not* cancelled on the way out: a blocking
    /// `SecItemCopyMatching` cannot be interrupted, and the timer losing the
    /// race is the only thing this method can act on. It is one throwaway
    /// global-queue thread, and it ends when the Keychain finally answers.
    private func credentialAnswers(for profile: ServerProfile) async -> Bool {
        let gate = ProbeGate()
        let probe = credentialProbe
        let credentials = self.credentials
        let key = profile.credentialKey
        let timeout = credentialTimeout

        Task.detached {
            await probe(credentials, key)
            await gate.settle(true)
        }
        let timer = Task.detached {
            try? await Task.sleep(for: timeout)
            await gate.settle(false)
        }
        let answered = await gate.value()
        timer.cancel()
        return answered
    }

    /// Turns the store's connection state into sheet routing.
    ///
    /// `SessionStore.connection` is `@Observable`-tracked, so this suspends on
    /// `withObservationTracking` and wakes on the next mutation — no timer, no
    /// missed transition. `withObservationTracking` fires `onChange` exactly once,
    /// which is why the loop re-registers on every pass.
    ///
    /// The wake-up channel is an `AsyncStream`, not a bare
    /// `withCheckedContinuation`: a stream can be **finished**, and cancelling
    /// a task does not resume a checked continuation. The previous shape parked
    /// here forever unless the store happened to publish one more state after
    /// `teardown()` — `stop()` only writes `connection` when it is not already
    /// `.idle` — so the loop, its `ConnectionSource` and the observation
    /// registration inside the store survived every profile switch and every
    /// closed window. `teardown()` (and the next `activate(_:)`) now finishes
    /// the stream, `next()` returns `nil`, and the task runs off the end.
    /// Finishing twice, or yielding into a finished stream, is a no-op, so
    /// there is no double-resume to get wrong either.
    ///
    /// Arming is re-entrant: this method cancels and finishes the watcher it is
    /// replacing, so a second call can never leave two loops reading the same
    /// store, and it stamps the new one with a `connectionWatcherToken` so the
    /// predecessor's cleanup cannot clear `isWatchingConnection` out from under
    /// its replacement.
    ///
    /// Internal, not private: the unit tests drive it with their own
    /// `ConnectionSource` so the re-arm contract is covered without a server.
    func watchConnection(
        _ source: ConnectionSource, profile: ServerProfile, generation: Int
    ) {
        guard let initial = source.read() else { return }

        connectionSource = source
        watchedProfile = profile
        // Finish *and* cancel the watcher being replaced. Assigning over
        // `connectionWatcher` below only drops the reference; without the
        // cancel a re-arm could leave the old loop running beside the new one.
        connectionSignal?.finish()
        connectionWatcher?.cancel()
        let (changes, signal) = AsyncStream<Void>.makeStream()
        connectionSignal = signal
        connectionWatcherToken &+= 1
        let token = connectionWatcherToken
        isWatchingConnection = true
        connectionWatcher = Task { @MainActor [weak self] in
            // Only the watcher the model still owns may report the loop gone:
            // the predecessor cancelled above unwinds *after* this one armed
            // itself, and an unconditional clear here would publish a false
            // `false` over a live watcher.
            defer {
                if self?.connectionWatcherToken == token { self?.isWatchingConnection = false }
            }
            var iterator = changes.makeAsyncIterator()
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
                        // park this task on a signal no write can ever send.
                        guard let latest = source.read() else { return }
                        if latest != current {
                            current = latest
                            routed = true
                            self.routeSheet(for: latest, profile: profile)
                        }
                    }
                }
                if routed { continue }

                withObservationTracking {
                    _ = source.read()
                } onChange: {
                    signal.yield()
                }
                // `nil` means the stream was finished — an activation ended —
                // which is the one exit cancellation alone could never give us.
                guard await iterator.next() != nil else { return }
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

    /// Re-runs routing for the state the live activation is *already* in, after
    /// a sheet that was holding the floor closed. Nothing happens once the
    /// activation has ended: there is no connection left to route.
    private func routeAfterSheetClose() {
        guard let profile = watchedProfile, let state = connectionSource?.read() else { return }
        routeSheet(for: state, profile: profile)
    }

    /// Drops a selection whose session is no longer listed.
    ///
    /// Archiving from this window clears its own selection, but a session
    /// archived anywhere else arrives as an event that simply removes the row:
    /// the selection then pointed at nothing while the toolbar's session
    /// commands stayed enabled for it. Internal, and driven from the window's
    /// `onChange` over the session ids.
    func reconcileSelection(against ids: [String]) {
        guard let id = selectedSessionID, !ids.contains(id) else { return }
        selectedSessionID = nil
        Log.ui.debug("cleared a selection whose session is no longer listed")
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
        // The cancel above only sets a flag; this is what wakes the suspended
        // loop so it can observe it and let go of everything it captured.
        connectionSignal?.finish()
        connectionSignal = nil
        // Before `sheet = nil` below, so closing it routes nothing.
        connectionSource = nil
        watchedProfile = nil
        storeRunner?.cancel()
        storeRunner = nil
        healthTask?.cancel()
        healthTask = nil
        retryTask?.cancel()
        retryTask = nil
        retrying = false
        tearDownExtensions()
        // stop() also publishes `connection = .idle`, which releases the
        // watcher's continuation so the cancelled task can actually finish.
        store?.stop()
        store = nil
        serverVersion = nil
        serverMinClient = nil
        serverUnhealthy = false
        activeProfile = nil
        sheet = nil
        selectedSessionID = nil
        // A notice about the activation that is ending must not outlive it.
        signOutWarning = nil
        persist()
    }

    private func persist() {
        persistence.save(profiles: profiles, activeID: activeProfile?.id)
    }
}
