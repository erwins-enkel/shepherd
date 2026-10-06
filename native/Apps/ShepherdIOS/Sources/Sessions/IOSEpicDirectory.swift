import Foundation
import Observation
import ShepherdAppCore
import ShepherdKit

/// Repo summaries belong to the owning model's activation, never to a session ID.
@MainActor
@Observable
final class IOSEpicDirectory {
    private struct Entry {
        let owner: ObjectIdentifier
        let generation: Int
        let request: UUID
        var parents: Set<Int>
        var summaries: [EpicSummary]
    }
    private var entries: [String: Entry] = [:]
    @ObservationIgnored private let read: (ShepherdClient, String) async throws -> EpicListing

    init(read: @escaping (ShepherdClient, String) async throws -> EpicListing = {
        try await $0.epics(repoPath: $1)
    }) {
        self.read = read
    }

    private func key(_ group: IOSMergedSessionPresentation.EpicGroup) -> String {
        "\(group.profile.id):\(group.repoPath)"
    }

    func summary(_ group: IOSMergedSessionPresentation.EpicGroup, owner: AppModel) -> EpicSummary? {
        guard let entry = entries[key(group)], entry.owner == ObjectIdentifier(owner),
            entry.generation == owner.activationGeneration else { return nil }
        return entry.summaries.first { $0.parentIssueNumber == group.parentNumber }
    }

    func load(_ groups: [IOSMergedSessionPresentation.EpicGroup], owners: [UUID: AppModel],
              fallback: AppModel, force: Bool = false) async {
        let repos = Dictionary(grouping: groups, by: key)
        for (key, groups) in repos {
            guard let group = groups.first else { continue }
            let owner = owners[group.profile.id] ?? fallback
            guard owner.activeProfile?.id == group.profile.id, let store = owner.store else { continue }
            let identity = ObjectIdentifier(owner), generation = owner.activationGeneration
            let parents = Set(groups.map(\.parentNumber))
            let old = entries[key]
            let sameActivation = old?.owner == identity && old?.generation == generation
            if !force, sameActivation, parents.isSubset(of: old?.parents ?? []) { continue }
            let request = UUID()
            entries[key] = Entry(owner: identity, generation: generation, request: request,
                parents: sameActivation ? old?.parents ?? [] : [],
                summaries: sameActivation ? old?.summaries ?? [] : [])
            let listing = try? await read(store.client, group.repoPath)
            guard !Task.isCancelled, owner.activationGeneration == generation,
                owner.store === store, entries[key]?.request == request else {
                if entries[key]?.request == request { entries[key] = nil }
                continue
            }
            // A failed read retains known copy; unknown parents use the number-only header.
            entries[key]?.parents.formUnion(parents)
            if let listing { entries[key]?.summaries = listing.epics }
        }
    }
}
