import AppKit
import Foundation
import ShepherdKit
import SwiftUI
import Testing
@testable import Shepherd

@MainActor @Suite struct ComposeModelTests {
    @Test(arguments: [false, true])
    func sheetOpenedBeforeBootstrapReconcilesPickerSelections(explicit: Bool) async throws {
        let suite = "ComposeBootstrapTests.\(UUID())"
        let defaults = try #require(UserDefaults(suiteName: suite))
        let credentials = InMemoryCredentialStore()
        let app = AppModel(defaults: defaults, credentials: credentials)
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [ComposeBootstrapProtocol.self]
        let session = URLSession(configuration: configuration)
        let client = try ShepherdClient(profile: .init(name: "fixture", baseURL: URL(string: "https://compose.invalid")!,
            mode: .remote), credentials: credentials, urlSession: session)
        let store = SessionStore(client: client)
        let model = Self.composer()
        let host = NSHostingView(rootView: ComposeSheetContent(app: app, store: store, activation: 0, model: model))
        let window = NSWindow(contentRect: NSRect(x: -10000, y: -10000, width: 740, height: 780),
                              styleMask: [.borderless], backing: .buffered, defer: false)
        window.contentView = host
        window.orderFront(nil)
        host.layoutSubtreeIfNeeded()
        defer {
            window.orderOut(nil); window.contentView = nil
            model.teardown(); store.stop(); app.teardown(); session.invalidateAndCancel()
            defaults.removePersistentDomain(forName: suite)
        }
        #expect(store.settings == nil)
        if explicit {
            model.selectProviderManually(.claude); model.model = "sonnet"; model.effort = "high"
        }
        try await store.bootstrap()
        try await eventually { model.runDefaults.provider == .codex }
        #expect(EnginePicker(model: model).selection.wrappedValue == (explicit ? .claude : .codex))
        #expect(model.model == (explicit ? "sonnet" : "gpt-6-astra"))
        #expect(model.effort == (explicit ? "high" : "ultra"))
        #expect(ModelPicker(model: model).options.contains(model.model))
        #expect(EffortPicker(model: model).options.contains(model.effort))
        // Opt-in screenshot handoff: the regular unit suite never waits or exposes a window.
        if !explicit, let marker = ProcessInfo.processInfo.environment["SHEPHERD_COMPOSE_CAPTURE"] {
            let webURL = URL(fileURLWithPath: marker).deletingLastPathComponent().appendingPathComponent("web-composer.png")
            let webImage = try #require(NSImage(contentsOf: webURL))
            let screenshotModel = ComposeModel(defaults: defaults,
                repoBranches: RepoBranchModel(loadBranches: { _ in .init(branches: ["main"]) },
                    loadStatus: { _, _ in .init(behind: 0, ahead: 0, diverged: false, hasUpstream: true, localExists: true) },
                    repair: { _, branch in .init(branch: branch) }),
                loadIssues: { _ in .init(issues: [
                    .init(number: 121, title: "Wishlist button on product cards", body: "Add a wishlist button.",
                          url: "https://example.com/issues/121", labels: [], createdAt: 0, assignees: []),
                    .init(number: 122, title: "Empty-cart illustration", body: "Illustrate the empty cart.",
                          url: "https://example.com/issues/122", labels: [], createdAt: 0, assignees: [])
                ]) }, loadCommands: { _, _ in .init(commands: []) },
                loadEpics: { _ in .init(epics: [], subIssues: []) })
            screenshotModel.repoPath = "/repo"
            await screenshotModel.loadSources()
            defer { screenshotModel.teardown() }
            let comparison = NSHostingView(rootView: HStack(alignment: .top, spacing: 24) {
                VStack(alignment: .leading, spacing: 16) {
                    Text("Web · local demo").font(.title2.bold())
                    ZStack(alignment: .topLeading) {
                        Color.clear
                        Image(nsImage: webImage).resizable()
                            .frame(width: 897 * 1.4, height: 769 * 1.4)
                            .offset(x: -261 * 1.4, y: -239 * 1.4)
                    }.frame(width: 482 * 1.4, height: 336 * 1.4, alignment: .topLeading).clipped()
                }
                VStack(alignment: .leading, spacing: 16) {
                    Text("macOS · local fixture").font(.title2.bold())
                    ComposeSheetContent(app: app, store: store, activation: 0, model: screenshotModel)
                }
            }.padding(24).background(Color(nsColor: .windowBackgroundColor)))
            window.styleMask = [.titled, .closable]
            window.contentView = comparison
            window.setContentSize(NSSize(width: 1490, height: 860))
            window.title = "S11 composer fixture"
            window.center()
            window.makeKeyAndOrderFront(nil)
            print("compose fixture capture ready")
            let deadline = ContinuousClock.now + .seconds(120)
            while !FileManager.default.fileExists(atPath: marker), ContinuousClock.now < deadline {
                try await Task.sleep(for: .milliseconds(250))
            }
        }

    }

    @Test func bootstrapDefaultsUpdateUntouchedRunPickers() {
        let model = Self.composer()
        defer { model.teardown() }
        model.runDefaults = .init(provider: .codex, claudeModel: "opus", codexModel: "gpt-6-astra", effort: "ultra")
        #expect(model.provider == .codex)
        #expect(model.model == "gpt-6-astra")
        #expect(model.effort == "ultra")
    }

    @Test func bootstrapDefaultsPreserveExplicitRunChoices() {
        let model = Self.composer()
        defer { model.teardown() }
        model.selectProviderManually(.claude)
        model.model = "sonnet"
        model.effort = "high"
        model.runDefaults = .init(provider: .codex, claudeModel: "opus", codexModel: "gpt-6-astra", effort: "ultra")
        #expect(model.provider == .claude)
        #expect(model.model == "sonnet")
        #expect(model.effort == "high")
    }

    @Test func actionSelectionResetsAcrossProvidersAndKeepsHandoff() {
        let actions = ComposeActions(provider: .codex)
        actions.model = "gpt-6-astra"; actions.effort = "ultra"
        actions.handoff = .summarize
        #expect(actions.variantRequest.model == "gpt-6-astra")
        #expect(actions.variantRequest.effort == "ultra")
        actions.provider = .claude
        #expect(actions.model == "default")
        #expect(actions.effort == "default")
        #expect(actions.replaceRequest.handoffMode == .summarize)
        #expect(actions.replaceRequest.model == nil)
    }

