import Foundation
import ShepherdKit
import Testing
@testable import Shepherd

@MainActor @Suite struct ComposeModelTests {
    static func composer(attachments: AttachmentModel? = nil) -> ComposeModel {
        ComposeModel(defaults: UserDefaults(suiteName: "ComposeModeTests.\(UUID())")!,
                     repoBranches: RepoBranchModel(
                        loadBranches: { _ in .init(branches: []) },
                        loadStatus: { _, _ in .init(behind: 0, ahead: 0, diverged: false, hasUpstream: false, localExists: false) },
                        repair: { _, branch in .init(branch: branch) }),
                     loadIssues: { _ in .init(issues: []) }, loadCommands: { _, _ in .init(commands: []) },
                     loadEpics: { _ in .init(epics: [], subIssues: []) }, attachments: attachments)
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

    @Test func uploadAdapterUsesTaskBytesAndGeneratedResponse() async throws {
        let credentials = InMemoryCredentialStore()
        try credentials.save(.init(token: "test-token", tokenId: "test"), for: "upload-test")
        let client = try ShepherdClient(profile: .init(name: "test", baseURL: URL(string: "http://localhost/prefix/")!,
                                                       mode: .local, credentialKey: "upload-test"), credentials: credentials)
        let sent = Box(0)
        let path = try await AttachmentTransfer.upload(client: client, data: Data(repeating: 1, count: 100),
                                                       name: "a\"\r\n.txt", progress: { bytes in
            await MainActor.run { sent.value = bytes }
        }, send: { request, body, delegate in
            #expect(request.url?.path == "/prefix/api/uploads")
            #expect(request.url?.query == nil)
            #expect(request.value(forHTTPHeaderField: "Authorization") == "Bearer test-token")
            let wire = String(decoding: body, as: UTF8.self)
            #expect(wire.contains("filename=\"a%22%0D%0A.txt\""))
            let task = URLSession.shared.dataTask(with: request)
            delegate.urlSession(.shared, task: task, didSendBodyData: 25,
                                totalBytesSent: Int64(delegate.headerBytes + 25), totalBytesExpectedToSend: Int64(body.count))
            return (Data(#"{"path":"/staged/test"}"#.utf8),
                    HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!)
        })
        #expect(path == "/staged/test")
        try await eventually { sent.value == 25 }
    }

    @Test(arguments: [400, 401, 404, 413, 503])
    func uploadAdapterMapsDeclaredErrors(_ status: Int) async throws {
        let client = try ShepherdClient(profile: .init(name: "test", baseURL: URL(string: "http://localhost/")!,
                                                       mode: .local), credentials: InMemoryCredentialStore())
        do {
            _ = try await AttachmentTransfer.upload(client: client, data: Data(), name: "empty", progress: { _ in },
                                                    send: { request, _, _ in
                (Data(#"{"error":"bad"}"#.utf8),
                 HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: nil)!)
            })
            Issue.record("Expected upload failure")
        } catch let error as ComposeUploadError {
            #expect(status == 413 && error == .fileTooLarge("bad"))
        } catch let error as ShepherdError {
            let expected: ShepherdError = status == 400 ? .badRequest("bad") : status == 401 ? .unauthenticated
                : status == 404 ? .notFound : .fromUndocumented(statusCode: status, route: "uploadFile")
            #expect(error == expected)
        }
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
        #expect(ComposeCapacity.selected(stale, provider: .claude)?.stale == true)
    }

    @Test func severityBoundariesUseUsedCapacity() {
        for (used, expected) in [(0.0, ComposeCapacity.Tone.muted), (50, .muted), (50.01, .amber),
                                 (90, .amber), (90.01, .red), (100, .red)] {
            #expect(ComposeCapacity.Window(key: "WK", pct: used, resetAt: 0).tone == expected)
        }
    }

    @Test func engineBindingHonorsCommandConstraintAndUnlocksWhenRemoved() {
        let model = ComposeModelTests.composer()
        let picker = EnginePicker(model: model)
        picker.selection.wrappedValue = .codex
        #expect(model.provider == .codex)
        model.pickCommand(.init(name: "ship", description: "Ship", scope: .init(known: .project), providers: [.claude]))
        picker.selection.wrappedValue = .codex
        #expect(model.provider == .claude)
        model.prompt = "new task"
        picker.selection.wrappedValue = .codex
        #expect(model.provider == .codex)
    }
}
