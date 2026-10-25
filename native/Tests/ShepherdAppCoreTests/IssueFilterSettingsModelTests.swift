import Foundation
import ShepherdKit
import Testing
@testable import ShepherdAppCore

private actor PatchLatch {
    private(set) var patches: [IssueFilterPatch] = []
    private var pending: [CheckedContinuation<IssueFilterSettings?, any Error>] = []
    var waiting: Int { pending.count }
    func write(_ patch: IssueFilterPatch) async throws -> IssueFilterSettings? {
        patches.append(patch)
        return try await withCheckedThrowingContinuation { pending.append($0) }
    }
    func succeed(_ value: IssueFilterSettings?) { pending.removeFirst().resume(returning: value) }
    func fail() { pending.removeFirst().resume(throwing: ShepherdError.notFound) }
}

extension CoreSeamTests {
@Suite(.serialized) @MainActor struct IssueFilterSettingsModelTests {
    private let wire = #"{"scope":"mine","forks":"own","hiddenLabels":["wip"],"hideActive":true,"hideSubIssues":false,"hideBlocked":true,"repoOverrides":{"/real/a":"hide","/real/b":"mine_unassigned"}}"#

    private func repo(_ path: String, real: String, fork: Bool = false) throws -> Repo {
        try JSONDecoder().decode(Repo.self, from: Data(
            #"{"name":"r","path":"\#(path)","display":"r","realPath":"\#(real)","isFork":\#(fork),"hidden":false}"#.utf8))
    }

    @Test func generatedValueRoundTripsThroughTheMirror() throws {
        let generated = try JSONDecoder().decode(Components.Schemas.IssueFilterSettings.self, from: Data(wire.utf8))
        let mirror = try IssueFilterSettings.bridged(generated)
        #expect(mirror == IssueFilterSettings(scope: .mine, forks: .own, hiddenLabels: ["wip"], hideActive: true,
            hideSubIssues: false, hideBlocked: true, repoOverrides: ["/real/a": .hide, "/real/b": .mineUnassigned]))
        let again = try JSONDecoder().decode(IssueFilterSettings.self, from: JSONEncoder().encode(mirror))
        #expect(again == mirror)
        let back = try JSONDecoder().decode(Components.Schemas.IssueFilterSettings.self, from: JSONEncoder().encode(mirror))
        #expect(try IssueFilterSettings.bridged(back) == mirror)
    }

    @Test func unknownWireValuesFailOpen() throws {
        let raw = #"{"scope":"team","forks":"later","hiddenLabels":[],"hideActive":false,"hideSubIssues":true,"hideBlocked":true,"repoOverrides":{"/a":"someday","/b":"all"}}"#
        let value = try JSONDecoder().decode(IssueFilterSettings.self, from: Data(raw.utf8))
        #expect(value.scope == .all)
        #expect(value.forks == .all)
        #expect(value.repoOverrides == ["/b": .all])
    }

    @Test func patchCarriesOnlyChangedFieldsAndDecodesAsTheGeneratedBody() throws {
        var next = IssueFilterSettings.defaults
        next.forks = .hide; next.repoOverrides = ["/r": .mine]
        let patch = next.patch(from: .defaults)
        #expect(patch == IssueFilterPatch(forks: .hide, repoOverrides: ["/r": .mine]))
        let json = try JSONSerialization.jsonObject(with: JSONEncoder().encode(patch)) as? [String: Any]
        #expect(Set(json?.keys.map { $0 } ?? []) == ["forks", "repoOverrides"])
        _ = try patch.generated()
        #expect(IssueFilterSettings.defaults.applying(patch) == next)
        #expect(IssueFilterSettings.defaults.patch(from: .defaults).isEmpty)
    }

    @Test func loadThenOptimisticWriteSettlesOnTheServerValue() async throws {
        let latch = PatchLatch()
        let server = IssueFilterSettings(scope: .all)
        let model = IssueFilterSettingsModel(reads: .init(read: { server }, write: { try await latch.write($0) }))
        defer { model.teardown() }
        #expect(model.value == nil)
        #expect(model.update(.init(scope: .mine)) == nil)
        await model.load()
        #expect(model.value == server)
        let write = model.update(.init(forks: .hide))
        #expect(model.value?.forks == .hide)
        while await latch.waiting == 0 { await Task.yield() }
        var merged = server; merged.forks = .hide; merged.hiddenLabels = ["normalized"]
        await latch.succeed(merged)
        await write?.value
        #expect(model.value == merged)
        #expect(await latch.patches == [.init(forks: .hide)])
    }

    @Test func failedWriteRevertsToTheConfirmedValue() async {
        let latch = PatchLatch()
        let model = IssueFilterSettingsModel(reads: .init(read: { nil }, write: { try await latch.write($0) }),
                                             initial: .defaults)
        defer { model.teardown() }
        let write = model.update(.init(hiddenLabels: ["x"]))
        #expect(model.value?.hiddenLabels == ["x"])
        while await latch.waiting == 0 { await Task.yield() }
        await latch.fail()
        await write?.value
        #expect(model.value == .defaults)
        #expect(model.error != nil)
    }

    @Test func supersededWriteLeavesTheOutcomeToTheLatest() async {
        let latch = PatchLatch()
        let model = IssueFilterSettingsModel(reads: .init(read: { nil }, write: { try await latch.write($0) }),
                                             initial: .defaults)
        defer { model.teardown() }
        let first = model.update(.init(scope: .all))
        while await latch.waiting == 0 { await Task.yield() }
        let second = model.update(.init(forks: .own))
        while await latch.waiting == 1 { await Task.yield() }
        await latch.fail()
        await first?.value
        #expect(model.value == IssueFilterSettings(scope: .all, forks: .own))
        #expect(model.error == nil)
        await latch.succeed(IssueFilterSettings(scope: .all, forks: .own))
        await second?.value
        #expect(model.value == IssueFilterSettings(scope: .all, forks: .own))
    }

    @Test func pushReplacesTheValue() throws {
        let model = IssueFilterSettingsModel(reads: .init(read: { nil }, write: { _ in nil }), initial: .defaults)
        defer { model.teardown() }
        model.apply(.unknown(name: "settings:issue-filter", payload: Data(#"{"issueFilter":\#(wire)}"#.utf8)))
        #expect(model.value?.scope == .mine)
        #expect(model.value?.repoOverrides["/real/a"] == .hide)
        model.apply(.unknown(name: "upnext:changed", payload: Data(#"{"issueFilter":{}}"#.utf8)))
        #expect(model.value?.scope == .mine)
    }

    @Test func repoContextResolvesEitherPathForm() throws {
        let repos = [try repo("/link/a", real: "/real/a", fork: true), try repo("/real/c", real: "/real/c")]
        let initial = try JSONDecoder().decode(IssueFilterSettings.self, from: Data(wire.utf8))
        let model = IssueFilterSettingsModel(reads: .init(read: { nil }, write: { _ in nil }),
                                             repos: { repos }, initial: initial)
        defer { model.teardown() }
        #expect(model.repoContext(for: "/link/a") == .init(isFork: true, override: .hide))
        #expect(model.repoContext(for: "/real/a") == .init(isFork: true, override: .hide))
        #expect(model.repoContext(for: "/real/c") == .init())
        #expect(model.repoContext(for: "/real/b") == .init(override: .mineUnassigned))
        model.setOverride(.mine, for: repos[1])
        model.setOverride(nil, for: repos[0])
        #expect(model.value?.repoOverrides == ["/real/b": .mineUnassigned, "/real/c": .mine])
    }
}
}
