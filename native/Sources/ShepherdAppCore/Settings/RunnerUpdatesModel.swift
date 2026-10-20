import Foundation
import Observation
import ShepherdKit

public enum RunnerUpdateAction: Equatable, Sendable {
    case updateHerdr, downgradeHerdr, downgradeSandbox, restartHerdr(HerdrRuntimeStatus), updateCodex
    public var isCodex: Bool { self == .updateCodex }
}

struct RunnerUpdateReads: Sendable {
    var herdr: @Sendable () async throws -> HerdrUpdateStatus
    var codex: @Sendable () async throws -> CodexUpdateStatus
    var notes: @Sendable () async throws -> CodexReleaseNotesResult
    var apply: @Sendable (RunnerUpdateAction) async throws -> Void
}

public struct RunnerUpdateProgress {
    public fileprivate(set) var busy = false
    public fileprivate(set) var uncertain = false
    public fileprivate(set) var log: [String] = []
    public fileprivate(set) var succeeded: Bool?
    public fileprivate(set) var error: String?
    public fileprivate(set) var onPathBinary: String?
}

/// Server-owned updates, scoped to one profile activation. No release checks or installers here.
@Observable @MainActor public final class RunnerUpdatesModel: AppExtension {
    public private(set) var herdr: HerdrUpdateStatus?
    public private(set) var codex: CodexUpdateStatus?
    public private(set) var herdrError: String?
    public private(set) var codexError: String?
    public private(set) var notes: CodexReleaseNotesResult?
    public private(set) var notesError: String?
    public private(set) var notesLoading = false
    public private(set) var herdrProgress = RunnerUpdateProgress()
    public private(set) var codexProgress = RunnerUpdateProgress()
    @ObservationIgnored private let reads: RunnerUpdateReads
    @ObservationIgnored private var stopped = false
    @ObservationIgnored private var herdrGeneration = 0
    @ObservationIgnored private var codexGeneration = 0
    @ObservationIgnored private var notesGeneration = 0
    @ObservationIgnored private var herdrActionGeneration = 0
    @ObservationIgnored private var codexActionGeneration = 0
    @ObservationIgnored private var herdrRequest = false
    @ObservationIgnored private var codexRequest = false
    @ObservationIgnored private var herdrAction: Task<Void, Never>?
    @ObservationIgnored private var codexAction: Task<Void, Never>?
    @ObservationIgnored private var tasks: [Task<Void, Never>] = []
    @ObservationIgnored private var herdrRead: Task<Void, Never>?
    @ObservationIgnored private var codexRead: Task<Void, Never>?
    @ObservationIgnored private var notesRead: Task<Void, Never>?
    @ObservationIgnored private var poll: Task<Void, Never>?
    @ObservationIgnored private var wake: AsyncStream<Void>.Continuation?

    init(reads: RunnerUpdateReads) { self.reads = reads }

    public convenience init(store: SessionStore, app: AppModel) {
        let client = store.client
        self.init(reads: .init(herdr: { try await client.getHerdrUpdate() },
            codex: { try await client.getCodexUpdate() }, notes: { try await client.getCodexReleaseNotes() },
            apply: { action in
                switch action {
                case .updateHerdr: try await client.applyHerdrUpdate()
                case .downgradeHerdr: try await client.applyHerdrDowngrade()
                case .downgradeSandbox: try await client.applyHerdrSandboxDowngrade()
                case .restartHerdr(let runtime):
                    guard let installed = runtime.installedVersion else { return }
                    try await client.restartHerdrServer(installedVersion: installed, serverVersion: runtime.serverVersion)
                case .updateCodex: try await client.applyCodexUpdate()
                }
            }))
        let events = store.events()
        tasks.append(Task { [weak self] in
            for await event in events {
                guard let self, !self.stopped, !Task.isCancelled else { return }
                self.receive(event)
            }
        })
        let (stream, continuation) = AsyncStream<Void>.makeStream(bufferingPolicy: .bufferingNewest(1))
        wake = continuation
        tasks.append(Task { [weak self, weak store] in
            guard let store else { return }
            var iterator = stream.makeAsyncIterator(), live = false
            while let self, !self.stopped, !Task.isCancelled {
                let connection = withObservationTracking { store.connection }
                    onChange: { continuation.yield(()) }
                if connection == .live && !live { self.refresh() }
                if connection != .live && live { self.disconnected() }
                live = connection == .live
                guard await iterator.next() != nil else { return }
            }
        })
        refresh()
    }

