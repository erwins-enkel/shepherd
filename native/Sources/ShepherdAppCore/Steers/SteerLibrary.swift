import Foundation
import Observation
import ShepherdKit

/// Which saved steers a session's steer bar shows. Byte-for-byte the rule of
/// `ui/src/lib/steer-scope.ts` plus SteerBar's `inSteerBar` filter: an empty or
/// absent allowlist is universal; a non-empty one with an unknown repo name hides.
public enum SteerScope {
    public static func barSteers(_ steers: [ComposeSteer], repoName: String?, provider: String?) -> [ComposeSteer] {
        steers.filter { $0.inSteerBar && applies($0, repoName: repoName, provider: provider) }
    }

    public static func applies(_ steer: ComposeSteer, repoName: String?, provider: String?) -> Bool {
        if let repos = steer.repos, !repos.isEmpty {
            guard let repoName, repos.contains(repoName) else { return false }
        }
        guard let provider, let providers = steer.agentProviders, !providers.isEmpty else { return true }
        return providers.contains { $0.rawValue == provider }
    }
}

/// The operator's saved steers and the repo names they are scoped by. Loaded once
/// per detail; steers change rarely and a stale list only costs a chip.
@MainActor
@Observable
public final class SteerLibrary {
    public private(set) var steers: [ComposeSteer] = []
    public private(set) var repoNames: [String: String] = [:]
    public private(set) var loadError: String?
    public private(set) var loaded = false
    public private(set) var saving = false
    public private(set) var saveError: String?

    public init(steers: [ComposeSteer] = [], repoNames: [String: String] = [:]) {
        self.steers = steers
        self.repoNames = repoNames
        loaded = !steers.isEmpty
    }

    public func load(steers fetchSteers: () async throws -> [ComposeSteer],
              repos fetchRepos: () async throws -> [String: String]) async {
        do {
            steers = try await fetchSteers()
            loadError = nil
        } catch {
            loadError = L.t("native_ios_steers_load_failed", ShepherdErrorCopy.message(error))
        }
        // Without repo names, repo-scoped steers stay hidden: same as the web before
        // its repo list has loaded. Universal steers still show.
        repoNames = (try? await fetchRepos()) ?? repoNames
        loaded = true
    }

    /// Inserts or replaces one steer. The server stores the whole list, so the change
    /// is applied to a fresh copy: an edit made elsewhere since `load` survives.
    public func upsert(_ steer: ComposeSteer, fetch: () async throws -> [ComposeSteer],
                save: ([ComposeSteer]) async throws -> [ComposeSteer]) async -> Bool {
        await write(fetch: fetch, save: save) { steers in
            if let index = steers.firstIndex(where: { $0.id == steer.id }) { steers[index] = steer }
            else { steers.append(steer) }
        }
    }

    public func remove(id: String, fetch: () async throws -> [ComposeSteer],
                save: ([ComposeSteer]) async throws -> [ComposeSteer]) async -> Bool {
        await write(fetch: fetch, save: save) { $0.removeAll { $0.id == id } }
    }

    public func clearSaveError() { saveError = nil }

    private func write(fetch: () async throws -> [ComposeSteer],
                       save: ([ComposeSteer]) async throws -> [ComposeSteer],
                       change: (inout [ComposeSteer]) -> Void) async -> Bool {
        guard !saving else { return false }
        saving = true; saveError = nil
        defer { saving = false }
        do {
            var next = try await fetch()
            change(&next)
            guard next.count <= ComposeActions.maxSteers else {
                saveError = L.t("native_ios_steers_save_failed", L.t("native_ios_steers_limit"))
                return false
            }
            steers = try await save(next)
            loadError = nil
            return true
        } catch {
            saveError = L.t("native_ios_steers_save_failed", ShepherdErrorCopy.message(error))
            return false
        }
    }

    public func barSteers(for session: Session) -> [ComposeSteer] {
        SteerScope.barSteers(steers, repoName: repoNames[session.repoPath],
            provider: session.agentProvider?.rawValue)
    }
}
