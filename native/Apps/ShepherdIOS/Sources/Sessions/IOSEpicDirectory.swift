import Foundation
import Observation
import ShepherdAppCore
import ShepherdKit

/// Repo summaries and full epics belong to the owning model's activation, never to a session ID.
@MainActor
@Observable
final class IOSEpicDirectory {
    private struct Entry {
        let owner: ObjectIdentifier
        let generation: Int
        let request: UUID
        var parents: Set<Int>
        var fingerprint: String?
        var summaries: [EpicSummary]
        var digests: [Int: EpicDigest]
    }
    private var revisions: [String: Int] = [:]
    @ObservationIgnored private var controls: [String: IOSEpicControl] = [:]
    private var entries: [String: Entry] = [:]
    @ObservationIgnored private var pending: [UUID: Task<Void, Never>] = [:]
    @ObservationIgnored private let read: (ShepherdClient, String) async throws -> EpicListing
    @ObservationIgnored private let readEpic: (ShepherdClient, String, Int) async throws -> Epic

    init(read: @escaping (ShepherdClient, String) async throws -> EpicListing = {
        try await $0.epics(repoPath: $1)
    }, readEpic: @escaping (ShepherdClient, String, Int) async throws -> Epic = {
        try await $0.epic(repoPath: $1, parent: $2)
    }) {
        self.read = read
        self.readEpic = readEpic
    }

    private func key(_ group: IOSMergedSessionPresentation.EpicGroup) -> String {
        "\(group.profile.id):\(group.repoPath)"
    }

    private func revisionKey(_ group: IOSMergedSessionPresentation.EpicGroup) -> String {
        "\(key(group)):\(group.parentNumber)"
    }

    private func entry(_ group: IOSMergedSessionPresentation.EpicGroup, owner: AppModel) -> Entry? {
        guard let entry = entries[key(group)], entry.owner == ObjectIdentifier(owner),
            entry.generation == owner.activationGeneration else { return nil }
        return entry
    }

    func summary(_ group: IOSMergedSessionPresentation.EpicGroup, owner: AppModel) -> EpicSummary? {
        entry(group, owner: owner)?.summaries.first { $0.parentIssueNumber == group.parentNumber }
    }

    func digest(_ group: IOSMergedSessionPresentation.EpicGroup, owner: AppModel) -> EpicDigest? {
        entry(group, owner: owner)?.digests[group.parentNumber]
    }

    func control(_ group: IOSMergedSessionPresentation.EpicGroup, owner: AppModel) -> IOSEpicControl {
        let id = "\(group.id):\(ObjectIdentifier(owner)):\(owner.activationGeneration)"
        if let control = controls[id] { return control }
        // Retain controls only for live activations. They own request state shared by header/detail.
        controls = controls.filter { $0.value.current }
        let control = IOSEpicControl(group: group, owner: owner, directory: self)
        controls[id] = control
        return control
    }

    func accept(_ epic: Epic, group: IOSMergedSessionPresentation.EpicGroup, owner: AppModel) {
        guard owner.activeProfile?.id == group.profile.id, epic.repoPath == group.repoPath,
              epic.parentIssueNumber == group.parentNumber else { return }
        let id = key(group)
        revisions[revisionKey(group), default: 0] += 1
        if entry(group, owner: owner) == nil {
            entries[id] = Entry(owner: ObjectIdentifier(owner), generation: owner.activationGeneration,
                request: UUID(), parents: [], summaries: [], digests: [:])
        }
        entries[id]?.digests[epic.parentIssueNumber] = EpicDigest(epic)
        entries[id]?.parents.insert(epic.parentIssueNumber)
        // Do not leave a stale summary beside the returned graph.
        entries[id]?.summaries.removeAll { $0.parentIssueNumber == epic.parentIssueNumber }
    }

    func loadDetail(_ group: IOSMergedSessionPresentation.EpicGroup, owner: AppModel) async throws {
        guard let store = owner.store else { throw ShepherdError.cancelled }
        let generation = owner.activationGeneration, revision = revisions[revisionKey(group), default: 0]
        let epic = try await readEpic(store.client, group.repoPath, group.parentNumber)
        guard !Task.isCancelled, owner.store === store, owner.activationGeneration == generation,
              revisions[revisionKey(group), default: 0] == revision else { return }
        accept(epic, group: group, owner: owner)
    }

    func load(_ groups: [IOSMergedSessionPresentation.EpicGroup], owners: [UUID: AppModel],
              fallback: AppModel, force: Bool = false) async {
        // SwiftUI cancels the old load on identity changes. Also cancel explicitly for
        // overlapping refreshes and callers that replace the visible groups themselves.
        guard !Task.isCancelled else { return }
        for task in pending.values { task.cancel() }
        pending.removeAll()
        let repos = Dictionary(grouping: groups, by: key)
        var tasks: [Task<Void, Never>] = []
        for (key, groups) in repos {
            guard let group = groups.first else { continue }
            let owner = owners[group.profile.id] ?? fallback
            guard owner.activeProfile?.id == group.profile.id, let store = owner.store else { continue }
            let identity = ObjectIdentifier(owner), generation = owner.activationGeneration
            let parents = Set(groups.map(\.parentNumber))
            let fingerprint = groups.map(\.fingerprint).sorted().joined(separator: "|")
            let old = entries[key]
            let sameActivation = old?.owner == identity && old?.generation == generation
            if !force, sameActivation, parents.isSubset(of: old?.parents ?? []),
               old?.fingerprint == fingerprint { continue }
            let request = UUID()
            entries[key] = Entry(owner: identity, generation: generation, request: request,
                parents: sameActivation ? old?.parents ?? [] : [],
                // An attempted refresh invalidates completion, even for an unchanged fingerprint.
                fingerprint: nil,
                summaries: sameActivation ? old?.summaries ?? [] : [],
                digests: sameActivation ? old?.digests ?? [:] : [:])
            let task = Task {
                defer { pending[request] = nil }
                guard current(key, request, owner, generation, store) else { return }
                let listing = try? await read(store.client, group.repoPath)
                guard current(key, request, owner, generation, store) else { return }
                var succeeded = listing != nil
                if let listing { entries[key]?.summaries = listing.epics }
                for parent in parents.sorted() {
                    guard current(key, request, owner, generation, store) else { return }
                    let revisionID = "\(key):\(parent)"
                    let revision = revisions[revisionID, default: 0]
                    let epic = try? await readEpic(store.client, group.repoPath, parent)
                    guard current(key, request, owner, generation, store) else { return }
                    if let epic, revisions[revisionID, default: 0] == revision {
                        entries[key]?.digests[parent] = EpicDigest(epic)
                        entries[key]?.parents.insert(parent)
                    } else {
                        succeeded = false
                    }
                }
                guard current(key, request, owner, generation, store) else { return }
                // A failed read retains the known copy; unknown parents use the number-only header.
                if succeeded { entries[key]?.fingerprint = fingerprint }
            }
            pending[request] = task
            tasks.append(task)
        }
        let requests = tasks
        await withTaskCancellationHandler {
            for task in requests { await task.value }
        } onCancel: {
            for task in requests { task.cancel() }
        }
    }

    /// Whether `request` still owns `key` for this activation; a stale one drops its entry.
    private func current(_ key: String, _ request: UUID, _ owner: AppModel, _ generation: Int,
                         _ store: SessionStore) -> Bool {
        guard !Task.isCancelled else { return false }
        guard owner.activationGeneration == generation, owner.store === store,
            entries[key]?.request == request else {
            if entries[key]?.request == request { entries[key] = nil }
            return false
        }
        return true
    }
}
