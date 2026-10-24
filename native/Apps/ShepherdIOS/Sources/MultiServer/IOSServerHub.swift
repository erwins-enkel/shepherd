import Foundation
import Observation
import ShepherdAppCore
import ShepherdKit

struct IOSSessionIdentity: Hashable {
    let profileID: UUID
    let sessionID: String
}

/// Owns the catalogue; server models only persist their own activation key.
@Observable
@MainActor
final class IOSServerHub {
    static let connectedKey = "run.shepherd.ios.connectedProfileIDs"
    let catalogue: AppModel
    private(set) var models: [UUID: AppModel] = [:]
    private(set) var connectedIDs: [UUID] = []
    private var requestedFocusID: UUID?
    private var hasExplicitFocus = false
    private(set) var focusedID: UUID? {
        get {
            if let id = requestedFocusID, let model = models[id],
                hasExplicitFocus || model.selectedSessionID != nil || model.sheet != nil || isLive(model) { return id }
            return connectedIDs.first { models[$0].map(isLive) == true }
                ?? connectedIDs.first { models[$0].map { $0.store != nil && !isUnavailable($0) } == true }
                ?? requestedFocusID
        }
        set {
            requestedFocusID = newValue
            hasExplicitFocus = true
        }
    }
    private(set) var unavailableIDs: Set<UUID> = []
    private var noticeIDs: Set<UUID> = []
    private var dismissedIDs: Set<UUID> = []
    @ObservationIgnored private var watchers: [UUID: ConnectionWatch] = [:]
    @ObservationIgnored private var refreshTasks: [UUID: Task<Void, Never>] = [:]
    private final class ConnectionWatch {
        var task: Task<Void, Never>?
        var deadline: Task<Void, Never>?
        let signal: AsyncStream<Void>.Continuation
        init(_ signal: AsyncStream<Void>.Continuation) { self.signal = signal }
        deinit { task?.cancel(); deadline?.cancel(); signal.finish() }
    }
    var managingServers = false
    var lens: HerdLens = .all
    var selectedRepos: Set<String> = []
    var collapsedStages: Set<HerdStage> = []
    @ObservationIgnored private let defaults: UserDefaults
    @ObservationIgnored private let makeModel: (UUID) -> AppModel
    @ObservationIgnored private var started = false
    @ObservationIgnored private var removing: Set<UUID> = []
    @ObservationIgnored private var authenticationQueues: [UUID: AppAuthenticationQueue] = [:]
    @ObservationIgnored private var retired: [UUID: [RetiredModel]] = [:]
    private var loadingIDs: Set<UUID> = []
    private final class RetiredModel {
        weak var model: AppModel?
        init(_ model: AppModel) { self.model = model }
    }

    private func newModel(_ id: UUID) -> AppModel {
        let model = makeModel(id)
        let queue = authenticationQueues[id] ?? AppAuthenticationQueue()
        authenticationQueues[id] = queue
        model.authenticationQueue = queue
        return model
    }

    init(defaults: UserDefaults, catalogue: AppModel, makeModel: @escaping (UUID) -> AppModel) {
        self.defaults = defaults
        self.catalogue = catalogue
        self.makeModel = makeModel
        let saved: [UUID]
        if let raw = defaults.array(forKey: Self.connectedKey) as? [String] {
            saved = raw.compactMap(UUID.init(uuidString:))
        } else {
            saved = defaults.string(forKey: "run.shepherd.mac.activeProfileID")
                .flatMap(UUID.init(uuidString:)).map { [$0] } ?? []
        }
        connectedIDs = saved.reduce(into: []) { ids, id in
            if catalogue.profiles.contains(where: { $0.id == id }), !ids.contains(id) { ids.append(id) }
        }
        persist()
        loadingIDs = Set(connectedIDs)
        for id in connectedIDs {
            let model = newModel(id)
            models[id] = model
            watchConnection(id, model: model)
        }
        requestedFocusID = connectedIDs.first
    }

    convenience init(launch: IOSLaunchEnvironment) {
        self.init(defaults: launch.defaults,
            catalogue: launch.makeModel(activeProfileKey: "run.shepherd.ios.catalogue.active"),
            makeModel: { launch.makeModel(activeProfileKey: "run.shepherd.ios.active.\($0)", persistsProfileCatalogue: false) })
    }

