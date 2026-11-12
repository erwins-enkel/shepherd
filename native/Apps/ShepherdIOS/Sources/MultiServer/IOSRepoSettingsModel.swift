import Foundation
import Observation
import ShepherdAppCore
import ShepherdKit

@MainActor @Observable
final class IOSRepoSettingsModel {
    let client: ShepherdClient
    let slug: String
    var project: RepoConfigProject?
    var draft: RepoProjectDraft?
    var busy = false
    var error: String?
    var receipt: RepoConfigProjectWrite?
    var machineID = ""

    init(client: ShepherdClient, slug: String) { self.client = client; self.slug = slug }

    var merge: RepoRuleMerge?
    var selectedLeader = ""
    private var unreachableSince: [String: Date] = [:]

    func reachability(_ machine: RepoConfigMachine) -> String {
        if machine.reachable { return L.t("native_repo_online") }
        guard let since = unreachableSince[machine.instanceId] else { return L.t("native_repo_offline") }
        return L.t("native_repo_offline_observed", since.formatted(date: .abbreviated, time: .shortened))
    }
    var hasDifferences: Bool {
        project?.differences.applicable == true &&
            (!(project?.differences.fields.isEmpty ?? true) || !(project?.differences.multipleAutoDrain.isEmpty ?? true))
    }

    func beginMerge() {
        guard let project else { return }
        do { merge = try RepoRuleMerge(project: project); error = nil }
        catch { self.error = error.localizedDescription }
    }

    func saveMerge() async -> Bool {
        guard let merge, merge.ready, !busy, writerID != nil else { return false }
        do { return await write(try merge.patch()) }
        catch { self.error = error.localizedDescription; return false }
    }

    func saveLeader() async -> Bool {
        guard !busy, let project, selectedLeader != project.leitrechner?.instanceId,
              project.machines.contains(where: { $0.instanceId == selectedLeader && $0.reachable && $0.config != nil }) else { return false }
        do { return await write(.init(leitrechner: try .init(unvalidatedValue: selectedLeader))) }
        catch { self.error = error.localizedDescription; return false }
    }

    private func write(_ patch: RepoProjectPatch) async -> Bool {
        guard let writerID else { return false }
        busy = true; defer { busy = false }
        do {
            receipt = try await client.putRepoConfigProject(remoteSlug: slug, instanceID: writerID, body: patch)
            draft = nil; merge = nil; error = nil
            return true
        } catch { self.error = error.localizedDescription; return false }
    }

    var changes: [RepoProjectDraft.Change] { (try? draft?.changes()) ?? [] }
    var writerID: String? {
        project?.machines.first { $0.instanceId == project?.referenceInstanceId && $0.reachable && $0.config != nil }?.instanceId
            ?? project?.machines.first { $0.reachable && $0.config != nil }?.instanceId
    }
    var isLocalOnly: Bool {
        let configs = project?.machines.compactMap(\.config) ?? []
        return !configs.isEmpty && configs.allSatisfy { $0.repoMode == "lightweight" }
    }
    var machine: RepoConfigMachine? { project?.machines.first { $0.instanceId == machineID } }

    func load() async {
        busy = true; defer { busy = false }
        do {
            let value = try await client.getRepoConfigProject(remoteSlug: slug)
            for machine in value.machines {
                if machine.reachable { unreachableSince[machine.instanceId] = nil }
                else if unreachableSince[machine.instanceId] == nil { unreachableSince[machine.instanceId] = Date() }
            }
            project = value
            if draft == nil, let rules = value.rules { draft = .init(rules: rules, leader: value.leitrechner?.instanceId) }
            if machineID.isEmpty { machineID = value.referenceInstanceId ?? "" }
            error = nil
        } catch { self.error = error.localizedDescription }
    }

    func save() async -> Bool {
        guard let draft, let writerID, !busy, !changes.isEmpty else { return false }
        busy = true; defer { busy = false }
        do {
            receipt = try await client.putRepoConfigProject(remoteSlug: slug, instanceID: writerID, body: draft.patch())
            // A successful write must never be retried just because the follow-up read fails.
            self.draft = nil
            error = nil
        } catch { self.error = error.localizedDescription; return false }
        return true
    }

    func saveMachine(_ patch: RepoMachinePatch) async {
        guard !busy, let machine, machine.reachable else { return }
        busy = true; defer { busy = false }
        do {
            let config = try await client.putRepoConfigMachine(remoteSlug: slug, instanceID: machine.instanceId, body: patch)
            if let index = project?.machines.firstIndex(where: { $0.instanceId == machine.instanceId }) {
                project?.machines[index].config = config
            }
            error = nil
        } catch { self.error = error.localizedDescription }
    }

    static func status(_ project: RepoConfigProject) -> String {
        let configs = project.machines.compactMap(\.config)
        if !configs.isEmpty && configs.allSatisfy({ $0.repoMode == "lightweight" }) { return L.t("native_repo_local_only") }
        if project.repoConfigCommit != nil { return L.t("native_repo_rules_shared") }
        let count = Set(project.differences.fields.flatMap { $0.fields.additionalProperties.keys }).count
        if count > 0 { return L.t("native_repo_differences", String(count)) }
        return L.t("native_repo_not_shared")
    }
}