    public var showsHerdr: Bool {
        guard let herdr else { return herdrProgress.uncertain }
        return herdr.updateAvailable || herdr.currentUnsupported == true
            || (herdr.runtime != nil && herdr.runtime?.state != "ready")
            || herdr.sandboxIdleRegressed == true || herdrProgress.busy || herdrProgress.uncertain
            || herdrProgress.succeeded == false || herdrProgress.error != nil
    }
    public var showsCodex: Bool { codex?.updateAvailable == true || codexProgress.busy || codexProgress.uncertain
        || codexProgress.succeeded == false || codexProgress.error != nil }

    public var herdrActions: [RunnerUpdateAction] {
        guard let herdr else { return [] }
        if herdr.currentUnsupported == true { return [.downgradeHerdr] }
        if let runtime = herdr.runtime, ["restart_required", "offline"].contains(runtime.state) {
            return runtime.installedVersion != nil ? [.restartHerdr(runtime)] : []
        }
        // An unknown runtime (failed probe) can't be repaired here, but the installer still works.
        var actions: [RunnerUpdateAction] = []
        if herdr.updateAvailable && herdr.latestUnsupported != true { actions.append(.updateHerdr) }
        if herdr.sandboxIdleRegressed == true && herdr.latestUnsupported != true {
            actions.append(.downgradeSandbox)
        }
        return actions
    }
    public func canRun(_ action: RunnerUpdateAction) -> Bool {
        guard !stopped else { return false }
        return action.isCodex ? codex?.updateAvailable == true && !codexProgress.busy && !codexRequest && codexError == nil
            : herdrActions.contains(action) && !herdrProgress.busy && !herdrRequest && herdrError == nil
    }

    public func refresh() {
        guard !stopped else { return }
        herdrRead?.cancel(); codexRead?.cancel()
        herdrRead = Task { [weak self] in await self?.loadHerdr() }
        codexRead = Task { [weak self] in await self?.loadCodex() }
    }
    func loadHerdr() async {
        guard !stopped, !Task.isCancelled else { return }
        herdrGeneration &+= 1
        let mine = herdrGeneration
        do {
            let snapshot = try await reads.herdr()
            guard !stopped, !Task.isCancelled, mine == herdrGeneration else { return }
            acceptHerdr(snapshot)
        } catch {
            guard !stopped, !Task.isCancelled, mine == herdrGeneration else { return }
            herdrError = ShepherdErrorCopy.message(error)
        }
    }
    func loadCodex() async {
        guard !stopped, !Task.isCancelled else { return }
        codexGeneration &+= 1
        let mine = codexGeneration
        do {
            let snapshot = try await reads.codex()
            guard !stopped, !Task.isCancelled, mine == codexGeneration else { return }
            acceptCodex(snapshot)
        } catch {
            guard !stopped, !Task.isCancelled, mine == codexGeneration else { return }
            codexError = ShepherdErrorCopy.message(error)
        }
    }
    public func loadNotes() {
        guard !stopped else { return }
        notesGeneration &+= 1
        let mine = notesGeneration
        notesRead?.cancel(); notesLoading = true; notesError = nil; notes = nil
        notesRead = Task { [weak self] in
            guard let self, !self.stopped, !Task.isCancelled else { return }
            do {
                let result = try await self.reads.notes()
                guard !self.stopped, !Task.isCancelled, mine == self.notesGeneration else { return }
                // A status change while notes load must not attach notes for an older version pair.
                if result.current == self.codex?.current && result.latest == self.codex?.latest { self.notes = result }
            } catch {
                guard !self.stopped, !Task.isCancelled, mine == self.notesGeneration else { return }
                self.notesError = ShepherdErrorCopy.message(error)
            }
            self.notesLoading = false
        }
    }

    @discardableResult public func submit(_ action: RunnerUpdateAction) -> Task<Void, Never>? {
        guard canRun(action) else { return nil }
        if action.isCodex { codexRequest = true; codexActionGeneration &+= 1; codexProgress = .init(); codexProgress.busy = true }
        else { herdrRequest = true; herdrActionGeneration &+= 1; herdrProgress = .init(); herdrProgress.busy = true }
        let mine = action.isCodex ? codexActionGeneration : herdrActionGeneration
        let task = Task { [weak self] in
            guard let self, !self.stopped, !Task.isCancelled else { return }
            defer {
                if action.isCodex { self.codexRequest = false } else { self.herdrRequest = false }
            }
            do {
                try await self.reads.apply(action)
                guard !self.stopped, !Task.isCancelled else { return }
                if !action.isCodex { self.herdrRequest = false; await self.loadHerdr() }
            } catch {
                guard !self.stopped, !Task.isCancelled else { return }
                if action.isCodex && mine == self.codexActionGeneration {
                    self.codexProgress.busy = false; self.codexProgress.error = Self.actionError(error)
                } else if !action.isCodex && mine == self.herdrActionGeneration {
                    self.herdrProgress.busy = self.herdr?.phase.map { $0 != "idle" } ?? false
                    self.herdrProgress.error = Self.actionError(error)
                }
            }
            self.updatePolling()
        }
        if action.isCodex { codexAction = task } else { herdrAction = task }
        updatePolling()
        return task
    }