    var profiles: [ServerProfile] { catalogue.profiles }
    var connected: [AppModel] { connectedIDs.compactMap { models[$0] } }
    var focused: AppModel { focusedID.flatMap { models[$0] } ?? connected.first ?? catalogue }
    var selection: IOSSessionIdentity? {
        guard let id = focusedID, let sessionID = focused.selectedSessionID else { return nil }
        return .init(profileID: id, sessionID: sessionID)
    }
    /// Extensions are not observable; reading `store` (set in the same main-actor turn)
    /// lets a cold-launch root view leave the server list once a restore activates.
    var hasSidebar: Bool { connected.contains { $0.store != nil && $0.extension(SidebarModel.self) != nil } }
    var hasLoadedList: Bool { connected.contains { $0.store?.hasLoadedSessions == true } }

    func start(launch: IOSLaunchEnvironment) async {
        guard !started else { return }; started = true
        if launch.configuration.isIsolated {
            await launch.start(catalogue)
            if let profile = catalogue.activeProfile { adopt(catalogue, profile: profile) }
        } else {
            for id in connectedIDs {
                guard let profile = profiles.first(where: { $0.id == id }), let model = models[id] else { continue }
                Task { [weak self, weak model] in
                    guard let model, self?.models[id] === model else { return }
                    defer { if self?.models[id] === model { self?.loadingIDs.remove(id) } }
                    guard model.sheet == nil, model.activationGeneration == 0 else { return }
                    await model.authenticationQueue?.waitForIdle()
                    guard self?.models[id] === model, model.sheet == nil, model.activationGeneration == 0 else { return }
                    await model.activate(profile)
                    model.extension(SidebarModel.self)?.lens = self?.lens ?? .all
                }
            }
        }
    }

    func connect(_ profile: ServerProfile, login: Bool = false) async {
        guard !removing.contains(profile.id), profiles.contains(where: { $0.id == profile.id }) else { return }
        if let model = models[profile.id] {
            focus(profile.id)
            if login || model.store?.connection == .needsLogin {
                model.sheet = .login(profile)
            } else if !loadingIDs.contains(profile.id), model.store == nil, model.sheet == nil {
                if model.activeProfile != nil {
                    loadingIDs.insert(profile.id)
                    defer { if models[profile.id] === model { loadingIDs.remove(profile.id) } }
                    await model.retryCredentialAccess()
                } else {
                    model.sheet = .login(profile)
                }
            }
            return
        }
        let model = newModel(profile.id)
        model.reloadProfiles()
        models[profile.id] = model
        watchConnection(profile.id, model: model)
        connectedIDs.append(profile.id)
        focus(profile.id)
        persist()
        if login { model.sheet = .login(profile); return }
        loadingIDs.insert(profile.id)
        defer { if models[profile.id] === model { loadingIDs.remove(profile.id) } }
        let generation = model.activationGeneration
        await model.authenticationQueue?.waitForIdle()
        guard models[profile.id] === model, model.activationGeneration == generation else { return }
        await model.activate(profile)
        model.extension(SidebarModel.self)?.lens = lens
    }

    /// Pair on the per-server model so authentication shares its queue with sign-in/removal.
    func pair(link: PairingLink, deviceName: String) async throws {
        let profile = try catalogue.addRemoteProfile(name: "", address: link.baseURL.absoluteString)
        guard !removing.contains(profile.id) else { throw CancellationError() }
        let existing = models[profile.id]
        let model = existing ?? newModel(profile.id)
        model.reloadProfiles()
        models[profile.id] = model
        do {
            try await model.pair(link: link, deviceName: deviceName)
            guard models[profile.id] === model, !removing.contains(profile.id) else { throw CancellationError() }
            if !connectedIDs.contains(profile.id) { connectedIDs.append(profile.id) }
            if existing == nil { watchConnection(profile.id, model: model) }
            focusedID = profile.id
            managingServers = false
            persist()
            model.extension(SidebarModel.self)?.lens = lens
        } catch {
            if existing == nil, models[profile.id] === model {
                model.deactivate()
                models.removeValue(forKey: profile.id)
            }
            throw error
        }
    }

