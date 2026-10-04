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
    private(set) var focusedID: UUID?
    var managingServers = false
    var lens: HerdLens = .all
    var selectedRepos: Set<String> = []
    var collapsedStages: Set<HerdStage> = []
    @ObservationIgnored private let defaults: UserDefaults
    @ObservationIgnored private let makeModel: (UUID) -> AppModel
    @ObservationIgnored private var started = false
    @ObservationIgnored private var removing: Set<UUID> = []

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
        for id in connectedIDs { models[id] = makeModel(id) }
        focusedID = connectedIDs.first
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
    var hasSidebar: Bool { connected.contains { $0.extension(SidebarModel.self) != nil } }
    var hasLoadedList: Bool { connected.contains { $0.store?.hasLoadedSessions == true } }

    func start(launch: IOSLaunchEnvironment) async {
        guard !started else { return }; started = true
        if launch.configuration.isIsolated {
            await launch.start(catalogue)
            if let profile = catalogue.activeProfile { adopt(catalogue, profile: profile) }
        } else {
            let tasks = connectedIDs.compactMap { id -> Task<Void, Never>? in
                guard let profile = profiles.first(where: { $0.id == id }), let model = models[id] else { return nil }
                return Task { [weak self, weak model] in
                    guard let model, self?.models[id] === model, model.sheet == nil, model.activationGeneration == 0 else { return }
                    await model.activate(profile)
                    model.extension(SidebarModel.self)?.lens = self?.lens ?? .all
                }
            }
            for task in tasks { await task.value }
        }
    }

    func connect(_ profile: ServerProfile, login: Bool = false) async {
        guard !removing.contains(profile.id), profiles.contains(where: { $0.id == profile.id }) else { return }
        if let model = models[profile.id] {
            if model.store == nil || model.store?.connection == .needsLogin { model.sheet = .login(profile) }
            return
        }
        let model = makeModel(profile.id)
        model.reloadProfiles()
        models[profile.id] = model
        connectedIDs.append(profile.id)
        if focusedID == nil { focusedID = profile.id }
        persist()
        if login { model.sheet = .login(profile); return }
        await model.activate(profile)
        model.extension(SidebarModel.self)?.lens = lens
    }

    /// Fixture/live launches already own an activated model and its credential lifetime.
    func adopt(_ model: AppModel, profile: ServerProfile) {
        models[profile.id] = model
        if !connectedIDs.contains(profile.id) { connectedIDs.append(profile.id) }
        focusedID = profile.id
        persist()
    }

    func disconnect(_ profileID: UUID) {
        models.removeValue(forKey: profileID)?.deactivate()
        connectedIDs.removeAll { $0 == profileID }
        if focusedID == profileID { focusedID = connectedIDs.first }
        persist()
    }

    func signOutFocused() async {
        let model = focused
        guard let id = model.activeProfile?.id else { return }
        await model.signOutActiveReporting()
        let warning = model.signOutWarning
        disconnect(id)
        catalogue.signOutWarning = warning
    }

    func remove(_ profile: ServerProfile) async {
        guard removing.insert(profile.id).inserted else { return }
        let owner = models[profile.id]
        disconnect(profile.id)
        // Keep the outgoing model’s remove/sign-in guards in charge of late token mints.
        // Its catalogue is read-only; the catalogue model performs the persisted deletion.
        await owner?.remove(profile)
        catalogue.reloadProfiles()
        await catalogue.remove(profile)
        reloadCatalogue()
        removing.remove(profile.id)
    }

    func reloadCatalogue() {
        catalogue.reloadProfiles()
        for model in connected { model.reloadProfiles() }
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
        model.extension(DetailModel.self)?.retainSession(identity.sessionID)
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

    func toggleRepo(_ path: String) { selectedRepos = selectedRepos == [path] ? [] : [path] }
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
    /// never silently open the same ID on an unrelated server.
    func notificationTargets(sessionID: String, server: String?) -> [IOSSessionIdentity] {
        guard !sessionID.isEmpty else { return [] }
        if let server, !server.isEmpty {
            return connectedIDs.compactMap { id in
                guard let profile = profiles.first(where: { $0.id == id }),
                      server == id.uuidString || Self.origin(server) == Self.origin(profile.baseURL.absoluteString) else { return nil }
                return .init(profileID: id, sessionID: sessionID)
            }
        }
        return connectedIDs.compactMap { id in
            guard let model = models[id], model.store?.session(id: sessionID) != nil ||
                model.extension(QueuesModel.self)?.finishedSessions.contains(where: { $0.id == sessionID }) == true else { return nil }
            return .init(profileID: id, sessionID: sessionID)
        }
    }
    private static func origin(_ address: String) -> String? {
        guard let components = URLComponents(string: address), let host = components.host, let scheme = components.scheme else { return nil }
        return "\(scheme.lowercased())://\(host.lowercased()):\(components.port ?? (scheme.lowercased() == "https" ? 443 : 80))"
    }
    private func persist() { defaults.set(connectedIDs.map(\.uuidString), forKey: Self.connectedKey) }
}