    @Test func actionCompletionCannotEscapeItsPresentationOrRunTwice() async throws {
        let actions = ComposeActions(provider: .claude)
        var pending: CheckedContinuation<String, Never>?
        var results: [String] = []
        let task = Task { await actions.run(operation: {
            await withCheckedContinuation { pending = $0 }
        }, apply: { results.append($0) }, isCurrent: { true }) }
        try await eventually { pending != nil }
        #expect(actions.busy)
        let duplicate = await actions.run(operation: { "duplicate" }, apply: { results.append($0) }, isCurrent: { true })
        #expect(!duplicate)
        actions.teardown()
        pending?.resume(returning: "late")
        #expect(await task.value == false)
        #expect(results.isEmpty)
        let stale = await actions.run(operation: { "stale" }, apply: { results.append($0) }, isCurrent: { false })
        #expect(!stale)
        #expect(results.isEmpty)
    }

    @Test func actionDropsCompletionAfterServerSwitchWithoutTeardown() async throws {
        let actions = ComposeActions(provider: .claude)
        var current = true
        var pending: CheckedContinuation<String, Never>?
        var applied = false
        let task = Task { await actions.run(operation: {
            await withCheckedContinuation { pending = $0 }
        }, apply: { _ in applied = true }, isCurrent: { current }) }
        try await eventually { pending != nil }
        current = false
        pending?.resume(returning: "other server")
        #expect(await task.value == false)
        #expect(!applied)
        #expect(!actions.busy)
    }

    @Test func actionFailuresAreRetryableAndSteersRequireAVisiblePlacement() async {
        let actions = ComposeActions(provider: .claude)
        _ = await actions.run(operation: { throw ComposeRecommendationError.failed("no-history") }, apply: { (_: String) in }, isCurrent: { true })
        #expect(actions.error == L.t("recommend_err_no_history"))
        #expect(!actions.busy)
        actions.steers = [.init(id: "s", label: "Test", text: "Run tests", inSteerBar: false, onIssues: false)]
        #expect(!actions.canSaveSteers)
        actions.steers[0].inSteerBar = true
        #expect(actions.canSaveSteers)
        let ok = await actions.run(operation: { "ready" }, apply: { actions.recommendation = $0 }, isCurrent: { true })
        #expect(ok)
        #expect(actions.error == nil)
        #expect(actions.recommendation == "ready")
    }

    static func composer(attachments: AttachmentModel? = nil, shaping: ShapeRoundModel? = nil) -> ComposeModel {
        ComposeModel(defaults: UserDefaults(suiteName: "ComposeModeTests.\(UUID())")!,
                     repoBranches: RepoBranchModel(
                        loadBranches: { _ in .init(branches: []) },
                        loadStatus: { _, _ in .init(behind: 0, ahead: 0, diverged: false, hasUpstream: false, localExists: false) },
                        repair: { _, branch in .init(branch: branch) }),
                     loadIssues: { _ in .init(issues: []) }, loadCommands: { _, _ in .init(commands: []) },
                     loadEpics: { _ in .init(epics: [], subIssues: []) }, attachments: attachments, shaping: shaping)
    }

    @Test func uploadReportsPartialBytesAndResetsForANewBatch() async throws {
        var pending: [CheckedContinuation<String, any Error>] = []
        var reports: [AttachmentModel.Progress] = []
        let uploads = AttachmentModel(uploadWithProgress: { _, _, report in
            reports.append(report)
            return try await withCheckedThrowingContinuation { pending.append($0) }
        })
        defer { uploads.teardown() }
        uploads.addFiles([.init(name: "first", data: Data(repeating: 1, count: 999))])
        try await eventually { pending.count == 1 }
        await reports[0](333)
        #expect(uploads.progressPercent == 33)
        pending[0].resume(returning: "/first")
        try await eventually { !uploads.uploading }
        uploads.addFiles([.init(name: "second", data: Data([1]))])
        #expect(uploads.progressPercent == 0)
        try await eventually { pending.count == 2 }
        await reports[0](999) // A late callback cannot advance the new transfer.
        #expect(uploads.progressPercent == 0)
        await reports[1](1)
        #expect(uploads.progressPercent == 99)
        pending[1].resume(returning: "/second")
        try await eventually { !uploads.uploading }
        #expect(uploads.progressPercent == 100)
    }