    /// Fixture/live launches already own an activated model and its credential lifetime.
    func adopt(_ model: AppModel, profile: ServerProfile) {
        models[profile.id] = model
        watchConnection(profile.id, model: model)
        if !connectedIDs.contains(profile.id) { connectedIDs.append(profile.id) }
        requestedFocusID = profile.id
        hasExplicitFocus = false
        persist()
    }

    func disconnect(_ profileID: UUID) {
        if let model = models.removeValue(forKey: profileID) {
            // A suspended sign-in keeps the model alive. Keep a weak removal route until
            // its complete sign-in (including late-token cleanup) has returned.
            var pending = retired[profileID, default: []].filter { ($0.model?.pendingSignIns ?? 0) > 0 }
            if model.pendingSignIns > 0 { pending.append(RetiredModel(model)) }
            retired[profileID] = pending.isEmpty ? nil : pending
            model.deactivate(includingPendingActivation: true)
        }
        watchers.removeValue(forKey: profileID)
        refreshTasks.removeValue(forKey: profileID)?.cancel()
        unavailableIDs.remove(profileID); noticeIDs.remove(profileID); dismissedIDs.remove(profileID)
        loadingIDs.remove(profileID)
        connectedIDs.removeAll { $0 == profileID }
        if requestedFocusID == profileID {
            requestedFocusID = connectedIDs.first
            hasExplicitFocus = false
        }
        persist()
    }

    func signOutFocused() async {
        let model = focused
        guard let id = model.activeProfile?.id else { return }
        let generation = model.activationGeneration
        await model.signOutActiveReporting()
        let warning = model.signOutWarning
        guard models[id] === model, model.activeProfile == nil,
              model.activationGeneration == generation &+ 1 else { return }
        disconnect(id)
        catalogue.signOutWarning = warning
    }

    func remove(_ profile: ServerProfile) async {
        guard removing.insert(profile.id).inserted else { return }
        let owners = ([models[profile.id]] + retired[profile.id, default: []].map(\.model)).compactMap { $0 }
        disconnect(profile.id)
        // Keep the outgoing model’s remove/sign-in guards in charge of late token mints.
        // Its catalogue is read-only; the catalogue model performs the persisted deletion.
        for owner in owners { await owner.remove(profile) }
        retired.removeValue(forKey: profile.id)
        catalogue.reloadProfiles()
        await catalogue.remove(profile)
        reloadCatalogue()
        removing.remove(profile.id)
    }

    func reloadCatalogue() {
        catalogue.reloadProfiles()
        for model in connected { model.reloadProfiles() }
    }

    /// Honor an explicit focus; otherwise default to a live server.
    var composeModel: AppModel? {
        let candidates = ([focused] + connected.filter { $0 !== focused }).filter { $0.store != nil && $0.liveRequestAudit == nil }
        if hasExplicitFocus, let model = candidates.first(where: { $0 === focused }) { return model }
        return candidates.first(where: isLive) ?? candidates.first { !isUnavailable($0) } ?? candidates.first
    }

    @discardableResult
    func openComposer() -> Bool {
        guard let model = composeModel else { return false }
        guard IOSComposer.open(model) else { return false }
        if let id = connectedIDs.first(where: { models[$0] === model }) { focus(id) }
        return true
    }

    /// A no-store login has no automatic lookup left to finish after dismissal.
    /// Restored/connecting models and running sign-ins still have a lookup ahead.
    func awaitsNotificationLookup(_ app: AppModel) -> Bool {
        if app.store?.hasLoadedSessions == true || isUnavailable(app) { return false }
        if let connection = app.store?.connection {
            switch connection {
            case .offline, .needsLogin, .firstRunPending: return false
            default: return true
            }
        }
        return app.activeProfile != nil || app.pendingSignIns > 0 || connectedIDs.contains { models[$0] === app && loadingIDs.contains($0) }
    }

