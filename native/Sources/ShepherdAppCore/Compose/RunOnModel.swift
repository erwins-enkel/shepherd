import Foundation
import Observation
import ShepherdKit

/// Run on in New Task (#2776): where a task will run, what it needs, and the keyed send — the
/// web's New Task logic (#2763, #2772, #2773) for both native apps.
///
/// **Automatic sends no machine.** The server places the task by the same rules wherever it is
/// submitted; only an override names one in `target`. Everything here exists only while the server
/// says the choice is active (`POST /api/placement` answers `active: true`): without a connected
/// machine, or on a server that predates the choice, the composer is exactly what it was.
///
/// The view drives the two reads with `.task(id:)` on `ComposeModel.placementKey` and
/// `deriveKey`, so a change cancels the read in flight and the delays debounce typing.
@Observable @MainActor
public final class RunOnModel {
    public struct Reads: Sendable {
        public var preview: @Sendable (PlacementRequest) async throws -> PlacementPreview
        public var derive: @Sendable (RequirementsDeriveRequest) async throws -> RequirementsDerivation

        public init(
            preview: @escaping @Sendable (PlacementRequest) async throws -> PlacementPreview,
            derive: @escaping @Sendable (RequirementsDeriveRequest) async throws -> RequirementsDerivation
        ) {
            self.preview = preview
            self.derive = derive
        }

        public static func live(_ client: ShepherdClient) -> Reads {
            Reads(preview: { try await client.previewPlacement($0) },
                  derive: { try await client.deriveRequirements($0) })
        }

        /// No server behind it: the choice stays inactive.
        static let inactive = Reads(preview: { _ in throw ShepherdError.notFound },
                                    derive: { _ in throw ShepherdError.notFound })
    }

    /// The task as a create sends it, as far as its requirements can be read from it.
    public struct DeriveText: Hashable, Sendable {
        public var prompt: String
        public var issueTitle: String?
        public var issueBody: String?

        public init(prompt: String, issueTitle: String? = nil, issueBody: String? = nil) {
            self.prompt = prompt.trimmingCharacters(in: .whitespacesAndNewlines)
            self.issueTitle = issueTitle
            self.issueBody = issueBody
        }

        var hasText: Bool {
            !prompt.isEmpty || !(issueTitle ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        }
    }

    public struct PreviewKey: Hashable, Sendable {
        let repo: String
        let requirements: [String]
        let pick: String?
    }

    public struct DeriveKey: Hashable, Sendable {
        let repo: String
        let text: DeriveText
    }

    /// What reading the requirements depends on: the task, and whether it is the server's to read
    /// right now — a preview that says so after the last edit must start the read too.
    public struct DeriveTrigger: Hashable, Sendable {
        let key: DeriveKey
        let applies: Bool
    }

    /// One keyed attempt: its Idempotency-Key and the body it went out with.
    public struct Send: Equatable, Sendable {
        public let key: String
        let payload: Data
    }

    private struct Answer {
        let key: PreviewKey
        let value: PlacementPreview
    }

    private struct RepoFlag: Equatable {
        let repo: String
        let value: Bool
    }

    private struct Derived {
        let key: DeriveKey
        let value: RequirementsDerivation
    }

    @ObservationIgnored private let reads: Reads
    @ObservationIgnored var previewDelay: Duration = .milliseconds(200)
    @ObservationIgnored var deriveDelay: Duration = .seconds(1)

    /// The repo the composer submits to (its path on the entry server). Set by `ComposeModel`.
    public internal(set) var repo = ""
    /// The operator's pick: nil = Automatic, else an instance ID. Read through `pickedID`, which
    /// drops a pick the current repo cannot run on.
    public var pick: String?
    /// The task's requirements as capability IDs, edited as chips.
    public private(set) var requirements: [String] = []
    /// The operator set the chips (or answered the question): nothing is read any more.
    public private(set) var requirementsTouched = false