    @Test func oversizedFileIsRejectedBeforeOpeningOrReading() throws {
        var reads = 0
        #expect(throws: AttachmentModel.FileError.tooLarge) {
            try AttachmentModel.readBounded(size: AttachmentModel.maximumFileBytes + 1) { _ in
                reads += 1
                return Data([1])
            }
        }
        #expect(reads == 0)
    }

    @Test func boundedReadRejectsGrowthWithoutAllocatingALimitSizedFixture() throws {
        var remaining = 12
        var largestRequest = 0
        #expect(throws: AttachmentModel.FileError.tooLarge) {
            try AttachmentModel.readBounded(size: 2, limit: 8) { count in
                largestRequest = max(largestRequest, count)
                let count = min(count, remaining)
                remaining -= count
                return Data(repeating: 1, count: count)
            }
        }
        #expect(largestRequest <= 9)
        #expect(remaining == 3)
    }

    @Test func sparseOversizedURLFailsTheAttributeCheck() throws {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        FileManager.default.createFile(atPath: url.path, contents: nil)
        defer { try? FileManager.default.removeItem(at: url) }
        let handle = try FileHandle(forWritingTo: url)
        try handle.truncate(atOffset: UInt64(AttachmentModel.maximumFileBytes + 1))
        try handle.close()
        #expect(throws: AttachmentModel.FileError.tooLarge) { try AttachmentModel.readFile(url) }
    }

    @Test func upload401InvalidatesWithoutASettingsRoundTrip() async throws {
        let credentials = InMemoryCredentialStore()
        try credentials.save(.init(token: "rejected-token", tokenId: "rejected"), for: "upload")
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [ComposeUploadProtocol.self]
        let session = URLSession(configuration: configuration)
        defer { session.invalidateAndCancel() }
        let client = try ShepherdClient(profile: .init(name: "upload", baseURL: URL(string: "http://localhost")!,
                                                       mode: .local, credentialKey: "upload"),
                                        credentials: credentials, urlSession: session)
        let login = Box(false)
        let watcher = Task { for await _ in client.needsLogin { login.value = true; return } }
        defer { watcher.cancel() }
        let uploads = AttachmentModel(client: client)
        defer { uploads.teardown() }
        uploads.addFiles([.init(name: "empty", data: Data())])
        try await eventually { !uploads.uploading }
        #expect(uploads.rows.first?.state == .failed)
        #expect(try credentials.load(for: "upload") == nil)
        try await eventually { login.value }
    }

    @Test func attachmentsDrainSeriallyWithWeightedProgressAndPairedPayload() async throws {
        var calls: [String] = []
        var pending: [CheckedContinuation<String, any Error>] = []
        let uploads = AttachmentModel(upload: { _, name in
            calls.append(name)
            return try await withCheckedThrowingContinuation { pending.append($0) }
        })
        let m = Self.composer(attachments: uploads)
        defer { m.teardown() }
        m.repoPath = "/repo"; m.prompt = "Do work"
        uploads.addFiles([.init(name: "large.txt", data: Data(repeating: 1, count: 999)),
                          .init(name: "small.txt", data: Data([2]))])
        #expect(m.readinessBlocker == "uploading")
        #expect(m.createRequest(baseBranch: "main") == nil)
        try await eventually { pending.count == 1 }
        #expect(calls == ["large.txt"])
        pending[0].resume(returning: "/staged/large")
        try await eventually { pending.count == 2 }
        #expect(uploads.progressPercent == 99)
        #expect(m.createRequest(baseBranch: "main") == nil)
        pending[1].resume(returning: "/staged/small")
        try await eventually { !uploads.hasOutstandingUploads }
        #expect(uploads.progressPercent == 100)
        let request = try #require(m.createRequest(baseBranch: "main"))
        #expect(request.images == ["/staged/large", "/staged/small"])
        #expect(request.attachmentNames == ["large.txt", "small.txt"])
        uploads.remove(uploads.rows[0].id)
        let reduced = try #require(m.createRequest(baseBranch: "main"))
        #expect(reduced.images == ["/staged/small"])
        #expect(reduced.attachmentNames == ["small.txt"])
    }

    @Test func failedUploadKeepsItsRowBlocksSubmitAndRetriesInline() async throws {
        var attempts = 0
        let uploads = AttachmentModel(upload: { _, _ in
            attempts += 1
            if attempts == 1 { throw ShepherdError.badRequest("try again") }
            return "/staged/retried"
        })
        let m = Self.composer(attachments: uploads)
        defer { m.teardown() }
        m.repoPath = "/repo"; m.prompt = "Do work"
        uploads.addFiles([.init(name: "retry.txt", data: Data([1]))])
        try await eventually { uploads.rows.first?.error != nil }
        let id = try #require(uploads.rows.first?.id)
        #expect(uploads.rows.count == 1 && uploads.hasOutstandingUploads)
        #expect(m.readinessBlocker == "uploading")
        #expect(m.createRequest(baseBranch: "main") == nil)
        uploads.retry(id); uploads.retry(id)
        try await eventually { !uploads.hasOutstandingUploads }
        #expect(attempts == 2 && uploads.rows.first?.id == id)
        #expect(uploads.rows.first?.error == nil)
        #expect(m.createRequest(baseBranch: "main")?.attachmentNames == ["retry.txt"])
    }

    @Test func removalAndTeardownFenceLateUploadsAndStopTheQueue() async throws {
        var pending: CheckedContinuation<String, any Error>?
        var calls = 0
        let uploads = AttachmentModel(upload: { _, _ in
            calls += 1
            return try await withCheckedThrowingContinuation { pending = $0 }
        })
        uploads.addFiles([.init(name: "first", data: Data()), .init(name: "second", data: Data())])
        try await eventually { pending != nil }
        #expect(uploads.progressPercent < 100)
        uploads.remove(uploads.rows[0].id)
        uploads.teardown()
        pending?.resume(returning: "/staged/late")
        for _ in 0..<20 { await Task.yield() }
        #expect(calls == 1 && uploads.rows.isEmpty)
        uploads.addFiles([.init(name: "after close", data: Data())])
        #expect(uploads.rows.isEmpty)
    }

    @Test func progressWeightsBytesAndWaitsForZeroByteFiles() async throws {
        var pending: [CheckedContinuation<String, any Error>] = []
        let uploads = AttachmentModel(upload: { _, _ in
            try await withCheckedThrowingContinuation { pending.append($0) }
        })
        defer { uploads.teardown() }
        uploads.addFiles([.init(name: "a", data: Data(repeating: 1, count: 37)),
                          .init(name: "b", data: Data(repeating: 1, count: 63)),
                          .init(name: "empty", data: Data())])
        try await eventually { pending.count == 1 }
        pending[0].resume(returning: "/a")
        try await eventually { pending.count == 2 }
        #expect(uploads.progressPercent == 37)
        pending[1].resume(returning: "/b")
        try await eventually { pending.count == 3 }
        #expect(uploads.progressPercent == 99 && uploads.hasOutstandingUploads)
        pending[2].resume(returning: "/empty")
        try await eventually { !uploads.hasOutstandingUploads }
        #expect(uploads.progressPercent == 100)
    }

    @Test func chooserDropAndPasteInputsShareTheFileQueue() async throws {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("compose-\(UUID()).txt")
        try Data("file bytes".utf8).write(to: url)
        defer { try? FileManager.default.removeItem(at: url) }
        var received: [(String, Data)] = []
        let uploads = AttachmentModel(upload: { data, name in
            received.append((name, data))
            return "/staged/" + name
        })
        defer { uploads.teardown() }
        uploads.addFiles([url, URL(string: "https://example.test/ignored")!])
        try await eventually { !uploads.hasOutstandingUploads }
        #expect(received.count == 1 && received[0].0 == url.lastPathComponent)
        #expect(received[0].1 == Data("file bytes".utf8))

        let provider = NSItemProvider()
        provider.suggestedName = "screenshot"
        provider.registerDataRepresentation(forTypeIdentifier: "public.png", visibility: .all) { completion in
            completion(Data([137, 80, 78, 71]), nil)
            return nil
        }
        uploads.paste([provider])
        #expect(uploads.hasOutstandingUploads && uploads.pendingImports == 1)
        try await eventually { !uploads.hasOutstandingUploads }
        #expect(received.count == 2 && received[1].0 == "screenshot.png")
        #expect(received[1].1 == Data([137, 80, 78, 71]))

        let fileProvider = NSItemProvider()
        fileProvider.registerDataRepresentation(forTypeIdentifier: "public.file-url", visibility: .all) { completion in
            completion(url.dataRepresentation, nil)
            return nil
        }
        fileProvider.registerDataRepresentation(forTypeIdentifier: "public.png", visibility: .all) { completion in
            completion(Data([0]), nil)
            return nil
        }
        uploads.paste([fileProvider])
        try await eventually { !uploads.hasOutstandingUploads }
        #expect(received.count == 3 && received[2].0 == url.lastPathComponent)
        #expect(received[2].1 == Data("file bytes".utf8))
    }

    @Test func unreadableFilesStayRetryableAndLatePasteCannotResurrectClosedComposer() async throws {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("compose-\(UUID()).txt")
        defer { try? FileManager.default.removeItem(at: url) }
        let uploads = AttachmentModel(upload: { _, _ in "/staged/recovered" })
        uploads.addFiles([url])
        try await eventually { uploads.rows.first?.error != nil }
        let id = try #require(uploads.rows.first?.id)
        #expect(uploads.hasOutstandingUploads)
        try Data("recovered".utf8).write(to: url)
        uploads.retry(id)
        try await eventually { !uploads.hasOutstandingUploads }
        #expect(uploads.rows.first?.path == "/staged/recovered")
        let generation = try #require(uploads.beginImport())
        uploads.teardown()
        uploads.finishImport(.init(name: "late", data: Data()), error: nil, generation: generation)
        #expect(uploads.rows.isEmpty && !uploads.hasOutstandingUploads)
    }

    @Test func modeIsDerivedWithResearchThenEpicThenPlainPrecedence() {
        let m = Self.composer()
        defer { m.teardown() }
        for research in [false, true] {
            for epic in [false, true] {
                for plain in [false, true] {
                    m.research = research; m.epicAuthoring = epic; m.plain = plain
                    #expect(m.mode == (research ? .research : epic ? .epic : plain ? .plain : .code))
                    #expect(m.modeLocked == (research || epic || plain))
                    #expect(m.sandboxLocked == (research || epic))
                    #expect(m.shapingOffered == !(research || epic || plain))
                }
            }
        }
    }

    @Test(arguments: ComposeMode.allCases)
    func modeSelectionPinsGuardsAndResetsOnlyAnIncompatibleSandbox(_ next: ComposeMode) {
        let m = Self.composer()
        defer { m.teardown() }
        m.planGateEnabled = true; m.autopilotEnabled = true
        m.sandboxProfile = .autonomous
        m.setMode(next)
        #expect(m.mode == next && m.modeTouched)
        #expect(m.research == (next == .research))
        #expect(m.epicAuthoring == (next == .epic))
        #expect(m.plain == (next == .plain))
        #expect(m.planGateEnabled == (next == .code))
        #expect(m.autopilotEnabled == (next == .code))
        #expect(m.planGateTouched == (next != .code))
        #expect(m.autopilotTouched == (next != .code))
        #expect(m.sandboxProfile == (next == .research || next == .epic ? nil : .autonomous))
    }

    @Test(arguments: [ComposeMode.research, .epic, .plain])
    func returningToCodeNeverRestoresGuards(_ nonCode: ComposeMode) {
        let m = Self.composer()
        defer { m.teardown() }
        m.planGateEnabled = true; m.autopilotEnabled = true
        m.setMode(nonCode); m.setMode(.code)
        #expect(!m.planGateEnabled && m.planGateTouched)
        #expect(!m.autopilotEnabled && m.autopilotTouched)
        #expect(m.mode == .code && m.shapingOffered)
    }

    @Test(arguments: ["/design", "  /design layout", "\n\t/design\nlayout"])
    func designPreselectionFollowsThePromptWithoutTouchingGuards(_ prompt: String) {
        let m = Self.composer()
        defer { m.teardown() }
        m.planGateEnabled = true; m.autopilotEnabled = true
        m.autopilotTouched = true
        m.sandboxProfile = .autonomous
        m.prompt = prompt
        #expect(m.mode == .plain && !m.modeTouched)
        #expect(m.planGateEnabled && !m.planGateTouched)
        #expect(m.autopilotEnabled && m.autopilotTouched)
        #expect(m.sandboxProfile == .autonomous)
        m.prompt = "design a screen"
        #expect(m.mode == .code)
        #expect(m.planGateEnabled && !m.planGateTouched)
        #expect(m.autopilotEnabled && m.autopilotTouched)
    }

    @Test(arguments: ["/designer", "/design-system", "/design/layout", "fix /design", "/Design", ""])
    func designPreselectionRequiresAnExactLeadingCommand(_ prompt: String) {
        let m = Self.composer()
        defer { m.teardown() }
        m.prompt = prompt
        #expect(m.mode == .code && !m.modeTouched)
    }

    @Test(arguments: ComposeMode.allCases)
    func anExplicitModeChoicePermanentlyOverridesDesignPreselection(_ selected: ComposeMode) {
        let m = Self.composer()
        defer { m.teardown() }
        m.prompt = "/design layout"
        #expect(m.mode == .plain)
        m.setMode(selected)
        m.prompt = "ordinary prompt"
        #expect(m.mode == selected)
        m.prompt = "/design something else"
        #expect(m.mode == selected && m.modeTouched)
    }

    @Test func designDoesNotOverrideOtherFlagsOrClearAnUnrelatedPlainFlag() {
        let m = Self.composer()
        defer { m.teardown() }
        m.research = true; m.prompt = "/design layout"
        #expect(m.research && !m.plain)
        m.research = false; m.epicAuthoring = true; m.prompt = "/design epic"
        #expect(m.epicAuthoring && !m.plain)
        m.epicAuthoring = false; m.plain = true; m.prompt = "ordinary prompt"
        #expect(m.plain)
    }

    @Test func guardExplanationUsesTheExistingPerModeCopy() {
        let m = Self.composer()
        defer { m.teardown() }
        #expect(m.guardExplanation == nil)
        m.setMode(.research); #expect(m.guardExplanation == L.t("newtask_guards_none_research"))
        m.setMode(.epic); #expect(m.guardExplanation == L.t("newtask_guards_none_epic"))
        m.setMode(.plain); #expect(m.guardExplanation == L.t("newtask_guards_none_plain"))
        m.setMode(.code); #expect(m.guardExplanation == nil)
    }

    private func model(
        branches: @escaping (String) async throws -> BranchListing = { _ in .init(branches: []) },
        status: @escaping (String, String) async throws -> BranchStatus = { _, _ in
            .init(behind: 0, ahead: 0, diverged: false, hasUpstream: false, localExists: false)
        },
        repair: @escaping (String, String) async throws -> InitEmptyCommitResponse = { _, branch in .init(branch: branch) },
        sleep: @escaping (Duration) async throws -> Void = { _ in }
    ) -> RepoBranchModel {
        RepoBranchModel(loadBranches: branches, loadStatus: status, repair: repair, debounce: sleep)
    }

    private func eventually(_ predicate: () -> Bool) async throws {
        let deadline = ContinuousClock.now + .seconds(3)
        while !predicate(), ContinuousClock.now < deadline { try await Task.sleep(for: .milliseconds(1)) }
        #expect(predicate())
    }

    @Test func baseChoiceUsesExactWebFallbackOrder() {
        #expect(RepoBranchModel.pickBaseBranch(.init(branches: ["recent"], current: "checkout", _default: "trunk")) == "trunk")
        #expect(RepoBranchModel.pickBaseBranch(.init(branches: ["recent"], current: "checkout")) == "checkout")
        #expect(RepoBranchModel.pickBaseBranch(.init(branches: ["recent"])) == "recent")
        #expect(RepoBranchModel.pickBaseBranch(.init(branches: [])) == "main")
        #expect(RepoBranchModel.pickBaseBranch(.init(branches: ["recent"], current: "", _default: "")) == "")
    }

    @Test func missingBaseRequiresAllFourTerms() async throws {
        for hasBranches in [false, true] {
            for local in [false, true] {
                for upstream in [false, true] {
                    let m = model(branches: { _ in .init(branches: hasBranches ? ["main"] : []) }, status: { _, _ in
                        .init(behind: 0, ahead: 0, diverged: false, hasUpstream: upstream, localExists: local)
                    })
                    #expect(!m.baseMissing)
                    m.selectRepo("/repo")
                    try await eventually { m.upstream != nil }
                    #expect(m.baseMissing == (!hasBranches && !local && !upstream))
                    m.teardown()
                }
            }
        }
    }

    @Test func statusDebounces300msAndDropsLateAnswersEvenAfterReturningToSameBranch() async throws {
        var delays: [Duration] = []
        var sleeps: [CheckedContinuation<Void, Never>] = []
        var statuses: [CheckedContinuation<BranchStatus, Never>] = []
        let m = model(status: { _, _ in await withCheckedContinuation { statuses.append($0) } }, sleep: { duration in
            delays.append(duration)
            await withCheckedContinuation { sleeps.append($0) }
        })
        m.selectRepo("/repo")
        try await eventually { sleeps.count == 1 }
        #expect(delays == [.milliseconds(300)])
        #expect(statuses.isEmpty)
        sleeps[0].resume()
        try await eventually { statuses.count == 1 }
        m.baseBranch = "other"
        try await eventually { sleeps.count == 2 }
        m.baseBranch = "main"
        try await eventually { sleeps.count == 3 }
        sleeps[1].resume(); sleeps[2].resume()
        try await eventually { statuses.count == 2 }
        statuses[1].resume(returning: .init(behind: 2, ahead: 0, diverged: false, hasUpstream: true, localExists: true))
        try await eventually { m.upstream?.behind == 2 }
        statuses[0].resume(returning: .init(behind: 99, ahead: 0, diverged: false, hasUpstream: true, localExists: true))
        // Let the resumed, cancelled task run before observing its guarded write.
        for _ in 0..<20 { await Task.yield() }
        #expect(m.upstream?.behind == 2)
        m.teardown()
    }

    @Test func lateRepoListingAndFailureCannotReplaceCurrentSelection() async throws {
        var pending: CheckedContinuation<BranchListing, any Error>?
        let m = model(branches: { repo in
            if repo == "/slow" { return try await withCheckedThrowingContinuation { pending = $0 } }
            return .init(branches: ["trunk"], _default: "origin-default")
        })
        m.selectRepo("/slow")
        try await eventually { pending != nil }
        m.selectRepo("/fast")
        try await eventually { m.baseBranch == "origin-default" }
        #expect(m.baseOptions == ["origin-default", "trunk"])
        pending?.resume(throwing: ShepherdError.badRequest("late"))
        for _ in 0..<20 { await Task.yield() }
        #expect(m.branches == ["trunk"])
        #expect(m.error == nil)
        m.teardown()
    }

    @Test func repairInvalidatesPreRepairStatusAndRefreshesBranches() async throws {
        var oldStatus: CheckedContinuation<BranchStatus, Never>?
        var repaired = false
        var repairs = 0
        let m = model(branches: { _ in .init(branches: repaired ? ["main"] : []) }, status: { _, _ in
            if !repaired { return await withCheckedContinuation { oldStatus = $0 } }
            return .init(behind: 0, ahead: 0, diverged: false, hasUpstream: false, localExists: true)
        }, repair: { _, branch in repairs += 1; repaired = true; return .init(branch: branch) })
        m.selectRepo("/repo")
        try await eventually { oldStatus != nil }
        await m.repairInitialCommit()
        #expect(repairs == 1)
        #expect(m.branches == ["main"])
        #expect(m.upstream?.localExists == true)
        oldStatus?.resume(returning: .init(behind: 0, ahead: 0, diverged: false, hasUpstream: false, localExists: false))
        for _ in 0..<20 { await Task.yield() }
        #expect(!m.baseMissing)
        #expect(m.upstream?.localExists == true)
        #expect(!m.repairingBase)
        m.teardown()
    }

    @Test func repairRejectsDuplicatesAndLateCompletionAfterRepoChange() async throws {
        var pending: CheckedContinuation<InitEmptyCommitResponse, Never>?
        var calls = 0
        let m = model(repair: { _, _ in calls += 1; return await withCheckedContinuation { pending = $0 } })
        m.selectRepo("/a")
        let first = Task { await m.repairInitialCommit() }
        try await eventually { pending != nil }
        await m.repairInitialCommit()
        #expect(calls == 1)
        m.selectRepo("/b")
        pending?.resume(returning: .init(branch: "stale"))
        await first.value
        #expect(m.repoPath == "/b" && m.baseBranch == "main")
        #expect(!m.repairingBase)
        m.teardown()
    }

    @Test func repairFailureCanBeRetriedAndTeardownDropsLateWork() async throws {
        var calls = 0
        let m = model(repair: { _, branch in
            calls += 1
            if calls == 1 { throw ShepherdError.unprocessable("failed") }
            return .init(branch: branch)
        })
        m.selectRepo("/repo")
        await m.repairInitialCommit()
        #expect(m.error != nil && !m.repairingBase)
        await m.repairInitialCommit()
        #expect(calls == 2 && m.error == nil)
        m.teardown()
        #expect(!m.upstreamLoading)
        #expect(!m.loadingBranches)
    }

    @Test func missingBaseRepairFailureKeepsTheRetryActionAvailable() async throws {
        let m = model(repair: { _, _ in throw ShepherdError.unprocessable("failed") })
        m.selectRepo("/repo")
        try await eventually { m.baseMissing }
        await m.repairInitialCommit()
        #expect(m.baseMissing && m.error != nil && !m.repairingBase)
        m.teardown()
    }

    @Test func teardownFencesLateStatusAndRepairResults() async throws {
        var status: CheckedContinuation<BranchStatus, Never>?
        var repair: CheckedContinuation<InitEmptyCommitResponse, Never>?
        let m = model(status: { _, _ in await withCheckedContinuation { status = $0 } },
                      repair: { _, _ in await withCheckedContinuation { repair = $0 } })
        m.selectRepo("/repo")
        try await eventually { status != nil }
        let task = Task { await m.repairInitialCommit() }
        try await eventually { repair != nil }
        m.teardown()
        status?.resume(returning: .init(behind: 99, ahead: 0, diverged: false, hasUpstream: true, localExists: true))
        repair?.resume(returning: .init(branch: "late"))
        await task.value
        for _ in 0..<20 { await Task.yield() }
        #expect(m.upstream == nil && m.baseBranch == "main")
        #expect(!m.repairingBase && !m.upstreamLoading)
    }

    @Test func lateListingDoesNotOverwriteTypedBaseAndUnknownStatusIsNotMissing() async throws {
        var listing: CheckedContinuation<BranchListing, Never>?
        let m = model(branches: { _ in await withCheckedContinuation { listing = $0 } },
                      status: { _, _ in throw ShepherdError.transport("offline") })
        m.selectRepo("/repo")
        try await eventually { listing != nil }
        m.baseBranch = "typed"
        listing?.resume(returning: .init(branches: [], _default: "trunk"))
        try await eventually { !m.loadingBranches && !m.upstreamLoading }
        #expect(m.baseBranch == "typed" && !m.baseMissing && m.upstream == nil)
        m.teardown()
    }

    @Test func repoActionsWrapAndExcludeHiddenRepos() {
        func repo(_ path: String, hidden: Bool = false) -> Repo {
            .init(name: path, path: path, display: path, realPath: path, isFork: false, hidden: hidden)
        }
        let prefs = UserDefaults(suiteName: "ComposeModelTests.\(UUID())")!
        let m = ComposeModel(defaults: prefs, repoBranches: model(), loadIssues: { _ in .init(issues: []) },
                             loadCommands: { _, _ in .init(commands: []) }, loadEpics: { _ in .init(epics: [], subIssues: []) })
        let repos = [repo("/a"), repo("/hidden", hidden: true), repo("/b")]
        m.cycleRepo(1, repos: repos); #expect(m.repoPath == "/a")
        m.cycleRepo(-1, repos: repos); #expect(m.repoPath == "/b")
        m.cycleRepo(1, repos: repos); #expect(m.repoPath == "/a")
        m.openRepoPicker(); #expect(m.repoBranches.presentedPicker == .repo)
        m.openBranchPicker(); #expect(m.repoBranches.presentedPicker == .branch)
        m.teardown()
    }
}