    func isUnavailable(_ model: AppModel) -> Bool {
        if case .offline = model.store?.connection { return true }
        if case .transport = model.store?.lastError { return true }
        return connectedIDs.contains { models[$0] === model && unavailableIDs.contains($0) }
    }
    func isLive(_ model: AppModel) -> Bool { model.store?.connection == .live && !isUnavailable(model) }

    func showsUnavailableNotice(_ id: UUID) -> Bool { noticeIDs.contains(id) }
    func dismissUnavailableNotice(_ id: UUID) {
        if unavailableIDs.contains(id) { dismissedIDs.insert(id) }
        noticeIDs.remove(id)
    }
    private func markUnavailable(_ id: UUID) {
        unavailableIDs.insert(id)
        if !dismissedIDs.contains(id) { noticeIDs.insert(id) }
        IOSPushRegistration.shared.routePendingNotification()
    }

    private func watchConnection(_ id: UUID, model: AppModel) {
        let (changes, signal) = AsyncStream<Void>.makeStream(bufferingPolicy: .bufferingNewest(1))
        let watch = ConnectionWatch(signal)
        watchers[id] = watch
        watch.task = Task { [weak self, weak model] in
            var iterator = changes.makeAsyncIterator()
            while !Task.isCancelled {
                guard let model, self?.models[id] === model else { return }
                self?.connectionChanged(id, model: model)
                withObservationTracking {
                    _ = model.store?.connection
                    _ = model.store?.lastError
                } onChange: { signal.yield() }
                guard await iterator.next() != nil else { return }
                await Task.yield()
            }
        }
    }

    private func connectionChanged(_ id: UUID, model: AppModel) {
        guard let watch = watchers[id] else { return }
        watch.deadline?.cancel(); watch.deadline = nil
        switch model.store?.connection {
        case .live:
            // Foreground/manual reconciliation can fail while the socket still looks live.
            if case .transport = model.store?.lastError { markUnavailable(id) }
            else { unavailableIDs.remove(id); dismissedIDs.remove(id) }
            // Notices remain until Close, even if the server has recovered.
        case .offline:
            markUnavailable(id)
        case .connecting, .idle:
            guard let store = model.store else { return }
            if case .transport = store.lastError { markUnavailable(id); return }
            // Also bound a socket-only reconnect or a transport that never reports failure.
            watch.deadline = Task { [weak self, weak model, weak store] in
                do { try await Task.sleep(for: .seconds(8)) } catch { return }
                guard let model, let store, self?.models[id] === model, model.store === store,
                    store.connection == .connecting || store.connection == .idle else { return }
                self?.markUnavailable(id)
            }
        default: break
        }
    }

    /// Each server publishes its own result; no peer participates in a UI completion barrier.
    func refreshServers() {
        for id in connectedIDs {
            guard refreshTasks[id] == nil, let model = models[id], let store = model.store else { continue }
            refreshTasks[id] = Task { [weak self, weak model, weak store] in
                guard let model, let store else { return }
                defer { if self?.models[id] === model { self?.refreshTasks[id] = nil } }
                let generation = model.activationGeneration
                do { try await store.refresh() }
                catch {
                    guard self?.models[id] === model, model.store === store,
                        generation == model.activationGeneration, !Task.isCancelled else { return }
                    if case .transport = ShepherdError.from(error, route: "refresh") { self?.markUnavailable(id) }
                    return
                }
                guard self?.models[id] === model, model.store === store,
                    generation == model.activationGeneration, !Task.isCancelled else { return }
                await model.extension(ReadOnlySidebarRecovery.self)?.refresh()
            }
        }
    }

    /// A reachable server whose instance ID is still being read: it may be the one that runs
    /// a tapped session.
    func awaitsInstanceIdentity(_ app: AppModel) -> Bool {
        guard let store = app.store, let identity = app.extension(IOSInstanceIdentity.self), !identity.settled,
              !isUnavailable(app) else { return false }
        switch store.connection {
        case .offline, .needsLogin, .firstRunPending: return false
        default: return true
        }
    }

    func focus(_ profileID: UUID) {
        guard models[profileID] != nil else { return }
        focusedID = profileID
    }