    private static func actionError(_ error: any Error) -> String {
        if let failure = error as? ShepherdError, case .conflict(let code, _) = failure,
            code == "runner_update_not_started" {
            return L.t("native_runner_failure")
        }
        return ShepherdErrorCopy.message(error)
    }

    func disconnected() {
        if codexProgress.busy {
            codexActionGeneration &+= 1
            codexProgress.busy = false; codexProgress.uncertain = true
        }
        if herdrProgress.busy {
            herdrProgress.uncertain = true
            if herdr?.phase == nil { herdrProgress.busy = false }
        }
        updatePolling()
    }
    func receive(_ event: ServerEvent) {
        guard !stopped, case .unknown(let name, let payload) = event, let payload else { return }
        let decoder = JSONDecoder()
        switch name {
        case "herdr-update:status":
            guard let value = try? decoder.decode(HerdrUpdateStatus.self, from: payload) else { return }
            herdrGeneration &+= 1; acceptHerdr(value)
        case "codex-update:status":
            guard let value = try? decoder.decode(CodexUpdateStatus.self, from: payload) else { return }
            codexGeneration &+= 1; acceptCodex(value)
        case "herdr-update:log", "codex-update:log":
            guard let value = try? decoder.decode(Components.Schemas.RunnerUpdateLog.self, from: payload) else { return }
            if name.hasPrefix("herdr") { herdrProgress.log = Array((herdrProgress.log + [value.line]).suffix(200)) }
            else { codexProgress.log = Array((codexProgress.log + [value.line]).suffix(200)) }
        case "herdr-update:done":
            // Modern servers persist the result in the revisioned status snapshot.
            guard herdr?.phase == nil,
                let value = try? decoder.decode(HerdrUpdateResult.self, from: payload) else { return }
            finishHerdr(value); refresh()
        case "codex-update:done":
            guard let value = try? decoder.decode(CodexUpdateResult.self, from: payload) else { return }
            codexActionGeneration &+= 1
            codexProgress.busy = false; codexProgress.uncertain = false
            codexProgress.succeeded = value.ok; codexProgress.error = value.error
            codexProgress.onPathBinary = value.onPathBinary
            refresh()
        default: break
        }
    }
    private func acceptCodex(_ value: CodexUpdateStatus) {
        if codex?.current != value.current || codex?.latest != value.latest { notes = nil }
        codex = value; codexError = nil
    }
    private func acceptHerdr(_ value: HerdrUpdateStatus) {
        guard (value.revision ?? 0) >= (herdr?.revision ?? 0) else { return }
        herdr = value; herdrError = nil
        if let phase = value.phase {
            herdrProgress.busy = phase != "idle" || herdrRequest
            herdrProgress.uncertain = false
            if phase == "idle", !herdrRequest, let result = value.result { finishHerdr(result) }
        }
        updatePolling()
    }
    private func finishHerdr(_ value: HerdrUpdateResult) {
        herdrActionGeneration &+= 1
        herdrProgress.busy = false; herdrProgress.uncertain = false
        herdrProgress.succeeded = value.ok; herdrProgress.error = value.error
    }
    private func updatePolling() {
        if !herdrProgress.busy { poll?.cancel(); poll = nil; return }
        guard poll == nil, !stopped else { return }
        poll = Task { [weak self] in
            while !Task.isCancelled {
                do { try await Task.sleep(for: .seconds(2)) } catch { return }
                guard let self, !self.stopped else { return }
                await self.loadHerdr()
            }
        }
    }
    public func teardown() {
        stopped = true
        tasks.forEach { $0.cancel() }; tasks.removeAll()
        herdrAction?.cancel(); codexAction?.cancel()
        herdrRequest = false; codexRequest = false
        herdrRead?.cancel(); codexRead?.cancel(); notesRead?.cancel(); poll?.cancel()
        wake?.finish(); wake = nil
        herdr = nil; codex = nil; notes = nil
        herdrError = nil; codexError = nil; notesError = nil; notesLoading = false
        herdrProgress = .init(); codexProgress = .init()
    }
}