    private var answer: Answer?
    /// Whether the choice is active for a repo, from its last answer.
    private var activeFor: RepoFlag?
    private var machinesFor: (repo: String, hosts: [SessionHost])?
    /// The first preview for this repo is still being asked: nothing is known yet.
    private var askingFor: String?
    /// The last preview for this repo failed: whether the choice is active there is unknown.
    private var failedFor: String?
    /// Whether reading the requirements can change where the task runs, from the last Automatic
    /// preview for the repo.
    private var deriveFor: RepoFlag?
    private var derivation: Derived?
    @ObservationIgnored private var pendingSend: Send?

    public init(reads: Reads) {
        self.reads = reads
    }

    public convenience init(client: ShepherdClient) {
        self.init(reads: .live(client))
    }

    // MARK: - What the composer shows

    /// The server places tasks among machines for this repo: Run on, the chips and the reason
    /// are shown, and every create is keyed.
    public var active: Bool { activeFor == RepoFlag(repo: repo, value: true) }

    /// Active, or not known because the preview failed: the chips still travel and the task is
    /// still read, so a failed check never sends a task elsewhere unread.
    public var available: Bool { active || failedFor == repo }

    /// What Run on offers: the entry server first, then the connected machines with the project.
    public var machines: [SessionHost] {
        guard active, let known = machinesFor, known.repo == repo else { return [] }
        return known.hosts
    }

    /// The pick, while the repo can run there; nil = Automatic.
    public var pickedID: String? {
        guard let pick, machines.contains(where: { $0.instanceId == pick }) else { return nil }
        return pick
    }

    public var previewKey: PreviewKey { PreviewKey(repo: repo, requirements: requirements, pick: pickedID) }

    /// The server's answer for the inputs as they are now; nil while that one is being asked.
    public var currentPreview: PlacementPreview? {
        answer?.key == previewKey ? answer?.value : nil
    }

    public var previewFailed: Bool { failedFor == repo }

    /// Where the task goes when it does not start on the entry server: the machine picked, or the
    /// one the current preview chose. Nil while it starts there or nothing is known yet.
    public var remoteTarget: SessionHost? {
        guard active else { return nil }
        if let id = pickedID {
            return id == machines.first?.instanceId ? nil : machines.first { $0.instanceId == id }
        }
        guard let placement = currentPreview?.placement,
              placement.target.instanceId != placement.by.instanceId else { return nil }
        return placement.target
    }

    // MARK: - Requirements read from the task

    public func deriveKey(_ text: DeriveText) -> DeriveKey { DeriveKey(repo: repo, text: text) }

    /// Reading the requirements can change where the task runs, and they are still the server's to read.
    public var deriveApplies: Bool {
        available && pickedID == nil && !requirementsTouched && deriveFor == RepoFlag(repo: repo, value: true)
    }

    /// The answer for the task as it is now; nil while that one is still being read.
    public func derivation(for text: DeriveText) -> RequirementsDerivation? {
        derivation?.key == deriveKey(text) ? derivation?.value : nil
    }

    /// The task does not start before the answer: what it calls for decides where it runs. Also
    /// while the first preview for this repo is out — whether reading matters is not known yet.
    public func requirementsPending(_ text: DeriveText) -> Bool {
        guard text.hasText, pickedID == nil, !requirementsTouched else { return false }
        if askingFor == repo { return true }
        return deriveApplies && derivation(for: text) == nil
    }

    /// The description was unclear: the operator answers the question first.
    public func requirementsUnclear(_ text: DeriveText) -> Bool {
        deriveApplies && derivation(for: text)?.status.rawValue == "unclear"
    }

    /// The operator's own requirements — a chip changed, or the question answered.
    public func setRequirements(_ next: [String]) {
        requirements = Array(Set(next)).sorted()
        requirementsTouched = true
    }

    public func addRequirement(_ id: String) { setRequirements(requirements + [id]) }

    public func removeRequirement(_ id: String) { setRequirements(requirements.filter { $0 != id }) }

    /// Carried into a composer for another server (iOS): the pick and the operator's chips.
    public func restore(pick: String?, requirements: [String], touched: Bool) {
        self.pick = pick
        if touched { setRequirements(requirements) }
    }

    // MARK: - Reads

