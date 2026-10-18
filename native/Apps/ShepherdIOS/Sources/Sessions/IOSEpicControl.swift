import Foundation
import Observation
import ShepherdKit
import ShepherdAppCore

@MainActor @Observable
final class IOSEpicControl {
    let group: IOSMergedSessionPresentation.EpicGroup
    let owner: AppModel
    private weak var directory: IOSEpicDirectory?
    private let activation: Int
    private let store: SessionStore?
    @ObservationIgnored private let readLeader: (ShepherdClient, String) async throws -> Int?
    @ObservationIgnored private let write: (ShepherdClient, String, Int, Components.Schemas.EpicRunPatch, Bool) async throws -> Epic
    @ObservationIgnored private let approveNext: (ShepherdClient, String, Int) async throws -> Epic
    var busy = false
    var error: String?
    var leader: Int?
    private var pendingStart: Components.Schemas.EpicRunPatch?
    var current: Bool { owner.activationGeneration == activation && owner.store === store && store != nil && owner.activeProfile?.id == group.profile.id }
    var writable: Bool { current && owner.liveRequestAudit == nil }
    var digest: EpicDigest? { directory?.digest(group, owner: owner) }

    init(group: IOSMergedSessionPresentation.EpicGroup, owner: AppModel, directory: IOSEpicDirectory,
         readLeader: @escaping (ShepherdClient, String) async throws -> Int? = { client, path in
             try await client.listDrain().first { $0.repoPath == path }?.runSummary?.leadingEpic
         }, write: @escaping (ShepherdClient, String, Int, Components.Schemas.EpicRunPatch, Bool) async throws -> Epic = {
             try await $0.updateEpic(repoPath: $1, parent: $2, patch: $3, requeueLeader: $4)
         }, approveNext: @escaping (ShepherdClient, String, Int) async throws -> Epic = {
             try await $0.approveEpicNext(repoPath: $1, parent: $2)
         }) {
        self.group = group; self.owner = owner; self.directory = directory
        activation = owner.activationGeneration; store = owner.store
        self.readLeader = readLeader; self.write = write; self.approveNext = approveNext
    }
    func load() async {
        guard current, !busy else { return }
        busy = true; error = nil
        defer { busy = false }
        do { try await directory?.loadDetail(group, owner: owner) }
        catch { if current { self.error = L.t("native_ios_epic_load_failed") } }
    }
    func update(_ patch: Components.Schemas.EpicRunPatch, requeueLeader: Bool? = nil) async {
        guard writable, !busy, let store else { return }
        busy = true; error = nil
        defer { busy = false }
        do {
            if patch.status == .running, requeueLeader == nil {
                // Starting supersedes silently on the server. Mirror web: never start blind.
                let other = try await readLeader(store.client, group.repoPath)
                guard current else { return }
                if let other,
                   other != group.parentNumber {
                    pendingStart = patch; leader = other; return
                }
            }
            let epic = try await write(store.client, group.repoPath, group.parentNumber, patch, requeueLeader ?? false)
            guard current else { return }
            directory?.accept(epic, group: group, owner: owner)
        } catch { if current { self.error = L.t("epic_update_failed") + ": " + ShepherdErrorCopy.message(error) } }
    }
    func approve() async {
        guard writable, !busy, let store, let epic = digest?.epic,
              IOSEpicPolicy.actions(epic).contains(.approve) else { return }
        busy = true; error = nil
        defer { busy = false }
        do {
            let epic = try await approveNext(store.client, group.repoPath, group.parentNumber)
            guard current else { return }
            directory?.accept(epic, group: group, owner: owner)
        } catch { if current { self.error = L.t("epic_approve_failed") + ": " + ShepherdErrorCopy.message(error) } }
    }
    func observe() async {
        guard current, let store else { return }
        // Events carry whole graphs; every presentation also reloads, so a dropped event heals.
        for await event in store.events() {
            guard !Task.isCancelled, current else { return }
            if case .unknown(let name, let payload) = event, name == "epic:update", let payload,
               let epic = try? JSONDecoder().decode(Epic.self, from: payload),
               epic.repoPath == group.repoPath, epic.parentIssueNumber == group.parentNumber {
                directory?.accept(epic, group: group, owner: owner)
            }
        }
    }
    func confirm(requeue: Bool) {
        guard let patch = pendingStart else { return }
        cancelStart()
        Task { await update(patch, requeueLeader: requeue) }
    }
    func cancelStart() { leader = nil; pendingStart = nil }
    func perform(_ action: IOSEpicPolicy.Action) async {
        switch action {
        case .pause: await update(.init(status: .paused))
        case .resume: await update(.init(status: .running))
        case .approve: await approve()
        }
    }
}
