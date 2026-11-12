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
        let count = project.differences.fields.reduce(0) { $0 + $1.fields.additionalProperties.count }
        if count > 0 { return L.t("native_repo_differences", String(count)) }
        return L.t("native_repo_not_shared")
    }
}