@MainActor @Suite struct ComposeCapacityTests {
    private func limits(_ fields: String = "") throws -> UsageLimits {
        try JSONDecoder().decode(UsageLimits.self, from: Data("""
        {"perModelWeek":[],"stale":false,"calibratedAt":null,"subscriptionOnly":false\(fields)}
        """.utf8))
    }

    @Test func emptyAndOlderServersKeepBothRowsWithoutInventingCodexCapacity() throws {
        for usage in [nil, try limits()] {
            let rows = ComposeCapacity.rows(usage)
            #expect(rows.map(\.provider) == [.claude, .codex])
            #expect(rows.allSatisfy { $0.windows.isEmpty })
            #expect(ComposeCapacity.selected(usage, provider: .claude) == nil)
            #expect(ComposeCapacity.selected(usage, provider: .codex) == nil)
        }
        let usage = try limits(#", "week":{"pct":7,"resetAt":2000}"#)
        #expect(ComposeCapacity.selected(usage, provider: .claude)?.code == "CC·WK")
        #expect(ComposeCapacity.selected(usage, provider: .codex) == nil)
    }

    @Test func hottestWindowClampsPercentagesAndKeepsFiveHourTieOrder() throws {
        let usage = try limits(#", "session5h":{"pct":-10,"resetAt":1000},"week":{"pct":125,"resetAt":2000}"#)
        let row = ComposeCapacity.rows(usage)[0]
        #expect(row.windows.map(\.usedPct) == [0, 100])
        #expect(row.windows.map(\.remainingPct) == [100, 0])
        let hot = try #require(ComposeCapacity.selected(usage, provider: .claude))
        #expect(hot.code == "CC·WK" && hot.window.resetAt == 2000)
        let tied = try limits(#", "session5h":{"pct":50,"resetAt":1000},"week":{"pct":50,"resetAt":2000}"#)
        #expect(ComposeCapacity.selected(tied, provider: .claude)?.code == "CC·5H")
    }

    @Test func observedWinsAsAWholeIncludingEmptyAndPartialObservations() throws {
        let local = #", "session5h":{"pct":99,"resetAt":1000},"week":{"pct":98,"resetAt":2000}"#
        let usage = try limits(local + #", "observed":{"week":{"pct":7,"resetAt":3000,"scrapedAt":1}}"#)
        let hot = try #require(ComposeCapacity.selected(usage, provider: .claude))
        #expect(hot.code == "CC·WK" && hot.window.remainingPct == 93 && hot.window.resetAt == 3000)
        #expect(ComposeCapacity.rows(usage)[0].windows.count == 1)
        #expect(ComposeCapacity.selected(try limits(local + #", "observed":{}"#), provider: .claude) == nil)
    }

    @Test func claudeSnapshotObservationIsFallbackButTopLevelObservationWins() throws {
        let provider = #", "providers":[{"provider":"claude","kind":"limits","perModelWeek":[],"stale":false,"calibratedAt":null,"subscriptionOnly":false,"observed":{"session5h":{"pct":60,"resetAt":1000,"scrapedAt":1}}}]"#
        #expect(ComposeCapacity.selected(try limits(provider), provider: .claude)?.window.usedPct == 60)
        #expect(ComposeCapacity.selected(try limits(provider + #", "observed":{}"#), provider: .claude) == nil)
    }

    @Test func codexUsesOnlyItsTokenSnapshotAndKeepsIndependentStaleness() throws {
        let provider = #", "providers":[{"provider":"codex","kind":"tokens","totalTokens":999,"session5hTokens":10,"weekTokens":20,"updatedAt":null,"stale":true,"session5h":{"pct":2,"resetAt":1000},"week":{"pct":7,"resetAt":2000}}]"#
        let usage = try limits(provider + #", "week":{"pct":98,"resetAt":2000}"#)
        let hot = try #require(ComposeCapacity.selected(usage, provider: .codex))
        #expect(hot.code == "CX·WK" && hot.window.remainingPct == 93 && hot.stale)
        #expect(ComposeCapacity.rows(usage)[1].windows.map(\.key) == ["5H", "WK"])
        #expect(ComposeCapacity.selected(usage, provider: .claude)?.stale == false)
        for changed in [provider.replacingOccurrences(of: "tokens\"", with: "future\""),
                        provider.replacingOccurrences(of: "codex\"", with: "future\"")] {
            #expect(ComposeCapacity.selected(try limits(changed), provider: .codex) == nil)
        }
        let tokensOnly = try limits(#", "providers":[{"provider":"codex","kind":"tokens","totalTokens":999,"session5hTokens":10,"weekTokens":20,"updatedAt":null,"stale":false}]"#)
        #expect(ComposeCapacity.selected(tokensOnly, provider: .codex) == nil)
    }

    @Test func staleClaudeObservationsStillDimTheLine() throws {
        let usage = try limits(#", "observed":{"week":{"pct":7,"resetAt":2000,"scrapedAt":1}}"#)
        var stale = usage
        stale.stale = true
        for (value, opacity) in [(usage, 1.0), (stale, 0.55)] {
            let line = CapacityLine(provider: .claude, usageLimits: { value })
            #expect(capacityElements(_OpacityEffect.self, in: line.body).map(\.opacity) == [opacity])
            #expect(capacityElements(_OpacityEffect.self, in: line.allWindows).map(\.opacity) == [opacity, 1],
                    "The popover must dim Claude independently of Codex, including unavailable rows")
        }
    }

    @Test func severityBoundariesUseUsedCapacity() throws {
        for (used, expected) in [(0.0, Color.secondary), (50, .secondary), (50.01, .orange),
                                 (90, .orange), (90.01, .red), (100, .red)] {
            let usage = try limits(", \"week\":{\"pct\":\(used),\"resetAt\":0}")
            let line = CapacityLine(provider: .claude, usageLimits: { usage })
            try expectCapacityTint(expected, in: line.body)
            try expectCapacityTint(expected, in: line.allWindows)
        }
    }

    @Test func reconnectRereadRendersFivePercentFreeAfterAnOlderSevenPercentPush() async throws {
        let suite = "ComposeCapacityTests.\(UUID())"
        let defaults = try #require(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let app = AppModel(defaults: defaults, credentials: InMemoryCredentialStore())
        let store = try SessionStore(
            profile: .init(name: "capacity", baseURL: URL(string: "https://capacity.invalid")!, mode: .remote),
            credentials: InMemoryCredentialStore())
        let sidebar = SidebarModel(store: store, app: app)
        let old = try limits(#", "week":{"pct":7,"resetAt":0}"#)
        let fresh = try limits(#", "week":{"pct":95,"resetAt":0}"#)
        // Replace reads before yielding to bootstrap; the store is never started.
        sidebar.reads = SidebarReads(workingBlocked: { [:] }, holds: { [:] }, blocks: { [:] },
                                     usage: { .init(limits: old, projections: []) })
        defer { sidebar.teardown(); app.teardown() }
        func settle(_ predicate: () -> Bool) async throws {
            let deadline = ContinuousClock.now + .seconds(3)
            while !predicate(), ContinuousClock.now < deadline { try await Task.sleep(for: .milliseconds(1)) }
            try #require(predicate())
        }
        try await settle { sidebar.usage != nil }
        let connection = ConnectionBox()
        var observed: ConnectionState?
        sidebar.watchConnection { observed = connection.state; return connection.state }
        try await settle { observed == .idle }
        connection.state = .live
        try await settle { observed == .live }
        store.apply(.usageLimits(old))

        // Exercise the default cross-stream reader without keeping process-wide test state
        // installed across an await (other seam suites can run while this test suspends).
        func throughSeam<T>(_ read: () throws -> T) rethrows -> T {
            let previous = SessionSignals.usageLimits
            SessionSignals.usageLimits = { sidebar.limits }
            defer { SessionSignals.usageLimits = previous }
            return try read()
        }
        let line = throughSeam { CapacityLine(provider: .claude) }
        let initial = try throughSeam { try #require(line.state.selected) }
        #expect(initial.window.remainingPct == 93)
        connection.state = .offline(message: "disconnected")
        try await settle { observed == connection.state }
        sidebar.reads.usage = { .init(limits: fresh, projections: []) }
        connection.state = .live
        try await settle { sidebar.usage?.limits.week?.pct == 95 }

        let reconciled = try throughSeam { try #require(line.state.selected) }
        #expect(reconciled.code == "CC·WK")
        #expect(reconciled.window.remainingPct == 5)
        #expect(reconciled.window.freeCopy == L.t("newtask_provider_capacity_free", "5"))
        #expect(reconciled.window.tint == .red)
        store.apply(.usageLimits(old))
        #expect(try throughSeam { try #require(line.state.selected) }.window.remainingPct == 93)
    }

    @Test func engineBindingHonorsCommandConstraintAndUnlocksWhenRemoved() {
        let model = ComposeModelTests.composer()
        defer { model.teardown() }
        let picker = EnginePicker(model: model)
        model.selectProviderManually(.claude)
        #expect(picker.selection.wrappedValue == .claude)
        picker.selection.wrappedValue = .codex
        #expect(model.provider == .codex)
        #expect(picker.selection.wrappedValue == .codex)
        picker.selection.wrappedValue = .claude
        #expect(model.provider == .claude)
        model.pickCommand(.init(name: "ship", description: "Ship", scope: .init(known: .project), providers: [.claude]))
        picker.selection.wrappedValue = .codex
        #expect(model.provider == .claude)
        model.prompt = "new task"
        #expect(model.allowsProvider(.codex))
        model.selectProviderManually(.claude)
        #expect(model.provider == .claude)
        picker.selection.wrappedValue = .codex
        #expect(model.provider == .codex)
    }
}

/// Walk the actual SwiftUI value tree, expanding ForEach's rendered content instead
/// of inspecting its input models. Keep SDK reflection confined to this test helper.
@MainActor private protocol CapacityForEachContent {
    var capacityChildren: [Any] { get }
}

extension ForEach: CapacityForEachContent where Content: View {
    fileprivate var capacityChildren: [Any] { data.map { content($0) } }
}

@MainActor private func capacityElements<Element>(
    _ type: Element.Type, in value: Any, depth: Int = 0
) -> [Element] {
    if let element = value as? Element { return [element] }
    guard depth < 40 else { return [] }
    if let repeated = value as? any CapacityForEachContent {
        return repeated.capacityChildren.flatMap { capacityElements(type, in: $0, depth: depth + 1) }
    }
    let mirror = Mirror(reflecting: value)
    // Do not enter reference graphs (state, environment storage, color providers).
    guard mirror.displayStyle != .class else { return [] }
    return mirror.children.flatMap { capacityElements(type, in: $0.value, depth: depth + 1) }
}

@MainActor private func expectCapacityTint(_ expected: Color, in view: some View) throws {
    // Derive the tint environment key from SwiftUI itself, not a private key name.
    let reference = capacityElements(_EnvironmentKeyWritingModifier<AnyShapeStyle?>.self,
                                     in: EmptyView().tint(Color.red))
    let key = try #require(reference.first?.keyPath)
    let modifiers = capacityElements(_EnvironmentKeyWritingModifier<AnyShapeStyle?>.self, in: view)
        .filter { $0.keyPath == key }
    #expect(modifiers.count == 1, "The rendered meter must apply exactly one tint")
    let style = try #require(modifiers.first?.value)
    // AnyShapeStyle type-erases Color, but its storage retains SwiftUI's equality.
    // Require that representation explicitly so SDK changes fail visibly.
    let actual = try #require(Mirror(reflecting: style).descendant("storage") as? any Equatable)
    let wanted = try #require(Mirror(reflecting: AnyShapeStyle(expected)).descendant("storage"))
    func equals<T: Equatable>(_ value: T, _ other: Any) -> Bool { value == other as? T }
    let matches = equals(actual, wanted)
    #expect(matches, "The rendered tint must match the severity color")
}

/// Uploads reject a credential; every secondary exchange fails offline.
final class ComposeUploadProtocol: URLProtocol {
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        guard request.url?.path == "/api/uploads" else {
            Issue.record("Upload attempted a secondary request")
            client?.urlProtocol(self, didFailWithError: URLError(.notConnectedToInternet))
            return
        }
        #expect(request.value(forHTTPHeaderField: "Authorization") == "Bearer rejected-token")
        let response = HTTPURLResponse(url: request.url!, statusCode: 401, httpVersion: nil,
                                       headerFields: ["Content-Type": "application/json"])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(#"{"error":"unauthorized"}"#.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}

/// In-memory HTTP fixture: opening before bootstrap must exercise the sheet's actual onChange.
private final class ComposeBootstrapProtocol: URLProtocol {
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        let body: String
        switch request.url?.path {
        case "/api/settings":
            body = #"{"repoRoot":"/repo","repoRootDisplay":"repo","firstRunPending":false,"defaultModel":"opus","defaultCodexModel":"gpt-6-astra","defaultEffort":"ultra","defaultAgentProvider":"codex","authMode":"subscription","operatorLanguage":"en"}"#
        case "/api/repos":
            body = #"{"recentWindowDays":7,"repos":[{"name":"shepherd","path":"/repo","display":"shepherd","realPath":"/repo","isFork":false,"hidden":false}]}"#
        case "/api/sessions": body = "[]"
        default: body = "{}"
        }
        guard let url = request.url, let response = HTTPURLResponse(url: url, statusCode: 200,
            httpVersion: nil, headerFields: ["Content-Type": "application/json"]) else { return }
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(body.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}