    func select(_ identity: IOSSessionIdentity) {
        guard let model = models[identity.profileID] else { return }
        if focusedID != identity.profileID { focused.selectedSessionID = nil }
        focusedID = identity.profileID
        model.selectedSessionID = identity.sessionID
        // A session mirrored from a connected machine has none of this server's detail reads.
        let mirrored = model.store?.remoteSession(id: identity.sessionID) != nil
        model.extension(DetailModel.self)?.retainSession(mirrored ? nil : identity.sessionID)
        let session = model.store?.session(id: identity.sessionID)
        model.extension(IOSPlanController.self)?.select(session, model: model.extension(PlanModel.self))
        if let session, let plan = model.extension(PlanModel.self), IOSPlanPresentation.opensPlan(session: session, model: plan) {
            plan.openPlan(identity.sessionID)
        }
    }

    func setLens(_ lens: HerdLens) {
        self.lens = lens
        for model in connected { model.extension(SidebarModel.self)?.lens = lens }
    }

    func toggleRepo(_ paths: Set<String>) { selectedRepos = selectedRepos == paths ? [] : paths }
    func toggleCollapsed(_ stage: HerdStage) {
        if !collapsedStages.insert(stage).inserted { collapsedStages.remove(stage) }
    }

    struct RoutedSheet: Identifiable {
        let model: AppModel
        let sheet: AppSheet
        var id: String { "\(ObjectIdentifier(model))-\(sheet.id)" }
    }
    var routedSheet: RoutedSheet? {
        // An explicit composer stays up while another server needs authentication.
        let candidates = [focused] + connected.filter { $0 !== focused }
        return candidates.compactMap { model in model.sheet.map { RoutedSheet(model: model, sheet: $0) } }.first
    }
    func dismissSheet() { routedSheet?.model.sheet = nil }

    /// Older servers send only a session ID. A collision must ask the operator to choose,
    /// never silently open the same ID on an unrelated server. `instance` names the machine that
    /// runs the session (#3058): its own connection opens it, else one that mirrors it.
    func notificationTargets(sessionID: String, server: String?, instance: String? = nil) -> [IOSSessionIdentity] {
        guard !sessionID.isEmpty else { return [] }
        if let server, !server.isEmpty {
            return connectedIDs.compactMap { id in
                guard let profile = profiles.first(where: { $0.id == id }),
                      server == id.uuidString || Self.origin(server) == Self.origin(profile.baseURL.absoluteString) else { return nil }
                return .init(profileID: id, sessionID: sessionID)
            }
        }
        let instanceOf = { (id: UUID) in self.models[id]?.extension(IOSInstanceIdentity.self)?.instanceID }
        if let instance, !instance.isEmpty {
            if let owner = connectedIDs.first(where: { instanceOf($0) == instance }) {
                return [.init(profileID: owner, sessionID: sessionID)]
            }
            // Every mirror shows the same session; prefer the focused one.
            let mirrors = connectedIDs.filter { models[$0]?.store?.remoteSession(id: sessionID)?.host?.instanceId == instance }
            if let mirror = mirrors.first(where: { $0 == focusedID }) ?? mirrors.first {
                return [.init(profileID: mirror, sessionID: sessionID)]
            }
        }
        return connectedIDs.compactMap { id in
            // A server known to be another machine does not run this session.
            if let instance, !instance.isEmpty, let known = instanceOf(id), known != instance { return nil }
            guard let model = models[id], model.store?.session(id: sessionID) != nil ||
                model.extension(QueuesModel.self)?.finishedSessions.contains(where: { $0.id == sessionID }) == true ||
                model.extension(QueuesModel.self)?.notificationSession?.id == sessionID else { return nil }
            return .init(profileID: id, sessionID: sessionID)
        }
    }
    private static func origin(_ address: String) -> String? {
        guard let components = URLComponents(string: address), let host = components.host, let scheme = components.scheme else { return nil }
        return "\(scheme.lowercased())://\(host.lowercased()):\(components.port ?? (scheme.lowercased() == "https" ? 443 : 80))"
    }
    private func persist() { defaults.set(connectedIDs.map(\.uuidString), forKey: Self.connectedKey) }
}