    /// Asks where a create with the current inputs would run. Debounced by `previewDelay`; an
    /// answer for inputs that changed meanwhile is dropped.
    public func refreshPreview() async {
        let key = previewKey
        guard !key.repo.isEmpty else { return }
        if activeFor?.repo != key.repo { askingFor = key.repo }
        do { try await Task.sleep(for: previewDelay) } catch { return }
        let request = PlacementRequest(
            repoPath: key.repo,
            requirements: key.requirements.isEmpty ? nil : key.requirements.map(Capability.init(id:)),
            target: key.pick.map { TaskTarget(instanceId: $0) })
        do {
            let value = try await reads.preview(request)
            guard !Task.isCancelled, key.repo == repo else { return }
            install(value, for: key)
        } catch {
            guard !Task.isCancelled, key.repo == repo else { return }
            settlePreview(after: error, for: key)
        }
    }

    private func install(_ value: PlacementPreview, for key: PreviewKey) {
        answer = Answer(key: key, value: value)
        activeFor = RepoFlag(repo: key.repo, value: value.active)
        if value.active { machinesFor = (key.repo, value.machines ?? []) }
        if failedFor == key.repo { failedFor = nil }
        if askingFor == key.repo { askingFor = nil }
        // Only Automatic says whether the task's description can matter; a pick says false.
        if key.pick == nil { deriveFor = RepoFlag(repo: key.repo, value: value.deriveRequirements == true) }
    }

    private func settlePreview(after error: any Error, for key: PreviewKey) {
        switch error as? ShepherdError {
        case .cancelled:
            return
        case .notFound, .forbidden:
            // A server without the machine choice, or a token for other repositories: no choice.
            activeFor = RepoFlag(repo: key.repo, value: false)
            if askingFor == key.repo { askingFor = nil }
        default:
            failedFor = key.repo
            if askingFor == key.repo { askingFor = nil }
            // Unknown whether it matters: ask the derive route, which checks again itself and
            // answers `skipped` when it does not — the start never waits forever, nor goes unread.
            if key.pick == nil { deriveFor = RepoFlag(repo: key.repo, value: true) }
        }
    }

    /// Reads the requirements from the task, a beat after the last edit. The answer replaces
    /// untouched chips — what was derived, else none, so a chip read from an older text never stays.
    public func derive(_ text: DeriveText) async {
        let key = deriveKey(text)
        guard deriveApplies, text.hasText, derivation?.key != key else { return }
        do { try await Task.sleep(for: deriveDelay) } catch { return }
        let request = RequirementsDeriveRequest(
            repoPath: key.repo, prompt: String(text.prompt.prefix(8000)),
            issue: text.issueTitle.map {
                .init(title: String($0.prefix(500)), body: text.issueBody.map { String($0.prefix(100_000)) })
            })
        let value: RequirementsDerivation
        do {
            value = try await reads.derive(request)
        } catch {
            if Task.isCancelled || error as? ShepherdError == .cancelled { return }
            value = RequirementsDerivation(status: .init(value1: .failed, value2: "failed"),
                                           cause: .init(value1: .error, value2: "error"))
        }
        guard !Task.isCancelled, key.repo == repo else { return }
        derivation = Derived(key: key, value: value)
        guard !requirementsTouched else { return }
        requirements = value.status.rawValue == "derived" ? (value.requirements ?? []).map(\.rawValue) : []
    }

    // MARK: - The keyed send

    /// The Idempotency-Key for this create while the choice is available: the unanswered one's
    /// again while the task is unchanged, so a retry is the same dispatch; otherwise a fresh one.
    public func send(for request: CreateSessionRequest) -> Send? {
        guard available else { return nil }
        let encoder = JSONEncoder()
        encoder.outputFormatting = .sortedKeys
        let payload = (try? encoder.encode(request)) ?? Data()
        if let pendingSend, pendingSend.payload == payload { return pendingSend }
        return Send(key: UUID().uuidString, payload: payload)
    }

    /// After an attempt: only an unanswered send may be reused by the next one.
    public func settle(_ send: Send?, error: (any Error)?) {
        guard let send, let error, PlacementCopy.isUnanswered(error) else {
            pendingSend = nil
            return
        }
        pendingSend = send
    }
}
