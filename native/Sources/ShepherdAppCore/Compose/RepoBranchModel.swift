import Foundation
import Observation
import ShepherdKit

/// Per-presentation state. Request stamps fence replies even if transport ignores cancellation.
@Observable @MainActor
public final class RepoBranchModel {
    public enum Picker: Hashable { case repo, branch }
    public var presentedPicker: Picker?
    private(set) var repoPath = ""
    public var baseBranch = "main" {
        didSet {
            guard oldValue != baseBranch else { return }
            selectionGeneration += 1
            if !applyingRepair { repairingBase = false }
            error = nil
            scheduleStatus()
        }
    }
    public private(set) var branches: [String] = []
    public private(set) var upstream: BranchStatus?
    private(set) var loadingBranches = false
    public private(set) var upstreamLoading = false
    public private(set) var repairingBase = false
    public private(set) var error: String?
    @ObservationIgnored private let fetchBranches: (String) async throws -> BranchListing
    @ObservationIgnored private let fetchStatus: (String, String) async throws -> BranchStatus
    @ObservationIgnored private let repair: (String, String) async throws -> InitEmptyCommitResponse
    @ObservationIgnored private let debounce: (Duration) async throws -> Void
    @ObservationIgnored private var branchTask: Task<Void, Never>?
    @ObservationIgnored private var statusTask: Task<Void, Never>?
    private var repoGeneration = 0
    private var selectionGeneration = 0
    private var statusGeneration = 0
    private var stopped = false
    public var allowsStatusProbe = true
    private var applyingRepair = false

    convenience init(client: ShepherdClient) {
        self.init(loadBranches: { try await client.branches(repoPath: $0) },
                  loadStatus: { try await client.branchStatus(repoPath: $0, branch: $1) },
                  repair: { try await client.initEmptyCommit(repoPath: $0, branch: $1) })
    }

    init(loadBranches: @escaping (String) async throws -> BranchListing,
         loadStatus: @escaping (String, String) async throws -> BranchStatus,
         repair: @escaping (String, String) async throws -> InitEmptyCommitResponse,
         debounce: @escaping (Duration) async throws -> Void = { try await Task.sleep(for: $0) }) {
        fetchBranches = loadBranches; fetchStatus = loadStatus; self.repair = repair; self.debounce = debounce
    }

    static func pickBaseBranch(_ listing: BranchListing) -> String {
        listing._default ?? listing.current ?? listing.branches.first ?? "main"
    }
    public var baseOptions: [String] { branches.contains(baseBranch) ? branches : [baseBranch] + branches }
    public var baseMissing: Bool {
        upstream != nil && branches.isEmpty && !upstream!.localExists && !upstream!.hasUpstream
    }

    func selectRepo(_ path: String) {
        guard !stopped, path != repoPath else { return }
        repoGeneration += 1; selectionGeneration += 1
        branchTask?.cancel(); invalidateStatus()
        repoPath = path; branches = []; error = nil; repairingBase = false
        loadingBranches = !path.isEmpty
        baseBranch = "main"
        guard !path.isEmpty else { return }
        let mine = repoGeneration, selection = selectionGeneration
        branchTask = Task { [weak self] in
            guard let self else { return }
            do {
                let listing = try await fetchBranches(path)
                guard mine == repoGeneration, !stopped else { return }
                branches = listing.branches
                // Typing a base while the list loads must not lose that choice.
                if selection == selectionGeneration { baseBranch = Self.pickBaseBranch(listing) }
            } catch {
                guard mine == repoGeneration, !stopped else { return }
                self.error = ShepherdErrorCopy.message(error)
            }
            loadingBranches = false
            scheduleStatus()
        }
    }

    private func invalidateStatus() {
        statusGeneration += 1
        statusTask?.cancel(); statusTask = nil
        upstream = nil; upstreamLoading = false
    }

    private func scheduleStatus() {
        invalidateStatus()
        guard allowsStatusProbe, !stopped, !loadingBranches, !repairingBase, !repoPath.isEmpty, !baseBranch.isEmpty else { return }
        upstreamLoading = true
        let mine = statusGeneration, repo = repoPath, branch = baseBranch
        statusTask = Task { [weak self] in
            guard let self else { return }
            do {
                try await debounce(.milliseconds(300))
                guard mine == statusGeneration, !stopped else { return }
                let value = try await fetchStatus(repo, branch)
                guard mine == statusGeneration, !stopped else { return }
                upstream = value
            } catch {
                guard mine == statusGeneration, !stopped else { return }
                // Match the web: unavailable status is unknown, never a missing-base claim.
                upstream = nil
            }
            upstreamLoading = false
        }
    }

    public func repairInitialCommit() async {
        guard !stopped, !repoPath.isEmpty, !repairingBase else { return }
        repairingBase = true; error = nil
        let previousStatus = upstream
        invalidateStatus()
        upstream = previousStatus
        // A branch listing started before repair must not roll back the refreshed list.
        repoGeneration += 1; branchTask?.cancel(); loadingBranches = false
        let repo = repoPath, mine = selectionGeneration
        let branch = baseBranch.trimmingCharacters(in: .whitespacesAndNewlines)
        do {
            let repaired = try await repair(repo, branch.isEmpty ? "main" : branch)
            guard mine == selectionGeneration, !stopped else { return }
            applyingRepair = true
            baseBranch = repaired.branch
            applyingRepair = false
            let repairedSelection = selectionGeneration
            upstream = .init(behind: 0, ahead: 0, diverged: false, hasUpstream: false, localExists: true)
            let listing = try? await fetchBranches(repo)
            guard repairedSelection == selectionGeneration, !stopped else { return }
            if let listing { branches = listing.branches }
            let status = try? await fetchStatus(repo, repaired.branch)
            guard repairedSelection == selectionGeneration, !stopped else { return }
            if let status { upstream = status }
        } catch {
            guard mine == selectionGeneration, !stopped else { return }
            self.error = L.t("newtask_init_commit_failed", ShepherdErrorCopy.message(error))
        }
        repairingBase = false
        upstreamLoading = false
    }

    func teardown() {
        stopped = true
        repoGeneration += 1; selectionGeneration += 1
        branchTask?.cancel(); branchTask = nil
        invalidateStatus()
        loadingBranches = false; repairingBase = false; presentedPicker = nil
    }
}
